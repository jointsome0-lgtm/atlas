import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import {
  AtlasReader,
  ReaderError,
  ReasonCode,
  relativeParts,
  safeDisplay,
} from "./reader.ts";

// The differential harness proves the reader answers what CPython answers.
// What is pinned here is what the oracle cannot express: the one place the two
// deliberately disagree, and the properties that are invisible in a comparison
// of return values — descriptor hygiene, and a read re-walking its path.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/atlas-reader-test-");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const refusal = (run: () => unknown): ReaderError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ReaderError) return error;
    throw error;
  }
  throw new Error("expected the reader to refuse, and it did not");
};

/** How many descriptors this process holds right now. */
const openDescriptors = (): number => fs.readdirSync("/proc/self/fd").length;

describe("a name that is not text", () => {
  test("is refused, where the oracle would invent one", () => {
    // CPython decodes a filename with surrogateescape, so a non-UTF-8 name
    // comes back as a string that is not the name on disk and cannot be
    // written back. Atlas-authored text is UTF-8 (§25.8); a fail-closed
    // reader refuses what it cannot represent rather than repairing it.
    // This is the single recorded divergence from the oracle (#119, #126).
    fs.writeFileSync(`${root}/fine.md`, "ok");
    fs.writeFileSync(
      Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64])]),
      "raw",
    );

    const reader = new AtlasReader(root);
    const error = refusal(() => reader.scan());
    expect(error.reason).toBe(ReasonCode.UnsafePath);
    // The diagnostic names the place without carrying the raw bytes out.
    expect(error.message).toContain("unsafe-path");
    expect(error.relativePath).not.toContain("��");
  });

  test("does not stop a tree that has none", () => {
    fs.writeFileSync(`${root}/fine.md`, "ok");
    expect(new AtlasReader(root).scan().map((f) => f.name)).toEqual(["fine.md"]);
  });
});

describe("descriptors", () => {
  test("are all given back, on the path that succeeds and the one that fails", () => {
    fs.mkdirSync(`${root}/deep`);
    fs.mkdirSync(`${root}/deep/deeper`);
    fs.writeFileSync(`${root}/deep/deeper/leaf.md`, "leaf");
    fs.writeFileSync(`${root}/top.md`, "top");
    fs.symlinkSync(`${root}/top.md`, `${root}/deep/bad`);

    const reader = new AtlasReader(root);
    const before = openDescriptors();

    for (let round = 0; round < 50; round += 1) {
      reader.scan(".", { recursive: false });
      reader.scan("deep/deeper", { recursive: true });
      reader.isDirectory("deep");
      reader.isDirectory("nowhere");
      reader.optionalFile("top.md")?.readBytes();
      reader.optionalFile("nowhere.md");
      expect(() => reader.scan("deep", { recursive: true })).toThrow(ReaderError);
      expect(() => reader.scan("../escape")).toThrow(ReaderError);
    }

    // A leak of one descriptor per round would be 50 by now.
    expect(openDescriptors()).toBe(before);
  });
});

describe("reading a file", () => {
  test("walks the path again instead of trusting an earlier look", () => {
    fs.writeFileSync(`${root}/note.md`, "first");
    const reader = new AtlasReader(root);
    const found = reader.optionalFile("note.md") as NonNullable<
      ReturnType<AtlasReader["optionalFile"]>
    >;

    // The name is replaced by a symlink after it was found and checked. A
    // reader that had kept the descriptor would happily read the old file.
    fs.unlinkSync(`${root}/note.md`);
    fs.writeFileSync(`${root}/elsewhere`, "second");
    fs.symlinkSync(`${root}/elsewhere`, `${root}/note.md`);

    expect(refusal(() => found.readBytes()).reason).toBe(ReasonCode.UnsafePath);
  });

  test("gives back the bytes, not a decoded string", () => {
    fs.writeFileSync(`${root}/bytes.md`, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    const reader = new AtlasReader(root);
    const file = reader.optionalFile("bytes.md") as NonNullable<
      ReturnType<AtlasReader["optionalFile"]>
    >;
    expect([...file.readBytes()]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });

  test("names itself by where it sits under the root", () => {
    fs.mkdirSync(`${root}/a`);
    fs.writeFileSync(`${root}/a/b.md`, "x");
    const file = new AtlasReader(root).scan("a")[0] as NonNullable<
      ReturnType<AtlasReader["scan"]>[number]
    >;
    expect(file.name).toBe("b.md");
    expect(file.relativePath).toBe("a/b.md");
    expect(file.path).toBe(`${root}/a/b.md`);
  });
});

describe("the shape of a relative path", () => {
  test("drops what the oracle's path type drops and refuses the rest", () => {
    expect(relativeParts(".")).toEqual([]);
    expect(relativeParts("")).toEqual([]);
    expect(relativeParts("a/b")).toEqual(["a", "b"]);
    expect(relativeParts("a//b")).toEqual(["a", "b"]);
    expect(relativeParts("a/./b")).toEqual(["a", "b"]);
    expect(relativeParts("a/")).toEqual(["a"]);

    for (const refused of ["/a", "/", "..", "a/../b", "../a", "a/.."]) {
      expect(refusal(() => relativeParts(refused)).reason).toBe(
        ReasonCode.UnsafePath,
      );
    }
  });
});

describe("a diagnostic", () => {
  test("carries no control sequence out to a terminal", () => {
    expect(safeDisplay("plain.md")).toBe("plain.md");
    expect(safeDisplay("with space")).toBe("with space");
    expect(safeDisplay("bellhere")).toBe("bell?here");
    expect(safeDisplay("escapehere")).toBe("escape?here");
    expect(safeDisplay("newline\nhere")).toBe("newline?here");
    expect(safeDisplay("rtl‮here")).toBe("rtl?here");
    expect(safeDisplay("nbsp here")).toBe("nbsp?here");
    // A real character stays, including one outside the basic plane.
    expect(safeDisplay("éclair\u{1F600}")).toBe("éclair\u{1F600}");
  });
});
