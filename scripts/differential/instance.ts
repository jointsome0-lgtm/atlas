import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the durable-I/O port against the CPython oracle.
//
// Both sides run the same scenario — a starting tree, then a sequence of
// operations, some inside the instance lock — and both report the same three
// things: what each operation answered, what it refused with, and the exact
// bytes left on disk afterwards.
//
// The bytes are the point. §25.6 makes journal rows and preserved originals
// durable interchange, so "the port writes the same thing" has to mean the
// same octets, not the same JSON value; a key order or separator that drifted
// would still parse and would still be a broken migration.

import fs from "node:fs";

import {
  AtlasIOError,
  AtlasInstance,
  enforceCeiling,
  makeReceiptKey,
} from "../src/boundary/instance.ts";
import { compareCodePoint } from "../src/boundary/ordering.ts";
import { parseStrict } from "../src/boundary/canonical-json.ts";
import { SchemaSubsetError, SchemaValidator } from "../src/boundary/schema.ts";

interface SetupEntry {
  readonly kind: "dir" | "file" | "symlink";
  readonly path: string;
  readonly data?: string;
  readonly target?: string;
}

interface Op {
  readonly op: string;
  readonly [key: string]: unknown;
}

interface Scenario {
  readonly name: string;
  readonly setup?: readonly SetupEntry[];
  readonly before?: readonly Op[];
  readonly locked?: readonly Op[];
  readonly after?: readonly Op[];
  /** Set when the two implementations are known and agreed to differ. */
  readonly oracleDiffers?: string;
}

interface Observed {
  readonly construct: string | null;
  readonly ops: ReadonlyArray<{ ok?: unknown; error?: string }>;
  readonly tree: ReadonlyArray<readonly [string, string]>;
  readonly lock_left: boolean;
}

const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");

function build(root: string, entries: readonly SetupEntry[]): void {
  for (const entry of entries) {
    const target = `${root}/${entry.path}`;
    if (entry.kind === "dir") {
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.kind === "file") {
      fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(target, Buffer.from(entry.data as string, "base64"));
    } else {
      fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      fs.symlinkSync(entry.target as string, target);
    }
  }
}

/** Keep the structured half of a schema error; the prose is not a contract. */
const pathsOnly = (messages: readonly string[]): string[] =>
  messages.map((message) => message.split(": ", 1)[0] as string);

function runOp(instance: AtlasInstance, op: Op): unknown {
  switch (op.op) {
    case "preserve_bytes":
      return instance.preserveBytes(
        op.path as string,
        new Uint8Array(Buffer.from(op.data as string, "base64")),
      );
    case "append_record": {
      const r = instance.appendRecord(op.path as string, op.record as Record<string, unknown>);
      return [r.relativePath, r.bytesWritten, r.created];
    }
    case "append_receipt": {
      const r = instance.appendReceipt(op.key as string, op.marker as string, op.date as string);
      return [r.relativePath, r.bytesWritten, r.created];
    }
    case "receipt_status": {
      const s = instance.receiptStatus();
      return [
        [...s.opened].sort(compareCodePoint),
        [...s.processed].sort(compareCodePoint),
        [...s.interrupted].sort(compareCodePoint),
      ];
    }
    case "read_json":
      return instance.readJson(op.path as string, {
        maxBytes: op.max_bytes as number | null,
        delivered: (op.delivered as boolean | undefined) ?? false,
      });
    case "read_delivered_json": {
      const d = instance.readDeliveredJson(op.path as string, {
        maxBytes: op.max_bytes as number | null,
        delivered: (op.delivered as boolean | undefined) ?? true,
      });
      return [d.value, Buffer.from(d.data).toString("base64")];
    }
    case "enforce_ceiling":
      enforceCeiling(op.actual as number, {
        maximum: op.maximum as number | null,
        kind: op.kind as "bytes" | "count",
        relativePath: (op.path as string | undefined) ?? ".",
      });
      return null;
    case "make_receipt_key":
      return makeReceiptKey(op.source as string, op.batch as string, op.index as number);
    case "path": {
      const resolved = instance.path(op.path as string, {
        allowMissing: (op.allow_missing as boolean | undefined) ?? false,
      });
      return resolved === instance.root
        ? "."
        : resolved.slice(instance.root.length + 1);
    }
    case "schema_errors":
      return pathsOnly(
        instance.schemaErrors(op.value, op.schema as string, {
          definition: op.definition as string | undefined,
        }),
      );
    case "validate_schema":
      instance.validateSchema(op.value, op.schema as string, {
        definition: op.definition as string | undefined,
      });
      return null;
    case "validate_format":
      return instance.validateFormat(op.value, {
        definition: op.definition as string | undefined,
      });
    case "validate_raw":
      // The validator straight, not through the registry: a generic checker
      // deserves schemas built to hit one keyword each, and no authored schema
      // happens to exercise every branch.
      try {
        // `text` is parsed here rather than sent as a value: see the oracle.
        const value = op.text === undefined ? op.value : parseStrict(op.text as string);
        return pathsOnly(
          new SchemaValidator(op.schema as Record<string, unknown>)
            .validate(value)
            .map((error) => error.message),
        );
      } catch (error) {
        if (error instanceof SchemaSubsetError) return ["subset-error"];
        throw error;
      }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

function runOps(
  instance: AtlasInstance,
  ops: readonly Op[],
  observed: Array<{ ok?: unknown; error?: string }>,
): void {
  for (const op of ops) {
    try {
      observed.push({ ok: runOp(instance, op) ?? null });
    } catch (error) {
      if (error instanceof AtlasIOError) observed.push({ error: error.message });
      else throw error;
    }
  }
}

function snapshot(root: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const full = `${directory}/${name}`;
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) found.push([relative, "symlink"]);
      else if (info.isDirectory()) walk(full, relative);
      else if (info.isFile()) {
        found.push([relative, fs.readFileSync(full).toString("base64")]);
      }
    }
  };
  walk(root, "");
  // Python's rglob yields sorted `Path` objects, and a path sorts by its
  // components rather than by its text: "state/receipts/x" precedes
  // "state/receipts.jsonl" because "receipts" < "receipts.jsonl", while as
  // strings the "." beats the "/". Sorting the same way here keeps a
  // difference in this list meaning a difference in what was written.
  return found.sort((left, right) => {
    const l = left[0].split("/");
    const r = right[0].split("/");
    for (let index = 0; index < Math.min(l.length, r.length); index += 1) {
      const order = compareCodePoint(l[index] as string, r[index] as string);
      if (order !== 0) return order;
    }
    return l.length - r.length;
  });
}

