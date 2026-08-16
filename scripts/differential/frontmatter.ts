import { readdirSync, readFileSync, statSync } from "node:fs";
import { oracleAnswer } from "./oracle.ts";

import { join } from "node:path";

import { stringifyRow } from "../src/boundary/canonical-json.ts";
import {
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
} from "../src/boundary/frontmatter.ts";

// Compares the ported §20.4 grammar against the reference parser on three
// axes at once: whether a document is accepted, the exact diagnostic when it
// is not, and the parsed value when it is. A grammar this closed is defined
// as much by what it refuses as by what it returns, so an accept/reject-only
// comparison would miss a parser that refuses the right documents for the
// wrong reason — and the message is what a caller sees.

interface Case {
  readonly label: string;
  readonly source: string;
  readonly bytes: Uint8Array;
}

const cases: Case[] = [];
const encoder = new TextEncoder();

function add(label: string, text: string, source = "<bytes>"): void {
  cases.push({ label, source, bytes: encoder.encode(text) });
}

function addBytes(label: string, bytes: number[], source = "<bytes>"): void {
  cases.push({ label, source, bytes: Uint8Array.from(bytes) });
}

function fenced(body: string): string {
  return `---\n${body}\n---\nbody text\n`;
}

// ---- documents the grammar accepts -----------------------------------------

add("minimal", fenced("id: a"));
add("several scalars", fenced("id: a\nkind: concept\nfield: knowledge"));
add("quoted scalar", fenced('id: "a b"\ntitle: "quoted \\"inner\\" text"'));
add("empty string scalar", fenced('id: ""'));
add("empty sequence scalar", fenced("tags: []"));
add("scalar sequence", fenced("tags:\n  - one\n  - two"));
add("mapping sequence", fenced("items:\n  - id: a\n    kind: concept\n  - id: b\n    kind: concept"));
add("nested mapping", fenced("outer:\n  inner:\n    leaf: value"));
add("folded text", fenced("note: >\n  first line\n  second line"));
add("folded then sibling", fenced("note: >\n  folded\nother: value"));
add("folded with comment", fenced("note: >\n  first\n  # not a comment marker at parse\n  second"));
add("comments and blanks", fenced("# leading\n\nid: a\n\n# trailing"));
add("unicode scalar", fenced("title: привет мир 🜂"));
add("value with colon", fenced("note: a: b"));
add("value with hash", fenced("note: a # b"));
add("key with underscore and dash", fenced("a_b-c: value"));
add("deep but legal nesting", fenced("a:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g: leaf"));
add("no body after fence", "---\nid: a\n---\n");
add("body absent entirely", "---\nid: a\n---");

// ---- keys that a JavaScript object treats as more than keys ------------------
// `__proto__` satisfies the key grammar, so a document may carry it. On a plain
// `{}` it is an accessor rather than a member: the field disappears and the
// values under it become the prototype every later lookup falls back to. The
// oracle's dict has no such corner, which is precisely why these are compared.

add("proto key alone", fenced("__proto__: value"));
add("proto key beside a real one", fenced("id: a\n__proto__: value"));
add("proto key carrying a mapping", fenced("__proto__:\n  sensitivity: medical"));
add("proto key nested", fenced("outer:\n  __proto__: value"));
add("proto key in a sequence item", fenced("items:\n  - __proto__: value"));
add("proto key twice", fenced("__proto__: a\n__proto__: b"));
add("proto key and a near miss", fenced("__proto__: a\n__proto__x: b\nproto: c"));
add("constructor key", fenced("constructor: value"));
add("prototype key", fenced("prototype: value"));
add("object method names as keys", fenced("toString: a\nvalueOf: b\nhasOwnProperty: c"));

// ---- the strip-set traps ----------------------------------------------------
// Python's str.strip() removes U+0085 and U+00A0 but not U+FEFF; JavaScript's
// trim() does the reverse. Each of these decides whether a scalar keeps a
// character or loses it, so they are compared rather than reasoned about.

add("scalar padded with NBSP", fenced("note: \u00a0value\u00a0"));
add("scalar padded with NEL", fenced("note: \u0085value\u0085"));
add("scalar padded with ZWNBSP", fenced("note: \ufeffvalue\ufeff"));
add("scalar padded with ideographic space", fenced("note: \u3000value\u3000"));
add("scalar padded with en quad", fenced("note: \u2000value\u2000"));
add("scalar of only NBSP", fenced("note: \u00a0"));
add("scalar of only ZWNBSP", fenced("note: \ufeff"));
add("zero-width space is not whitespace", fenced("note: \u200bvalue\u200b"));
add("folded line padded with NBSP", fenced("note: >\n  \u00a0folded\u00a0"));
add("sequence entry padded with NBSP", fenced("tags:\n  - \u00a0value\u00a0"));
add("nested-sequence probe with NBSP", fenced("tags:\n  - \u00a0[]\u00a0"));

