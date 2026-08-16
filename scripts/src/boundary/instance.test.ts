import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import {
  AtlasIOError,
  AtlasInstance,
  ReasonCode,
  enforceCeiling,
  formatDiagnostics,
  DiagnosticLevel,
  makeReceiptKey,
} from "./instance.ts";
import { parseStrict } from "./canonical-json.ts";
import { SchemaValidator } from "./schema.ts";

// The differential harness proves this module answers what CPython answers.
// What is pinned here is what a comparison of return values cannot see:
// descriptor hygiene, what survives a failure mid-write, the lock's behaviour
// under a second holder, and the one place the port and the oracle disagree.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/atlas-instance-test-");
  fs.mkdirSync(`${root}/atlas`);
  fs.mkdirSync(`${root}/state`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const refusal = (run: () => unknown): AtlasIOError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AtlasIOError) return error;
    throw error;
  }
  throw new Error("expected a refusal, and there was none");
};

const openDescriptors = (): number => fs.readdirSync("/proc/self/fd").length;

const ARTIFACT = {
  id: "artifact:a-note",
  type: "note",
  path: "notes/a.md",
  observed_at: "2026-08-14",
  summary: "a note",
  touches: [],
  supports_state_updates: [],
  evidence_strength: "read",
};

describe("descriptors", () => {
  test("are all given back, on the paths that work and the ones that fail", () => {
    fs.writeFileSync(`${root}/atlas/a.json`, "{}\n");
    fs.symlinkSync("a.json", `${root}/atlas/link.json`);
    const instance = new AtlasInstance(root);
    const before = openDescriptors();

    for (let round = 0; round < 30; round += 1) {
      instance.withLock(() => {
        instance.appendRecord("state/artifacts.jsonl", ARTIFACT);
        instance.appendReceipt(`src/b-${round}#0`, "opened", "2026-08-14");
        instance.receiptStatus();
        instance.preserveBytes(`intake/${round}.json`, new TextEncoder().encode("{}\n"));
        expect(() => instance.preserveBytes("secrets/x.json", new Uint8Array())).toThrow();
        expect(() => instance.appendRecord("state/nope.jsonl", ARTIFACT)).toThrow();
      });
      instance.readJson("atlas/a.json", { maxBytes: 64 });
      expect(() => instance.readJson("atlas/link.json", { maxBytes: 64 })).toThrow();
      expect(() => instance.readJson("atlas/missing.json", { maxBytes: 64 })).toThrow();
    }

    // A leak of one descriptor per round would be 30 by now.
    expect(openDescriptors()).toBe(before);
  });
});