function observe(scenario: Scenario, root: string): Observed {
  build(root, scenario.setup ?? []);
  const observed: Array<{ ok?: unknown; error?: string }> = [];
  let instance: AtlasInstance;
  try {
    instance = new AtlasInstance(root);
  } catch (error) {
    if (!(error instanceof AtlasIOError)) throw error;
    return { construct: error.message, ops: [], tree: snapshot(root), lock_left: false };
  }

  runOps(instance, scenario.before ?? [], observed);
  const locked = scenario.locked ?? [];
  if (locked.length > 0) {
    try {
      instance.withLock(() => runOps(instance, locked, observed));
    } catch (error) {
      if (error instanceof AtlasIOError) observed.push({ error: error.message });
      else throw error;
    }
  }
  runOps(instance, scenario.after ?? [], observed);

  const tree = snapshot(root).filter(([name]) => name !== ".atlas-lock");
  return {
    construct: null,
    ops: observed,
    tree,
    lock_left: fs.existsSync(`${root}/.atlas-lock`),
  };
}

const JSON_A = encode('{"format":"atlas-graph","version":1}\n');
const RECEIPT_ROW = (key: string, marker: string, date: string): string =>
  encode(`{"date":"${date}","intake":"${key}","marker":"${marker}"}\n`);

// A record the registered schema actually accepts. Getting this wrong is not
// a harmless fixture bug: every append scenario would refuse for the same dull
// reason on both sides, agree perfectly, and prove nothing about appending.
const ARTIFACT = {
  id: "artifact:a-note",
  type: "note",
  path: "notes/a.md",
  observed_at: "2026-08-14",
  summary: "a note",
  touches: ["concept:a-thing"],
  supports_state_updates: [],
  evidence_strength: "read",
};

/** Values aimed at one schema keyword each, whatever schema they land in. */
const PROBES: ReadonlyArray<{ value: unknown; schema: string }> = [
  { value: ARTIFACT, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2026-02-30" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2026-13-01" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2026-00-10" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2024-02-29" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2025-02-29" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2000-02-29" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "1900-02-29" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2026-04-31" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, observed_at: "2026-12-31" }, schema: "journal-artifact" },
  // Type predicates: each of the four the subset admits, given the wrong shape.
  { value: "a string where an object belongs", schema: "journal-artifact" },
  { value: [], schema: "journal-artifact" },
  { value: 7, schema: "journal-artifact" },
  { value: { ...ARTIFACT, touches: "not an array" }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, summary: 7 }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, touches: ["not-a-region-id"] }, schema: "journal-artifact" },
  { value: { ...ARTIFACT, evidence_strength: "invented" }, schema: "journal-artifact" },
  // Branching keywords, reached through the schemas that use them.
  { value: { format: "atlas-snapshot", version: 1 }, schema: "atlas-snapshot" },
  { value: { format: "atlas-graph", version: 1, nodes: [], edges: [] }, schema: "atlas-graph" },
  { value: { format: "atlas-graph", version: 1, nodes: [{}], edges: [] }, schema: "atlas-graph" },
  { value: {}, schema: "journal-decision" },
  { value: { id: "decision:x" }, schema: "journal-decision" },
  { value: {}, schema: "journal-purge" },
  { value: { targets: ["concept:a", "concept:a"] }, schema: "journal-purge" },
  { value: {}, schema: "plan-extract" },
  { value: {}, schema: "material" },
  { value: {}, schema: "trail-segment" },
  { value: {}, schema: "concept" },
  { value: {}, schema: "run-manifest" },
  { value: {}, schema: "atlas-intake" },
];