// ---- refusals ---------------------------------------------------------------

add("no opening fence", "id: a\n");
add("opening fence with trailing space", "--- \nid: a\n---\n");
add("missing closing fence", "---\nid: a\n");
add("empty frontmatter", "---\n---\n");
add("only comments", fenced("# just a comment"));
add("top level indented", "---\n  id: a\n---\n");
add("odd indentation", fenced("outer:\n   inner: value"));
add("over-indented nested value", fenced("outer:\n    inner: value"));
add("bare key without container", fenced("outer:"));
add("bare key then sibling", fenced("outer:\nother: value"));
add("duplicate key", fenced("id: a\nid: b"));
add("duplicate key nested", fenced("outer:\n  a: 1\n  a: 2"));
add("mixed mapping and sequence", fenced("id: a\n- item"));
add("bare sequence marker", fenced("tags:\n  -"));
add("mixed sequence item kinds", fenced("tags:\n  - one\n  - id: a"));
add("mixed sequence item kinds reversed", fenced("tags:\n  - id: a\n  - one"));
add("nested sequence", fenced("tags:\n  - []"));
add("empty scalar", fenced("id:  "));
add("single quoted", fenced("id: 'a'"));
add("literal block", fenced("id: |"));
add("folded chomping", fenced("id: >-"));
add("flow mapping", fenced("id: {a: b}"));
add("flow sequence", fenced("id: [a, b]"));
add("anchor", fenced("id: &anchor"));
add("alias", fenced("id: *alias"));
add("tag", fenced("id: !!str x"));
add("directive value", fenced("id: %YAML"));
add("merge key", fenced("id: <<"));
add("merge key colon", fenced("id: <<: x"));
add("document marker scalar", fenced("id: ---"));
add("document end scalar", fenced("id: ..."));
add("bad quoted escape", fenced('id: "bad \\q escape"'));
add("quoted decoding to non-string", fenced('id: "a" extra'));
add("lone surrogate escape", fenced('id: "\\ud800"'));
add("key starting with digit", fenced("1key: value"));
add("key with space", fenced("a key: value"));
add("colon without space", fenced("id:value"));
add("too deep nesting", fenced("a:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g:\n              h: leaf"));
add("blank folded continuation", fenced("note: >\n  first\n\n  second"));
add("folded with no continuation", fenced("note: >\nother: value"));
add("folded over-indented", fenced("note: >\n    first"));
add("unexpected trailing content", fenced("id: a\n\nsecond: b\n"));

// ---- byte-level refusals ----------------------------------------------------

addBytes("utf-8 BOM", [0xef, 0xbb, 0xbf, ...encoder.encode("---\nid: a\n---\n")]);
addBytes("CR in region", [...encoder.encode("---\nid: a\r\n---\n")]);
addBytes("CR in body", [...encoder.encode("---\nid: a\n---\nbody\r\n")]);
addBytes("tab in region", [...encoder.encode("---\nid:\ta\n---\n")]);
addBytes("NUL in region", [...encoder.encode("---\nid: a"), 0x00, ...encoder.encode("\n---\n")]);
addBytes("C0 control in region", [...encoder.encode("---\nid: a"), 0x01, ...encoder.encode("\n---\n")]);
addBytes("bare continuation byte in region", [...encoder.encode("---\nid: "), 0x80, ...encoder.encode("\n---\n")]);
addBytes("truncated sequence in region", [...encoder.encode("---\nid: "), 0xe2, 0x82, ...encoder.encode("\n---\n")]);
addBytes("overlong encoding in region", [...encoder.encode("---\nid: "), 0xc0, 0x80, ...encoder.encode("\n---\n")]);
addBytes("surrogate encoding in region", [...encoder.encode("---\nid: "), 0xed, 0xa0, 0x80, ...encoder.encode("\n---\n")]);
addBytes("out of range lead in region", [...encoder.encode("---\nid: "), 0xf5, 0x80, 0x80, 0x80, ...encoder.encode("\n---\n")]);
addBytes("invalid utf-8 in body", [...encoder.encode("---\nid: a\n---\nbody "), 0xff, 0x0a]);
addBytes("invalid utf-8 later in body", [...encoder.encode("---\nid: a\n---\nline one\nline two "), 0xc3, 0x28, 0x0a]);
addBytes("tab in body is allowed", [...encoder.encode("---\nid: a\n---\nbody\twith tab\n")]);

// ---- ceilings ---------------------------------------------------------------