describe("the lock", () => {
  test("cannot be taken twice, and is given back either way", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      expect(refusal(() => instance.withLock(() => 0)).diagnostic.reason).toBe(
        ReasonCode.LockHeld,
      );
    });
    expect(fs.existsSync(`${root}/.atlas-lock`)).toBe(false);

    expect(() => instance.withLock(() => { throw new Error("the body failed"); })).toThrow(
      "the body failed",
    );
    // A body that throws still releases: otherwise one failed run would wedge
    // the instance until somebody deleted the file by hand.
    expect(fs.existsSync(`${root}/.atlas-lock`)).toBe(false);
    instance.withLock(() => 0);
  });

  test("says who holds it and since when, and nothing else", () => {
    // §25.6 names the contents `{pid, started_at}`, and the oracle's own test
    // reads the file back and compares the key set — so the contract is the
    // two keys, not the byte form. Nothing anywhere reads this file's content:
    // the release path compares inodes, and every other reference is to the
    // path. The bytes are this repository's canonical row form (§25.7), which
    // is compact and key-sorted where the oracle's `json.dumps` default is
    // spaced and insertion-ordered; that difference is deliberate and the
    // differential harness excludes the file for an unrelated reason — it
    // carries the writing process's pid, which can never match across two.
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      const held = JSON.parse(fs.readFileSync(`${root}/.atlas-lock`, "utf8"));
      expect(Object.keys(held).sort()).toEqual(["pid", "started_at"]);
      expect(held.pid).toBe(process.pid);
      // Second-resolution UTC, the same shape the oracle's strftime writes.
      expect(held.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  test("keeps a second writer out while it is held", () => {
    const first = new AtlasInstance(root);
    const second = new AtlasInstance(root);
    first.withLock(() => {
      expect(refusal(() => second.withLock(() => 0)).diagnostic.reason).toBe(
        ReasonCode.LockHeld,
      );
    });
    second.withLock(() => 0);
  });

  test("reports the loss when its file is replaced underneath it", () => {
    const instance = new AtlasInstance(root);
    expect(
      refusal(() =>
        instance.withLock(() => {
          fs.unlinkSync(`${root}/.atlas-lock`);
          fs.writeFileSync(`${root}/.atlas-lock`, "someone else\n");
          instance.appendRecord("state/artifacts.jsonl", ARTIFACT);
        }),
      ).diagnostic.reason,
    ).toBe(ReasonCode.LockLost);
    fs.rmSync(`${root}/.atlas-lock`, { force: true });
  });

  test("does not bury the caller's own failure under a release failure", () => {
    const instance = new AtlasInstance(root);
    // Both go wrong at once: the body throws, and the lock file is gone by the
    // time the release looks for it. The body's error is the one that matters.
    expect(() =>
      instance.withLock(() => {
        fs.unlinkSync(`${root}/.atlas-lock`);
        throw new Error("what the caller actually hit");
      }),
    ).toThrow("what the caller actually hit");
  });
});

describe("a durable write", () => {
  test("leaves nothing behind at the canonical path when it fails", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      // A directory where the file belongs. It opens read-only like anything
      // else, so what refuses it is the size check: the canonical path already
      // holds something that is not these bytes, which is a conflict rather
      // than a write that went wrong.
      fs.mkdirSync(`${root}/intake`, { recursive: true });
      fs.mkdirSync(`${root}/intake/a.json`);
      expect(
        refusal(() => instance.preserveBytes("intake/a.json", new TextEncoder().encode("x")))
          .diagnostic.reason,
      ).toBe(ReasonCode.ContentConflict);
      // The directory is untouched — the failure did not replace it.
      expect(fs.statSync(`${root}/intake/a.json`).isDirectory()).toBe(true);
    });
  });

  test("names the temporary file so it cannot collide with the real one", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      instance.preserveBytes("intake/a.json", new TextEncoder().encode("{}\n"));
    });
    // Nothing but the canonical name survives a successful write.
    expect(fs.readdirSync(`${root}/intake`)).toEqual(["a.json"]);
  });

  test("refuses rather than publish bytes it could not write whole", () => {
    // A write that lays down one byte and then stops making progress. The
    // kernel is allowed to do this, and the whole temp-file-then-rename dance
    // exists so that it cannot reach the canonical path: the oracle raises on
    // a short write, and a version that only looked at the return value would
    // fsync and rename a truncated file into place, reporting success.
    const instance = new AtlasInstance(root);
    const data = new TextEncoder().encode('{"long":"enough to need a second write"}\n');
    const real = fs.writeSync;
    let calls = 0;
    const stunted = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number): number =>
      calls++ === 0 ? real(fd, buffer, offset, 1, null) : 0;
    // Swapped inside the held lock: taking the lock is itself a write, and a
    // stub installed any earlier would refuse that instead.
    instance.withLock(() => {
      try {
        Object.assign(fs, { writeSync: stunted });
        const failure = refusal(() => instance.preserveBytes("intake/short.json", data));
        expect(failure.diagnostic.reason).toBe(ReasonCode.PreserveIo);
      } finally {
        Object.assign(fs, { writeSync: real });
      }
    });
    // Neither the canonical name nor the temporary one survives.
    expect(fs.readdirSync(`${root}/intake`)).toEqual([]);
  });

  test("creates its parent directories with owner-only permissions", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      instance.preserveBytes("intake/deep/a.json", new TextEncoder().encode("{}\n"));
    });
    expect(fs.statSync(`${root}/intake/deep`).mode & 0o777).toBe(0o700);
    expect(fs.statSync(`${root}/intake/deep/a.json`).mode & 0o777).toBe(0o600);
  });
});

describe("an append", () => {
  test("ends every row with exactly one newline", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      instance.appendRecord("state/artifacts.jsonl", ARTIFACT);
      instance.appendRecord("state/artifacts.jsonl", ARTIFACT);
    });
    const written = fs.readFileSync(`${root}/state/artifacts.jsonl`, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written.split("\n").filter((line) => line !== "")).toHaveLength(2);
    expect(written).not.toContain("\n\n");
  });

  test("refuses a row past the §25.8 ceiling without writing part of it", () => {
    const instance = new AtlasInstance(root);
    instance.withLock(() => {
      const huge = { ...ARTIFACT, summary: "x".repeat(20_000) };
      expect(refusal(() => instance.appendRecord("state/artifacts.jsonl", huge))
        .diagnostic.reason).toBe(ReasonCode.ByteCeilingExceeded);
    });
    // Refused before the open, so the journal was never created.
    expect(fs.existsSync(`${root}/state/artifacts.jsonl`)).toBe(false);
  });
});

