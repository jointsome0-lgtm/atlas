import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { JsonInputError, firstInvalidUtf8, readJsonFile } from "./json-input.ts";
import { JOURNALS, journalLines, journalPaths, readJsonl } from "./journal.ts";
import { JOURNAL_ROW_BYTES } from "./instance.ts";
import { AtlasReader, type ScannedFile } from "./reader.ts";
import { SCHEMA_NAMES, loadRegistry } from "./schema-registry.ts";

// The differential proves this layer answers what the Python answers, message
// for message, over 58 trees. What is pinned here is what a comparison of two
// implementations cannot pin: that the reader stays inside its memory bound on
// a journal larger than the bound, that a refusal happens at all where a
// silent pass would also have been agreement, and the one shape this port
// deliberately gives a diagnostic the oracle gives no shape at all.

const ROOTS: string[] = [];

function tree(entries: Record<string, string | Uint8Array>): string {
  const root = fs.mkdtempSync("/tmp/atlas-journal-test-");
  ROOTS.push(root);
  for (const [path, content] of Object.entries(entries)) {
    const full = `${root}/${path}`;
    fs.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const file = (root: string, path: string): ScannedFile =>
  new AtlasReader(root).optionalFile(path) as ScannedFile;

afterAll(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

describe("a journal larger than memory", () => {
  test("has not read past the first chunk when it yields the first row", () => {
    // The laziness is the memory bound, and it is asserted by observation
    // rather than by measurement: a byte past the first read is changed while
    // the generator is suspended, and the reader is asked what it finds
    // there. A reader that had slurped the file would answer with the old
    // bytes. Measuring the process instead would prove nothing here — under
    // Bun a typed array is invisible to `heapUsed`, and `rss` is dominated by
    // the churn of the rows themselves, which a chunked reader also produces.
    const READ = 8_192;
    const first = '{"id":"first"}\n';
    const filler = `{"id":"${"f".repeat(READ - first.length - 10)}"}\n`;
    const root = tree({
      "state/artifacts.jsonl": `${first}${filler}{"id":"aaaaaaaa"}\n`,
    });
    const path = `${root}/state/artifacts.jsonl`;
    expect(first.length + filler.length).toBe(READ);

    const rows = journalLines(file(root, "state/artifacts.jsonl"));
    expect(new TextDecoder().decode(rows.next().value?.raw)).toBe(
      '{"id":"first"}',
    );

    const handle = fs.openSync(path, "r+");
    fs.writeSync(handle, Buffer.from('{"id":"bbbbbbbb"}'), 0, 17, READ);
    fs.closeSync(handle);

    const rest = [...rows].map((line) => new TextDecoder().decode(line.raw));
    expect(rest[rest.length - 1]).toBe('{"id":"bbbbbbbb"}');
  });

  test("yields every row of a journal far past any single buffer", () => {
    // Twelve thousand rows of a kilobyte each. Nothing here is a memory
    // claim — it is that the chunking arithmetic still gets every row out,
    // exactly once and unmangled, over a file that is many reads long.
    const row = `{"id":"${"x".repeat(1000)}"}\n`;
    const root = tree({ "state/artifacts.jsonl": "" });
    const path = `${root}/state/artifacts.jsonl`;
    const handle = fs.openSync(path, "a");
    for (let batch = 0; batch < 12; batch += 1) {
      fs.writeFileSync(handle, row.repeat(1_000));
    }
    fs.closeSync(handle);
    expect(fs.statSync(path).size).toBeGreaterThan(12_000_000);

    let counted = 0;
    let peak = 0;
    let mangled = 0;
    for (const line of journalLines(file(root, "state/artifacts.jsonl"))) {
      counted += 1;
      peak = Math.max(peak, line.raw.length);
      if (line.oversized || line.raw.length !== row.length - 1) mangled += 1;
    }
    expect([counted, peak, mangled]).toEqual([12_000, row.length - 1, 0]);
  });

  test("refuses an over-long row without buffering the rest of it", () => {
    const huge = `{"id":"${"x".repeat(4_000_000)}"}\n`;
    const root = tree({ "state/artifacts.jsonl": `${huge}{"id":"after"}\n` });
    const lines = [...journalLines(file(root, "state/artifacts.jsonl"))];
    expect(lines.map((line) => [line.number, line.oversized])).toEqual([
      [1, true],
      [2, false],
    ]);
    // Nothing of the refused row is carried out — §24.4 has no reason to let
    // four megabytes of unvalidated input reach a diagnostic.
    expect(lines[0]?.raw.length).toBe(0);
    expect(new TextDecoder().decode(lines[1]?.raw)).toBe('{"id":"after"}');
  });

  test("names the row and the ceiling when a caller wanted values", () => {
    const huge = `{"id":"${"x".repeat(JOURNAL_ROW_BYTES)}"}\n`;
    const root = tree({ "state/artifacts.jsonl": `{"id":"a"}\n${huge}` });
    const rows = readJsonl(file(root, "state/artifacts.jsonl"));
    expect(rows.next().value?.number).toBe(1);
    expect(() => rows.next()).toThrow(
      new RegExp(`:2: journal row exceeds ${JOURNAL_ROW_BYTES} bytes$`),
    );
  });
});

describe("journal order", () => {
  test("is every rotation in name order, then the live tail", () => {
    // §20.1 is a fold order, not a listing: a rotation read after the tail
    // would replay old state over new and the graph would silently regress.
    const root = tree({
      "state/artifacts/0002.jsonl": "",
      "state/artifacts/0010.jsonl": "",
      "state/artifacts/0001.jsonl": "",
      "state/artifacts.jsonl": "",
    });
    expect(
      journalPaths(new AtlasReader(root), "artifacts").map((p) => p.relativePath),
    ).toEqual([
      "state/artifacts/0001.jsonl",
      "state/artifacts/0002.jsonl",
      "state/artifacts/0010.jsonl",
      "state/artifacts.jsonl",
    ]);
  });

  test("covers every journal the state layer defines", () => {
    // A journal absent from this map is a journal nothing validates.
    const root = tree(
      Object.fromEntries(
        [...JOURNALS.keys()].map((stem) => [`state/${stem}.jsonl`, ""]),
      ),
    );
    const reader = new AtlasReader(root);
    for (const stem of JOURNALS.keys()) {
      expect(journalPaths(reader, stem).map((p) => p.relativePath)).toEqual([
        `state/${stem}.jsonl`,
      ]);
    }
  });
});

describe("a malformed UTF-8 sequence", () => {
  test("is located at its leading byte, not at the byte that gave it away", () => {
    // The continuation is what fails; the sequence is what is wrong. A
    // diagnostic pointing at the continuation would point one byte past the
    // character a person has to go and fix.
    expect(firstInvalidUtf8(Uint8Array.from([0x61, 0xc3, 0x28]))).toBe(1);
    expect(firstInvalidUtf8(Uint8Array.from([0x61, 0xff]))).toBe(1);
    expect(firstInvalidUtf8(Uint8Array.from([0x61, 0xe2, 0x82]))).toBe(1);
  });

  test("is not found in text that is merely not ASCII", () => {
    const encoded = new TextEncoder().encode("héllo — 日本語 ✓ 𝄞");
    expect(firstInvalidUtf8(encoded)).toBe(null);
    expect(firstInvalidUtf8(new Uint8Array(0))).toBe(null);
  });

  test("covers the encodings a decoder is most often lax about", () => {
    // Each of these decodes to something under a permissive decoder, and each
    // is a distinct way to smuggle a byte sequence past a check that ran on
    // the decoded text instead of the bytes.
    const cases: ReadonlyArray<readonly [string, readonly number[]]> = [
      ["an overlong solidus", [0xc0, 0xaf]],
      ["an overlong NUL", [0xe0, 0x80, 0x80]],
      ["a lone high surrogate", [0xed, 0xa0, 0x80]],
      ["a lone low surrogate", [0xed, 0xb0, 0x80]],
      ["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
      ["a five-byte sequence", [0xf8, 0x88, 0x80, 0x80, 0x80]],
      ["a bare continuation", [0x80]],
      ["0xC1, which can never lead", [0xc1, 0x81]],
    ];
    for (const [name, sequence] of cases) {
      expect(
        `${name}: ${firstInvalidUtf8(Uint8Array.from(sequence))}`,
      ).toBe(`${name}: 0`);
    }
  });
});

describe("a schema registry", () => {
  test("names the file when a schema is not an object at all", () => {
    // The oracle reaches `.get` on the value and reports CPython's
    // AttributeError, which says the type and not the file. Twenty-five
    // schemas load here; a message that names none of them is not usable.
    const root = tree(
      Object.fromEntries(
        [...SCHEMA_NAMES].map((name) => [
          `spec/schemas/${name}.schema.json`,
          name === "probe"
            ? "[]"
            : JSON.stringify({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                $id: `https://atlas-sdd.local/schemas/${name}.schema.json`,
                type: "object",
              }),
        ]),
      ),
    );
    const { schemas, errors } = loadRegistry(root);
    expect(errors).toEqual([
      `${root}/spec/schemas/probe.schema.json: schema must be a JSON object`,
    ]);
    expect(schemas.has("probe")).toBe(false);
    expect(schemas.size).toBe(SCHEMA_NAMES.size - 1);
  });

  test("keeps loading after one schema fails", () => {
    // A preflight that stopped at the first bad schema would make the owner
    // fix them one run at a time.
    const root = tree(
      Object.fromEntries(
        [...SCHEMA_NAMES].map((name) => [
          `spec/schemas/${name}.schema.json`,
          name === "probe" || name === "zone"
            ? "{"
            : JSON.stringify({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                $id: `https://atlas-sdd.local/schemas/${name}.schema.json`,
                type: "object",
              }),
        ]),
      ),
    );
    const { schemas, errors } = loadRegistry(root);
    expect(errors.length).toBe(2);
    expect(schemas.size).toBe(SCHEMA_NAMES.size - 2);
  });

  test("reports an absent directory rather than an empty registry", () => {
    const { schemas, errors } = loadRegistry(tree({ "atlas/.keep": "" }));
    expect(schemas.size).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("schema inventory mismatch");
  });

  test("loads the registry this repository actually ships", () => {
    // The one case no synthetic tree covers: canon as authored.
    const { schemas, errors } = loadRegistry(`${import.meta.dir}/../../..`);
    expect(errors).toEqual([]);
    expect(new Set(schemas.keys())).toEqual(SCHEMA_NAMES as Set<string>);
  });
});

describe("a document with no line to report", () => {
  test("gets a message without one rather than a made-up first line", () => {
    // A duplicate key is found by a rule that never knew where it was
    // reading. Printing `:1:` would be a location, and it would be wrong.
    const root = tree({ "atlas/a.json": '{\n"a":1,\n"a":2\n}\n' });
    let message = "";
    try {
      readJsonFile(file(root, "atlas/a.json"));
    } catch (error) {
      message = (error as JsonInputError).message;
    }
    expect(message).toBe(
      `${root}/atlas/a.json: duplicate-json-key; expected unique object keys`,
    );
  });

  test("still gets one when the document was merely malformed", () => {
    const root = tree({ "atlas/b.json": '{\n"a": 1,\n"b" 2\n}\n' });
    let message = "";
    try {
      readJsonFile(file(root, "atlas/b.json"));
    } catch (error) {
      message = (error as JsonInputError).message;
    }
    expect(message).toStartWith(`${root}/atlas/b.json:3: invalid JSON: `);
  });
});