add("line at the ceiling", fenced(`note: ${"x".repeat(4_096 - 6)}`));
add("line over the ceiling", fenced(`note: ${"x".repeat(4_096)}`));
add("scalar over the ceiling", fenced(`note: ${"x".repeat(8_193)}`));
add("too many fields", fenced(
  Array.from({ length: 65 }, (_, i) => `k${i}: v`).join("\n"),
));
add("fields at the ceiling", fenced(
  Array.from({ length: 64 }, (_, i) => `k${i}: v`).join("\n"),
));
add("too many sequence entries", fenced(
  "tags:\n" + Array.from({ length: 1_025 }, (_, i) => `  - v${i}`).join("\n"),
));
add("frontmatter over the document ceiling", fenced(
  Array.from({ length: 2_000 }, (_, i) => `k${i}: ${"v".repeat(70)}`).join("\n"),
));

// ---- source labelling -------------------------------------------------------

add("named source in diagnostic", "---\nid: a\n", "atlas/concepts/a.md");
add("named source accepted", fenced("id: a"), "atlas/concepts/a.md");

// ---- the repository's own documents -----------------------------------------
// Hand-written cases probe the edges; these prove the parser on the corpus the
// project actually has, where a subtle regression would otherwise surface only
// as a failed build much later.

function collectMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) collectMarkdown(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
}

const fixtures: string[] = [];
collectMarkdown("fixtures", fixtures);
fixtures.sort();
for (const path of fixtures) {
  cases.push({
    label: `fixture ${path}`,
    source: path,
    bytes: new Uint8Array(readFileSync(path)),
  });
}

// ---- comparison -------------------------------------------------------------

interface Outcome {
  ok: boolean;
  value?: string;
  error?: string;
}

interface OracleEntry {
  frontmatter: Outcome;
  document: Outcome;
  body: Outcome;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// `validate_atlas check-constants` ties the reference parser's ceilings to the
// schemas. Nothing ties this copy to either, so the values are compared here
// directly rather than only through the behaviour a few of them govern.
const CONSTANTS: Record<string, number> = {
  MAX_DOCUMENT_BYTES,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_SCALAR_BYTES,
  MAX_DEPTH,
  MAX_FIELDS,
  MAX_SEQUENCE_ENTRIES,
  MAX_NODES,
};

const payload = JSON.stringify({
  cases: cases.map((entry) => ({
    data: toBase64(entry.bytes),
    source: entry.source,
  })),
  constants: Object.keys(CONSTANTS),
});

const parsed = oracleAnswer("frontmatter", payload) as {
  cases: OracleEntry[];
  constants: Record<string, number>;
};
const oracle = parsed.cases;

let divergences = 0;
let compared = 0;

function run(fn: () => unknown): Outcome {
  try {
    const value = fn();
    return { ok: true, value: stringifyRow(value) };
  } catch (err) {
    if (err instanceof FrontmatterError) return { ok: false, error: err.message };
    return {
      ok: false,
      error: `UNEXPECTED ${(err as Error).constructor.name}: ${String(err)}`,
    };
  }
}

function compare(label: string, actual: Outcome, wanted: Outcome): void {
  compared += 1;
  const same = actual.ok === wanted.ok &&
    (actual.ok ? actual.value === wanted.value : actual.error === wanted.error);
  if (!same) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}`);
    console.error(`  oracle: ${JSON.stringify(wanted)}`);
    console.error(`  ours:   ${JSON.stringify(actual)}`);
  }
}

for (let i = 0; i < cases.length; i += 1) {
  const entry = cases[i]!;
  const expected = oracle[i]!;
  compare(
    `parse_frontmatter ${entry.label}`,
    run(() => parseFrontmatter(entry.bytes, entry.source)),
    expected.frontmatter,
  );
  compare(
    `parse_document ${entry.label}`,
    run(() => parseDocument(entry.bytes, entry.source)),
    expected.document,
  );
  compared += 1;
  let body: string | null = null;
  try {
    body = frontmatterBody(entry.bytes);
  } catch {
    body = null;
  }
  const wantedBody = expected.body.ok ? expected.body.value : null;
  if (body !== wantedBody) {
    divergences += 1;
    console.error(`DIVERGENCE frontmatter_body ${entry.label}`);
    console.error(`  oracle: ${JSON.stringify(wantedBody)}`);
    console.error(`  ours:   ${JSON.stringify(body)}`);
  }
}

for (const [name, ours] of Object.entries(CONSTANTS)) {
  compared += 1;
  const wanted = parsed.constants[name];
  if (ours !== wanted) {
    divergences += 1;
    console.error(`DIVERGENCE constant ${name}`);
    console.error(`  oracle: ${wanted}`);
    console.error(`  ours:   ${ours}`);
  }
}

console.log(
  `differential frontmatter: ${cases.length} documents, ` +
    `${compared} comparisons, ${divergences} divergences ` +
    `(${fixtures.length} from fixtures/)`,
);
process.exit(divergences === 0 ? 0 : 1);