describe("a diagnostic", () => {
  test("carries no control sequence out to a terminal", () => {
    const line = formatDiagnostics({
      reason: ReasonCode.UnsafePath,
      level: DiagnosticLevel.Error,
      relativePath: "a\nbc",
      recordIndex: 3,
    });
    expect(line).toBe(
      "ERROR: a?b?c#3: unsafe-path; expected a real contained path with no " +
        "traversal, symlink, or special file",
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  test("keeps an ordinary space and a character outside the basic plane", () => {
    expect(
      formatDiagnostics({
        reason: ReasonCode.InvalidJson,
        level: DiagnosticLevel.Warning,
        relativePath: "a b/é\u{1F600}.json",
        recordIndex: null,
      }),
    ).toContain("WARNING: a b/é\u{1F600}.json: invalid-json;");
  });

  test("joins several onto one line each", () => {
    const many = formatDiagnostics([
      { reason: ReasonCode.LockHeld, level: DiagnosticLevel.Error, relativePath: "a", recordIndex: null },
      { reason: ReasonCode.LockIo, level: DiagnosticLevel.Error, relativePath: "b", recordIndex: 1 },
    ]);
    expect(many.split("\n")).toHaveLength(2);
  });
});

describe("a ceiling", () => {
  test("refuses a missing one rather than treating it as unlimited", () => {
    expect(
      refusal(() => enforceCeiling(0, { maximum: null, kind: "bytes" })).diagnostic.reason,
    ).toBe(ReasonCode.UnboundedRead);
  });

  test("tells a byte overrun from a count overrun", () => {
    expect(refusal(() => enforceCeiling(2, { maximum: 1, kind: "bytes" })).diagnostic.reason)
      .toBe(ReasonCode.ByteCeilingExceeded);
    expect(refusal(() => enforceCeiling(2, { maximum: 1, kind: "count" })).diagnostic.reason)
      .toBe(ReasonCode.CountCeilingExceeded);
  });

  test("refuses a fractional count, which no oracle case can produce", () => {
    // Python cannot reach this: an int is an int. In JavaScript every number
    // is the same type, so "how many bytes" can arrive as 1.5 and a plain
    // `actual > maximum` would happily let 1.5 through a ceiling of 2.
    expect(refusal(() => enforceCeiling(1.5, { maximum: 2, kind: "bytes" })).diagnostic.reason)
      .toBe(ReasonCode.InvalidCeiling);
    expect(refusal(() => enforceCeiling(1, { maximum: 2.5, kind: "bytes" })).diagnostic.reason)
      .toBe(ReasonCode.InvalidCeiling);
    expect(refusal(() => enforceCeiling(Number.NaN, { maximum: 2, kind: "bytes" })).diagnostic.reason)
      .toBe(ReasonCode.InvalidCeiling);
    expect(
      refusal(() => enforceCeiling(Number.POSITIVE_INFINITY, { maximum: 2, kind: "bytes" }))
        .diagnostic.reason,
    ).toBe(ReasonCode.InvalidCeiling);
  });
});

describe("a receipt key", () => {
  test("is built only from slugs and a non-negative index", () => {
    expect(makeReceiptKey("src", "batch", 0)).toBe("src/batch#0");
    for (const bad of [
      () => makeReceiptKey("Src", "batch", 0),
      () => makeReceiptKey("src", "batch", -1),
      () => makeReceiptKey("src", "batch", 1.5),
      () => makeReceiptKey("", "batch", 0),
    ]) {
      expect(refusal(bad).diagnostic.reason).toBe(ReasonCode.InvalidReceiptKey);
    }
  });

  test("still allows a reserved namespace, which only intake refuses", () => {
    expect(makeReceiptKey("import", "batch", 0)).toBe("import/batch#0");
    expect(makeReceiptKey("observe", "batch", 0)).toBe("observe/batch#0");
  });
});

describe("nested JSON equality", () => {
  // The single recorded divergence in this tranche (#127). The oracle compares
  // nested members with Python's `==`, where `1 == True`, so it reads these
  // pairs as one value; JSON Schema 2020-12 makes them different values, and
  // the schemas declare that dialect.
  const duplicates = (items: unknown[]): number =>
    new SchemaValidator({ type: "array", uniqueItems: true }).validate(items).length;

  test("keeps an integer apart from a boolean inside a container", () => {
    expect(duplicates([{ a: 1 }, { a: true }])).toBe(0);
    expect(duplicates([[1], [true]])).toBe(0);
    expect(duplicates([{ a: 0 }, { a: false }])).toBe(0);
  });

  test("still calls a genuine repeat a repeat", () => {
    expect(duplicates([{ a: 1 }, { a: 1 }])).toBe(1);
    expect(duplicates([[1], [1]])).toBe(1);
    expect(duplicates([{ a: 1 }, { a: 2 }])).toBe(0);
  });

  test("does not let an empty container equal a primitive", () => {
    // `Object.keys` of a primitive is empty, so a compare that skipped the
    // type check would read `{}` as equal to `true`, `0` and `""` — and every
    // one of those would be a `const` or `enum` quietly accepting the wrong
    // value.
    for (const primitive of [true, false, 0, 1, ""]) {
      expect(
        new SchemaValidator({ const: primitive }).validate({}).length,
      ).toBe(1);
      expect(new SchemaValidator({ const: primitive }).validate([]).length).toBe(1);
    }
  });
});

describe("the object type", () => {
  test("means a JSON object, not everything JavaScript calls one", () => {
    // The oracle asks `isinstance(value, dict)`. Structurally a `Date` and a
    // `Map` are objects here, and a validator that said so would pass a value
    // the writer then refuses to emit — a preflight that clears something the
    // write rejects is worse than no preflight.
    const object = new SchemaValidator({ type: "object" });
    for (const exotic of [new Date(0), new Map(), /re/, () => 0]) {
      expect(object.validate(exotic).map((error) => error.keyword)).toEqual(["type"]);
    }
    expect(object.validate({ a: 1 })).toEqual([]);
    expect(object.validate(Object.create(null) as object)).toEqual([]);
  });
});

describe("a property whose name looks like an array index", () => {
  // The tranche's second recorded divergence (#128), and one no port written
  // in this language can close: JavaScript visits `"2024"` before `"note"`
  // whatever order they arrived in, so by the time any validator sees the
  // object the document's order is already gone. The oracle keeps it and
  // reports the same two errors the other way round.
  //
  // Nothing Atlas authors can reach it — no field name in any schema is a
  // number, which is why the document writer refuses such a key outright
  // (§25.7) — so this needs a foreign delivered document to appear at all,
  // and even then only the order changes, never which errors are found.
  const schema = {
    type: "object",
    properties: { note: { type: "string" }, "2024": { type: "string" } },
  };

  test("is reported first, where the oracle reports it in document order", () => {
    const errors = new SchemaValidator(schema).validate(parseStrict('{"note":0,"2024":0}'));
    expect(errors.map((error) => error.path)).toEqual(["$.2024", "$.note"]);
  });

  test("changes the order of the errors and nothing else", () => {
    const both = new SchemaValidator(schema).validate(parseStrict('{"note":0,"2024":0}'));
    const swapped = new SchemaValidator(schema).validate(parseStrict('{"2024":0,"note":0}'));
    // Same findings from either spelling, which is what the oracle also gives
    // — it is only the sequence the two disagree about.
    expect(both.map((error) => error.path).sort()).toEqual(["$.2024", "$.note"]);
    expect(swapped.map((error) => error.path)).toEqual(both.map((error) => error.path));
  });
});

describe("an instance root", () => {
  test("must be a real directory holding atlas/ and state/", () => {
    const bare = fs.mkdtempSync("/tmp/atlas-bare-");
    expect(refusal(() => new AtlasInstance(bare)).diagnostic.reason).toBe(
      ReasonCode.InvalidRoot,
    );
    fs.rmSync(bare, { recursive: true, force: true });
  });

  test("is refused when state/ is a symbolic link", () => {
    const linked = fs.mkdtempSync("/tmp/atlas-linked-");
    fs.mkdirSync(`${linked}/atlas`);
    fs.mkdirSync(`${linked}/real`);
    fs.symlinkSync("real", `${linked}/state`);
    expect(refusal(() => new AtlasInstance(linked)).diagnostic.reason).toBe(
      ReasonCode.InvalidRoot,
    );
    fs.rmSync(linked, { recursive: true, force: true });
  });
});