/** One synthetic schema per admitted keyword, with values either side of it. */
const RAW_CASES: ReadonlyArray<[unknown, unknown]> = (() => {
  const built: Array<[unknown, unknown]> = [];
  const probe = (schema: unknown, ...values: unknown[]): void => {
    for (const value of values) built.push([schema, value]);
  };

  probe(true, 1, "x", null);
  probe(false, 1, "x", null);
  probe({ type: "object" }, {}, [], "x", 1, null, true);
  probe({ type: "array" }, [], {}, "x", 1);
  probe({ type: "string" }, "x", "", 1, [], null);
  probe({ type: "integer" }, 1, 0, -1, "1", true, false, null, []);
  probe({ const: "a" }, "a", "b", 1, null, true);
  probe({ const: 1 }, 1, true, "1", null);
  probe({ const: true }, true, 1, "true");
  probe({ const: null }, null, 0, false, "null");
  // An empty object against a primitive. Both implementations compare types
  // before contents; drop that step and `Object.keys` of a primitive is empty,
  // so `{}` starts equalling `true`, `0` and `""` — vacuously, and silently.
  probe({ const: {} }, {}, true, false, 0, 1, "", "x", [], null);
  // The instance is the container and the schema value the primitive, which is
  // the order the validator actually calls with. The other way round the
  // comparison short-circuits on the primitive and a missing type check never
  // shows; this way `Object.keys` of a primitive is empty, and an unguarded
  // compare reads `{}` as equal to `true`, `0` and `""`.
  probe({ const: true }, {}, [], true);
  probe({ const: 0 }, {}, [], 0);
  probe({ const: "" }, {}, [], "");
  probe({ enum: [true, 0, ""] }, {}, [], true);
  probe({ const: [] }, [], {}, true, 0, "", null);
  probe({ enum: [{}, []] }, {}, [], true, 0, "", 1);
  probe({ type: "array", uniqueItems: true }, [{}, true], [true, {}], [{}, {}],
    [[], 0], [0, []], ["", {}]);
  probe({ enum: ["a", 1, null, true] }, "a", 1, null, true, false, "b", 0);
  probe({ pattern: "^a+$" }, "a", "aa", "b", "aab", "a\nb", 1);
  // The oracle rewrites `$` to `\Z` because Python's `$` also matches before a
  // trailing newline; a plain RegExp never had that behaviour to work around.
  probe({ pattern: "^a$" }, "a", "a\n", "\na", "b");
  probe({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, "2026-08-14", "2026-02-30", "2026-13-01", "x");
  probe({ minimum: 3 }, 3, 2, 4, "3", true, null);
  probe({ type: "array", minItems: 2 }, [], [1], [1, 2], [1, 2, 3]);
  probe({ type: "array", uniqueItems: true }, [], [1, 1], [1, 2], ["a", "a"],
    [{ a: 1 }, { a: 1 }], [[1], [1]], [1, true], [null, null]);
  probe({ type: "object", minProperties: 2 }, {}, { a: 1 }, { a: 1, b: 2 });
  probe({ type: "object", required: ["a", "b"] }, {}, { a: 1 }, { a: 1, b: 2 });
  probe(
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    {}, { a: "x" }, { a: 1 }, { b: 1 }, { a: "x", b: 1 },
  );
  probe(
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "integer" } },
    { a: "x", b: 1 }, { a: "x", b: "y" },
  );
  probe({ type: "array", items: { type: "integer" } }, [1, 2], [1, "x"], ["x"]);
  probe({ oneOf: [{ type: "string" }, { type: "integer" }] }, "x", 1, null, true);
  // Two branches that both match: exactly the case `count !== 1` exists for.
  probe({ oneOf: [{ type: "integer" }, { minimum: 0 }] }, 1, -1, "x");
  probe({ anyOf: [{ type: "string" }, { type: "integer" }] }, "x", 1, null);
  probe({ allOf: [{ type: "string" }, { pattern: "^a" }] }, "ab", "b", 1);
  probe(
    { if: { type: "string" }, then: { pattern: "^a" } },
    "ab", "b", 1, null,
  );
  // `then` without a matching `if` must stay unapplied.
  probe({ if: { type: "integer" }, then: { minimum: 10 } }, 5, 15, "x");
  probe(
    { $defs: { s: { type: "string" } }, properties: { a: { $ref: "#/$defs/s" } } },
    { a: "x" }, { a: 1 },
  );
  probe({ $ref: "#/$defs/missing" }, "x");
  probe({ $ref: "https://example/schema" }, "x");
  // A wrong type stops the check for that value. Without the stop, the
  // keywords after it would run on a value they were never meant to see, and
  // these are the shapes where that second complaint actually appears.
  probe({ type: "integer", enum: [1, 2] }, "x", 1, true);
  probe({ type: "string", const: "a" }, 1, "a", "b");
  probe({ type: "string", enum: ["a"], pattern: "^a$", minimum: 5 }, 4, "a", "b");
  probe({ type: "object", required: ["a"], minProperties: 1 }, [], {}, { a: 1 });
  probe({ type: "array", minItems: 1, uniqueItems: true }, {}, [], [1, 1]);
  probe({ type: "number" }, 1);
  probe({ unsupportedKeyword: 1 }, "x");
  probe({ pattern: "[" }, "x");
  return built;
})();

