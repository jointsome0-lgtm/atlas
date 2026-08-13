import { describe, expect, test } from "bun:test";

import {
  firstInvalidUtf8Offset,
  FrontmatterError,
  frontmatterBody,
  MAX_DEPTH,
  MAX_DOCUMENT_BYTES,
  MAX_FIELDS,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_NODES,
  MAX_SCALAR_BYTES,
  MAX_SEQUENCE_ENTRIES,
  parseDocument,
  parseFrontmatter,
} from "./frontmatter.ts";

// The differential harness proves this grammar against the reference parser
// over 106 documents, the repository's own fixtures included. What is pinned
// here is the contract that survives the reference parser's deletion: the
// ceilings, the shape of the public entry points, and the closure properties
// §20.4 exists to state.

const bytes = (text: string) => new TextEncoder().encode(text);
const fenced = (body: string) => bytes(`---\n${body}\n---\nbody\n`);

describe("ceilings", () => {
  test("carry the values the schemas fix", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(131_072);
    expect(MAX_FILE_BYTES).toBe(262_144);
    expect(MAX_LINE_BYTES).toBe(4_096);
    expect(MAX_SCALAR_BYTES).toBe(8_192);
    expect(MAX_DEPTH).toBe(8);
    expect(MAX_FIELDS).toBe(64);
    expect(MAX_SEQUENCE_ENTRIES).toBe(1_024);
    expect(MAX_NODES).toBe(16_384);
  });
});

describe("parseFrontmatter", () => {
  test("returns the mapping for a well-formed document", () => {
    expect(parseFrontmatter(fenced("id: a\nkind: concept"))).toEqual({
      id: "a",
      kind: "concept",
    });
  });

  test("reads sequences, nesting and folded text", () => {
    expect(
      parseFrontmatter(fenced("tags:\n  - one\n  - two\nnote: >\n  a\n  b")),
    ).toEqual({ tags: ["one", "two"], note: "a b" });
  });

  test("names the source and line in every diagnostic", () => {
    expect(() => parseFrontmatter(fenced("id: a\nid: b"), "atlas/a.md")).toThrow(
      "atlas/a.md: frontmatter line 3: duplicate-key; expected unique mapping keys",
    );
  });
});

describe("the grammar is closed", () => {
  // Each of these is valid YAML that a general parser would happily accept and
  // hand back as a different type or a different value. §20.4 refuses them so
  // that a document means one thing; that refusal is the feature.
  const refused: [string, string][] = [
    ["flow mapping", "id: {a: b}"],
    ["flow sequence", "id: [a, b]"],
    ["anchor", "id: &a"],
    ["alias", "id: *a"],
    ["tag", "id: !!str x"],
    ["merge key", "id: <<"],
    ["single quotes", "id: 'a'"],
    ["literal block", "id: |"],
    ["second document", "id: ..."],
    ["tab indentation", "outer:\n\tinner: v"],
  ];
  for (const [label, body] of refused) {
    test(`refuses ${label}`, () => {
      expect(() => parseFrontmatter(fenced(body))).toThrow(FrontmatterError);
    });
  }

  test("returns strings, never inferred types", () => {
    // A YAML library would give back 1, true, None and a sexagesimal here.
    // Everything unquoted is a string, so `no` cannot silently become false.
    expect(
      parseFrontmatter(fenced("a: 1\nb: true\nc: null\nd: no\ne: 1:30")),
    ).toEqual({ a: "1", b: "true", c: "null", d: "no", e: "1:30" });
  });

  test("the only empty collection is an explicit []", () => {
    expect(parseFrontmatter(fenced("tags: []"))).toEqual({ tags: [] });
    expect(() => parseFrontmatter(fenced("tags:  "))).toThrow(
      /empty scalar must be written/,
    );
  });
});

describe("byte-level refusals", () => {
  test("rejects a BOM, CR, and an unterminated block", () => {
    expect(() => parseFrontmatter(bytes("﻿---\nid: a\n---\n"))).toThrow(
      /BOM is unsupported/,
    );
    expect(() => parseFrontmatter(bytes("---\nid: a\r\n---\n"))).toThrow(
      /CR\/CRLF is unsupported/,
    );
    expect(() => parseFrontmatter(bytes("---\nid: a\n"))).toThrow(
      /missing closing fence/,
    );
  });

  test("rejects a lone surrogate written as an escape", () => {
    expect(() => parseFrontmatter(fenced('id: "\\ud800"'))).toThrow(
      /unsupported Unicode surrogate/,
    );
  });
});

describe("firstInvalidUtf8Offset", () => {
  // The offset is what names the offending line, and TextDecoder does not
  // report one. Each case is a distinct way to be invalid.
  test("accepts valid input at every width", () => {
    expect(firstInvalidUtf8Offset(bytes("aé日🜂"))).toBe(-1);
    expect(firstInvalidUtf8Offset(new Uint8Array())).toBe(-1);
  });

  test("reports the lead byte of the invalid sequence", () => {
    const at = (...list: number[]) => firstInvalidUtf8Offset(Uint8Array.from(list));
    expect(at(0x61, 0x80)).toBe(1); // bare continuation byte
    expect(at(0x61, 0xc0, 0x80)).toBe(1); // overlong two-byte
    expect(at(0x61, 0xed, 0xa0, 0x80)).toBe(1); // encoded surrogate
    expect(at(0x61, 0xf5, 0x80, 0x80, 0x80)).toBe(1); // beyond U+10FFFF
    expect(at(0x61, 0xe2, 0x82)).toBe(1); // truncated at end of input
    expect(at(0x61, 0xe0, 0x80, 0x80)).toBe(1); // overlong three-byte
  });
});

describe("frontmatterBody", () => {
  test("returns what follows the closing fence", () => {
    expect(frontmatterBody(bytes("---\nid: a\n---\nbody text\n"))).toBe(
      "body text\n",
    );
  });

  test("is empty when nothing follows", () => {
    expect(frontmatterBody(bytes("---\nid: a\n---\n"))).toBe("");
    expect(frontmatterBody(bytes("---\nid: a\n---"))).toBe("");
  });
});

describe("parseDocument", () => {
  test("reads a fence-less mapping", () => {
    expect(parseDocument(bytes("id: a\nkind: concept\n"))).toEqual({
      id: "a",
      kind: "concept",
    });
  });

  test("refuses fences and directives", () => {
    expect(() => parseDocument(bytes("---\nid: a\n"))).toThrow(
      /fences and multiple documents are unsupported/,
    );
    expect(() => parseDocument(bytes("%YAML 1.2\nid: a\n"))).toThrow(
      /directives are unsupported/,
    );
  });
});