/**
 * Values whose parts are a JSON integer in one and a JSON boolean in the
 * other, nested inside a container.
 *
 * The oracle compares types only at the top of a value and then defers to
 * Python's `==`, where `1 == True`; so it reads `{"a": 1}` and `{"a": true}`
 * as the same value. JSON Schema 2020-12 says they are different values, and
 * the schemas declare that dialect, so the port follows the dialect and the
 * oracle is the one that is wrong (#127).
 */
const COERCION_CASES: ReadonlyArray<[unknown, unknown]> = [
  [{ type: "array", uniqueItems: true }, [{ a: 1 }, { a: true }]],
  [{ type: "array", uniqueItems: true }, [[1], [true]]],
  [{ type: "array", uniqueItems: true }, [{ a: 0 }, { a: false }]],
  [{ const: { a: 1 } }, { a: true }],
  [{ const: [1] }, [true]],
  [{ enum: [{ a: 1 }] }, { a: true }],
];

const SCENARIOS: readonly Scenario[] = [
  {
    name: "an empty instance answers with an empty receipt fold",
    locked: [{ op: "receipt_status" }],
  },
  {
    name: "a root without atlas/ is not an instance",
    setup: [{ kind: "dir", path: "state" }],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "a state/ that is a symlink is not an instance",
    setup: [
      { kind: "dir", path: "real" },
      { kind: "symlink", path: "state", target: "real" },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "one receipt pair, opened then processed",
    locked: [
      { op: "append_receipt", key: "src/batch#0", marker: "opened", date: "2026-08-14" },
      { op: "append_receipt", key: "src/batch#0", marker: "processed", date: "2026-08-14" },
      { op: "receipt_status" },
    ],
  },
  {
    name: "processed before opened is refused",
    locked: [
      { op: "append_receipt", key: "src/batch#0", marker: "processed", date: "2026-08-14" },
    ],
  },
  {
    name: "the same key opened twice is refused",
    locked: [
      { op: "append_receipt", key: "src/batch#0", marker: "opened", date: "2026-08-14" },
      { op: "append_receipt", key: "src/batch#0", marker: "opened", date: "2026-08-14" },
    ],
  },
  {
    name: "an interrupted key is opened without processed",
    locked: [
      { op: "append_receipt", key: "src/batch#0", marker: "opened", date: "2026-08-14" },
      { op: "append_receipt", key: "src/batch#1", marker: "opened", date: "2026-08-14" },
      { op: "append_receipt", key: "src/batch#1", marker: "processed", date: "2026-08-14" },
      { op: "receipt_status" },
    ],
  },
  {
    name: "a receipt journal read back from disk",
    setup: [
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: RECEIPT_ROW("src/batch#0", "opened", "2026-08-14"),
      },
    ],
    before: [{ op: "receipt_status" }],
    locked: [
      { op: "append_receipt", key: "src/batch#0", marker: "processed", date: "2026-08-14" },
    ],
  },
  {
    name: "a rotated receipt file is the older prefix",
    setup: [
      {
        kind: "file",
        path: "state/receipts/0001.jsonl",
        data: RECEIPT_ROW("src/batch#0", "opened", "2026-08-01"),
      },
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: RECEIPT_ROW("src/batch#0", "processed", "2026-08-02"),
      },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "processed ahead of its opened row is refused",
    setup: [
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: encode(
          `{"date":"2026-08-02","intake":"src/batch#0","marker":"processed"}\n` +
            `{"date":"2026-08-01","intake":"src/batch#0","marker":"opened"}\n`,
        ),
      },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "a processed row with no opened row anywhere",
    setup: [
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: RECEIPT_ROW("src/batch#0", "processed", "2026-08-02"),
      },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "an opened row rotated after the processed row it should precede",
    setup: [
      {
        kind: "file",
        path: "state/receipts/0001.jsonl",
        data: RECEIPT_ROW("src/batch#0", "processed", "2026-08-02"),
      },
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: RECEIPT_ROW("src/batch#0", "opened", "2026-08-01"),
      },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "a receipt row that is not valid JSON",
    setup: [{ kind: "file", path: "state/receipts.jsonl", data: encode("{not json}\n") }],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "a receipt row missing its marker",
    setup: [
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: encode('{"date":"2026-08-01","intake":"src/batch#0"}\n'),
      },
    ],
    before: [{ op: "receipt_status" }],
  },
  {
    name: "a journal whose last row has no newline",
    setup: [
      {
        kind: "file",
        path: "state/receipts.jsonl",
        data: encode('{"date":"2026-08-01","intake":"src/batch#0","marker":"opened"}'),
      },
    ],
    before: [{ op: "receipt_status" }],
    locked: [
      { op: "append_receipt", key: "src/batch#1", marker: "opened", date: "2026-08-14" },
    ],
  },
  {
    name: "an artifact row appended to its registered journal",
    locked: [
      { op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT },
      { op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT },
    ],
  },
  {
    name: "an artifact row appended to a rotation file",
    locked: [
      { op: "append_record", path: "state/artifacts/0001.jsonl", record: ARTIFACT },
    ],
  },
  {
    name: "a journal path outside state/ is refused",
    locked: [{ op: "append_record", path: "atlas/artifacts.jsonl", record: ARTIFACT }],
  },
  {
    name: "an unregistered journal stem is refused",
    locked: [{ op: "append_record", path: "state/notes.jsonl", record: ARTIFACT }],
  },
  {
    name: "receipts cannot be appended as an ordinary record",
    locked: [
      {
        op: "append_record",
        path: "state/receipts.jsonl",
        record: { intake: "src/batch#0", marker: "opened", date: "2026-08-14" },
      },
    ],
  },
  {
    name: "a two-level rotation is not a journal path",
    locked: [
      { op: "append_record", path: "state/artifacts/a/b.jsonl", record: ARTIFACT },
    ],
  },
  {
    name: "a record that fails its schema is refused",
    locked: [
      { op: "append_record", path: "state/artifacts.jsonl", record: { id: "nope" } },
    ],
  },
  {
    name: "an append without the lock is refused",
    before: [{ op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT }],
  },
  {
    name: "a preserve without the lock is refused",
    before: [{ op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A }],
  },
  {
    name: "an original preserved once, then replayed",
    locked: [
      { op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A },
      { op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A },
    ],
  },
  {
    name: "different bytes at a preserved path conflict",
    locked: [
      { op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A },
      { op: "preserve_bytes", path: "intake/raw/a.json", data: encode("{}\n") },
    ],
  },
  {
    name: "same-length different bytes still conflict",
    locked: [
      { op: "preserve_bytes", path: "intake/raw/a.json", data: encode("{}\n") },
      { op: "preserve_bytes", path: "intake/raw/a.json", data: encode("[]\n") },
    ],
  },
  {
    name: "preserving under an ignore root is refused",
    locked: [{ op: "preserve_bytes", path: "secrets/a.json", data: JSON_A }],
  },
  {
    name: "preserving into .env is refused",
    locked: [{ op: "preserve_bytes", path: ".env.local", data: JSON_A }],
  },
  {
    name: "preserving above the root is refused",
    locked: [{ op: "preserve_bytes", path: "../escape.json", data: JSON_A }],
  },
  {
    name: "reading back a preserved original",
    locked: [
      { op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A },
      { op: "read_json", path: "intake/raw/a.json", max_bytes: 4096 },
    ],
  },
  {
    name: "a read with no ceiling is refused",
    setup: [{ kind: "file", path: "atlas/a.json", data: JSON_A }],
    before: [{ op: "read_json", path: "atlas/a.json", max_bytes: null }],
  },
  {
    name: "a read past its ceiling is refused",
    setup: [{ kind: "file", path: "atlas/a.json", data: JSON_A }],
    before: [{ op: "read_json", path: "atlas/a.json", max_bytes: 4 }],
  },
  {
    name: "a read exactly at its ceiling is allowed",
    setup: [{ kind: "file", path: "atlas/a.json", data: encode("{}") }],
    before: [{ op: "read_json", path: "atlas/a.json", max_bytes: 2 }],
  },
  {
    name: "a BOM is refused for Atlas-authored text and kept for a delivery",
    setup: [{ kind: "file", path: "atlas/a.json", data: encode("﻿{}") }],
    before: [
      { op: "read_json", path: "atlas/a.json", max_bytes: 64 },
      { op: "read_json", path: "atlas/a.json", max_bytes: 64, delivered: true },
    ],
  },
  {
    name: "a CR is refused for Atlas-authored text",
    setup: [{ kind: "file", path: "atlas/a.json", data: encode('{"a":\r1}') }],
    before: [
      { op: "read_json", path: "atlas/a.json", max_bytes: 64 },
      { op: "read_json", path: "atlas/a.json", max_bytes: 64, delivered: true },
    ],
  },
  {
    name: "a duplicate object key is refused",
    setup: [{ kind: "file", path: "atlas/a.json", data: encode('{"a":1,"a":2}') }],
    before: [{ op: "read_json", path: "atlas/a.json", max_bytes: 64 }],
  },
  {
    name: "reading through a symlinked file is refused",
    setup: [
      { kind: "file", path: "atlas/real.json", data: JSON_A },
      { kind: "symlink", path: "atlas/link.json", target: "real.json" },
    ],
    before: [{ op: "read_json", path: "atlas/link.json", max_bytes: 64 }],
  },
  {
    name: "reading through a symlinked directory is refused",
    setup: [
      { kind: "file", path: "atlas/deep/real.json", data: JSON_A },
      { kind: "symlink", path: "atlas/link", target: "deep" },
    ],
    before: [{ op: "read_json", path: "atlas/link/real.json", max_bytes: 64 }],
  },
  {
    name: "reading a directory as JSON is refused",
    before: [{ op: "read_json", path: "atlas", max_bytes: 64 }],
  },
  {
    name: "reading an absent file is refused",
    before: [{ op: "read_json", path: "atlas/missing.json", max_bytes: 64 }],
  },
  {
    name: "a path with a redundant component names the same file",
    setup: [{ kind: "file", path: "atlas/a.json", data: JSON_A }],
    before: [
      { op: "read_json", path: "atlas/./a.json", max_bytes: 64 },
      { op: "read_json", path: "atlas//a.json", max_bytes: 64 },
      { op: "path", path: "atlas/./a.json" },
      { op: "path", path: "atlas" },
      { op: "path", path: "atlas/missing.json", allow_missing: true },
      { op: "path", path: "atlas/missing.json" },
    ],
  },
  {
    name: "every ceiling shape",
    before: [
      { op: "enforce_ceiling", actual: 0, maximum: 0, kind: "bytes" },
      { op: "enforce_ceiling", actual: 1, maximum: 0, kind: "bytes" },
      { op: "enforce_ceiling", actual: 1, maximum: 0, kind: "count" },
      { op: "enforce_ceiling", actual: 0, maximum: null, kind: "bytes" },
      { op: "enforce_ceiling", actual: -1, maximum: 1, kind: "bytes" },
      { op: "enforce_ceiling", actual: 1, maximum: -1, kind: "bytes" },
      { op: "enforce_ceiling", actual: 1, maximum: 2, kind: "nonsense" },
      { op: "enforce_ceiling", actual: 1, maximum: 2, kind: "bytes", path: "a/b" },
    ],
  },
  {
    name: "every receipt key shape",
    before: [
      { op: "make_receipt_key", source: "src", batch: "batch", index: 0 },
      { op: "make_receipt_key", source: "a-b", batch: "c-d", index: 12 },
      { op: "make_receipt_key", source: "import", batch: "b", index: 0 },
      { op: "make_receipt_key", source: "Src", batch: "b", index: 0 },
      { op: "make_receipt_key", source: "-a", batch: "b", index: 0 },
      { op: "make_receipt_key", source: "a", batch: "b", index: -1 },
      { op: "make_receipt_key", source: "", batch: "b", index: 0 },
    ],
  },
  {
    name: "a receipt key the appender refuses",
    locked: [
      { op: "append_receipt", key: "no-slash", marker: "opened", date: "2026-08-14" },
      { op: "append_receipt", key: "src/batch#0", marker: "sideways", date: "2026-08-14" },
    ],
  },
  {
    name: "a graph document checked against its declared format",
    before: [
      {
        op: "validate_format",
        value: { format: "atlas-graph", version: 1, nodes: [], edges: [] },
      },
      { op: "validate_format", value: { format: "atlas-graph", version: 99 } },
      { op: "validate_format", value: { format: "not-a-format", version: 1 } },
      { op: "validate_format", value: { version: 1 } },
      { op: "validate_format", value: [] },
    ],
  },
  {
    name: "schema errors name the failing member",
    before: [
      { op: "schema_errors", value: ARTIFACT, schema: "journal-artifact" },
      { op: "schema_errors", value: { id: "artifact:a" }, schema: "journal-artifact" },
      { op: "schema_errors", value: {}, schema: "journal-artifact" },
      { op: "schema_errors", value: { ...ARTIFACT, extra: 1 }, schema: "journal-artifact" },
      { op: "schema_errors", value: { ...ARTIFACT, observed_at: "2026-02-30" }, schema: "journal-artifact" },
      { op: "schema_errors", value: { ...ARTIFACT, id: "Artifact:A" }, schema: "journal-artifact" },
      { op: "schema_errors", value: ARTIFACT, schema: "no-such-schema" },
      { op: "validate_schema", value: ARTIFACT, schema: "journal-artifact" },
      { op: "validate_schema", value: {}, schema: "journal-artifact" },
    ],
  },
  {
    name: "every schema keyword the subset admits",
    before: PROBES.map((probe) => ({
      op: "schema_errors",
      value: probe.value,
      schema: probe.schema,
    })),
  },
  {
    name: "the validator against schemas built one keyword at a time",
    before: RAW_CASES.map(([schema, value]) => ({ op: "validate_raw", schema, value })),
  },
  {
    name: "an integer and a boolean nested in the same shape",
    before: COERCION_CASES.map(([schema, value]) => ({ op: "validate_raw", schema, value })),
    oracleDiffers:
      "the oracle compares nested values with Python `==`, where 1 == True; " +
      "JSON Schema 2020-12 makes them distinct values (#127)",
  },
  {
    name: "a key JavaScript sorts ahead of the others",
    before: [
      {
        op: "validate_raw",
        schema: {
          type: "object",
          properties: { note: { type: "string" }, "2024": { type: "string" } },
        },
        text: '{"note":0,"2024":0}',
      },
    ],
    oracleDiffers:
      "an array-index-like key is visited first by JavaScript and in document " +
      "order by the oracle, so the same two errors come back swapped (#128)",
  },
  {
    name: "a definition inside a schema, validated on its own",
    before: [
      { op: "schema_errors", value: "2026-08-14", schema: "journal-artifact", definition: "date" },
      { op: "schema_errors", value: "2026-02-30", schema: "journal-artifact", definition: "date" },
      { op: "schema_errors", value: "concept:a-thing", schema: "journal-artifact", definition: "regionId" },
      { op: "schema_errors", value: "Concept:A", schema: "journal-artifact", definition: "regionId" },
      { op: "schema_errors", value: 7, schema: "journal-artifact", definition: "date" },
      { op: "schema_errors", value: "x", schema: "journal-artifact", definition: "no-such-def" },
    ],
  },
  {
    name: "a date that passes its shape but is not a day",
    locked: [
      {
        op: "append_record",
        path: "state/artifacts.jsonl",
        record: { ...ARTIFACT, observed_at: "2026-13-01" },
      },
      {
        op: "append_record",
        path: "state/artifacts.jsonl",
        record: { ...ARTIFACT, observed_at: "2026-02-29" },
      },
      {
        op: "append_record",
        path: "state/artifacts.jsonl",
        record: { ...ARTIFACT, observed_at: "2024-02-29" },
      },
    ],
  },
  {
    name: "a row is written with sorted keys and no spaces",
    locked: [
      {
        op: "append_record",
        path: "state/artifacts.jsonl",
        record: { summary: "z", type: "note", id: "artifact:a-note", observed_at: "2026-08-14",
                  path: "notes/a.md", touches: [], supports_state_updates: [],
                  evidence_strength: "read" },
      },
    ],
  },
  {
    name: "a row carrying text outside the basic plane",
    locked: [
      {
        op: "append_record",
        path: "state/artifacts.jsonl",
        record: { ...ARTIFACT, summary: "\u{1F600} and é and 中" },
      },
    ],
  },
  {
    name: "an append onto a journal whose tail is not a newline",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode('{"id":"artifact:x","type":"note","path":"n.md","observed_at":"2026-08-01",'
          + '"summary":"x","touches":[],"supports_state_updates":[],"evidence_strength":"read"}'),
      },
    ],
    locked: [{ op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT }],
  },
  {
    name: "an append onto a symlinked journal is refused",
    setup: [
      { kind: "file", path: "state/real.jsonl", data: encode("") },
      { kind: "symlink", path: "state/artifacts.jsonl", target: "real.jsonl" },
    ],
    locked: [{ op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT }],
  },
  {
    name: "an append onto a directory is refused",
    setup: [{ kind: "dir", path: "state/artifacts.jsonl" }],
    locked: [{ op: "append_record", path: "state/artifacts.jsonl", record: ARTIFACT }],
  },
  {
    name: "a delivery read from outside the instance",
    before: [
      { op: "read_delivered_json", path: "/DELIVERY/batch.json", max_bytes: 4096 },
      { op: "read_delivered_json", path: "/DELIVERY/batch.json", max_bytes: 2 },
      { op: "read_delivered_json", path: "/DELIVERY/missing.json", max_bytes: 4096 },
    ],
  },
  {
    name: "a delivery under an ignore-named component is refused",
    before: [
      { op: "read_delivered_json", path: "/DELIVERY/secrets/batch.json", max_bytes: 4096 },
    ],
  },
  {
    name: "a delivery inside the instance binds the instance rules",
    setup: [{ kind: "file", path: "intake/batch.json", data: JSON_A }],
    before: [{ op: "read_delivered_json", path: "ROOT/intake/batch.json", max_bytes: 4096 }],
  },
  {
    name: "a delivery inside an instance ignore root is refused",
    setup: [{ kind: "file", path: "secrets/batch.json", data: JSON_A }],
    before: [{ op: "read_delivered_json", path: "ROOT/secrets/batch.json", max_bytes: 4096 }],
  },
  {
    name: "a preserved original survives a lock taken twice in turn",
    locked: [{ op: "preserve_bytes", path: "intake/raw/a.json", data: JSON_A }],
    after: [{ op: "read_json", path: "intake/raw/a.json", max_bytes: 4096 }],
  },
];

// Deliveries need a directory outside the instance; one is built per run and
// the scenarios name it through this placeholder so the corpus stays literal.
function materialise(scenario: Scenario, root: string, delivery: string): Scenario {
  const swap = (op: Op): Op =>
    typeof op.path === "string"
      ? {
          ...op,
          path: (op.path as string)
            .replace("/DELIVERY", delivery)
            .replace("ROOT", root),
        }
      : op;
  return {
    ...scenario,
    before: (scenario.before ?? []).map(swap),
    locked: (scenario.locked ?? []).map(swap),
    after: (scenario.after ?? []).map(swap),
  };
}

let compared = 0;
let diverged = 0;
let recorded = 0;

const delivery = fs.mkdtempSync("/tmp/atlas-delivery-");
fs.writeFileSync(`${delivery}/batch.json`, '{"format":"atlas-graph","version":1}\n');
fs.mkdirSync(`${delivery}/secrets`);
fs.writeFileSync(`${delivery}/secrets/batch.json`, "{}\n");

for (const scenario of SCENARIOS) {
  // Each side gets its own tree: a shared one would let the first run's
  // writes decide what the second run sees.
  const mineRoot = fs.mkdtempSync("/tmp/atlas-mine-");
  const oracleRoot = fs.mkdtempSync("/tmp/atlas-oracle-");
  for (const root of [mineRoot, oracleRoot]) {
    if (!(scenario.setup ?? []).some((entry) => entry.path === "state")) {
      fs.mkdirSync(`${root}/state`, { recursive: true });
    }
    if (!(scenario.setup ?? []).some((entry) => entry.path === "atlas")) {
      fs.mkdirSync(`${root}/atlas`, { recursive: true });
    }
  }

  const mineScenario = materialise(scenario, mineRoot, delivery);
  const oracleScenario = materialise(scenario, oracleRoot, delivery);

  let mine: Observed;
  try {
    mine = observe(mineScenario, mineRoot);
  } catch (error) {
    console.error(`instance: ${scenario.name}: the port threw outside its contract`);
    console.error(String(error));
    diverged += 1;
    continue;
  }

  // One recorded answer per scenario, with this run's root folded out of both
  // the question and the answer so neither carries a directory that is gone by
  // the next run.
  const question = JSON.stringify({ ...oracleScenario, root: oracleRoot });
  let theirs: Observed;
  try {
    theirs = JSON.parse(
      unfoldRoots(
        oracleAnswer("instance", foldRoots(question, [oracleRoot, delivery])) as string,
        [oracleRoot, delivery],
      ),
    ) as Observed;
  } catch (error) {
    console.error(`instance: ${scenario.name}: the oracle failed`);
    console.error(String(error));
    diverged += 1;
    continue;
  }

  compared += 1;
  const mineText = JSON.stringify(mine, null, 2);
  const theirsText = JSON.stringify(theirs, null, 2);
  if (mineText !== theirsText) {
    if (scenario.oracleDiffers !== undefined) {
      recorded += 1;
    } else {
      diverged += 1;
      console.error(`instance: ${scenario.name}`);
      console.error(`  mine:   ${mineText.replaceAll("\n", "\n          ")}`);
      console.error(`  oracle: ${theirsText.replaceAll("\n", "\n          ")}`);
    }
  }

  fs.rmSync(mineRoot, { recursive: true, force: true });
  fs.rmSync(oracleRoot, { recursive: true, force: true });
}

fs.rmSync(delivery, { recursive: true, force: true });

console.log(
  `instance: ${compared} scenarios compared, ${diverged} unexplained, ${recorded} recorded`,
);
process.exit(diverged === 0 ? 0 : 1);
