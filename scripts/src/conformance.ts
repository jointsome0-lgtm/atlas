// The frontmatter grammar's own conformance suite (§20.4, §25.8).
//
// Two halves. On disk, `fixtures/grammar/accept` holds a document beside the
// JSON it must parse to and `fixtures/grammar/reject` holds one that must be
// refused — those are reviewable, and a reader can see what the grammar admits
// by opening them. The ceilings cannot be reviewable: a fixture one byte over
// a 256 KiB file limit is a quarter of a megabyte of `x` in the repository, so
// those are generated from the limit itself and named in a manifest. Every
// ceiling has a pair — one case at the limit that must parse and one past it
// that must not — because a generator that drifted from its ceiling would
// otherwise produce two cases that both pass and prove nothing.
//
// Ported from run_conformance in scripts/validate_atlas.py.

import { sameJson, show } from "./checks.ts";
import {
  FrontmatterError,
  MAX_DOCUMENT_BYTES,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_NODES,
  MAX_SCALAR_BYTES,
  MAX_SEQUENCE_ENTRIES,
  type FrontmatterMapping,
  type FrontmatterValue,
  parseFrontmatter,
} from "./frontmatter.ts";
import { JsonInputError, readJsonFile } from "./json-input.ts";
import { AtlasReader, ReaderError, type ScannedFile } from "./reader.ts";

const encoder = new TextEncoder();

const bytes = (text: string): Uint8Array => encoder.encode(text);

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** `count` copies of one byte — the padding every size case is made of. */
const fill = (byte: number, count: number): Uint8Array =>
  new Uint8Array(count).fill(byte);

const X = 0x78;

/**
 * `size` bytes of comment lines, none of them over the line ceiling.
 *
 * A line is shortened by one byte when the remainder would be exactly one,
 * because a single leftover byte can only be spelled as a bare newline and a
 * comment line needs at least two.
 *
 * That shortening never happens at the ceilings as they stand: it needs a
 * padding length of 4098 or 8195, and the document ceiling asks for 131059
 * and 131060. It is kept because it is a property of the rule and not of
 * today's numbers — move the document ceiling and it starts mattering — but
 * nothing in the suite can observe it, so no corpus case claims to.
 */
function paddingLines(size: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let left = size;
  while (left > 0) {
    if (left === 1) {
      parts.push(bytes("\n"));
      break;
    }
    let take = Math.min(left, MAX_LINE_BYTES + 1);
    if (left - take === 1) take -= 1;
    parts.push(join([bytes("#"), fill(X, take - 2), bytes("\n")]));
    left -= take;
  }
  return join(parts);
}

/** A fenced document of exactly `total` bytes. */
function sizedFenced(total: number): Uint8Array {
  const start = bytes("---\nx: y\n");
  const end = bytes("---\n");
  return join([start, paddingLines(total - start.length - end.length), end]);
}

/** A folded scalar of exactly `size` bytes, spread over lines that fit. */
function foldedScalar(size: number): Uint8Array {
  const remaining = size - 2;
  const lengths = [
    Math.min(4_094, remaining),
    Math.min(4_094, Math.max(0, remaining - 4_094)),
  ];
  lengths.push(remaining - (lengths[0] as number) - (lengths[1] as number));
  return join([
    bytes("---\nx: >\n"),
    ...lengths.map((length) => join([bytes("  "), fill(X, length), bytes("\n")])),
    bytes("---\n"),
  ]);
}

/** A mapping nested `depth` deep. */
function nested(depth: number): Uint8Array {
  let body = "";
  for (let index = 0; index < depth; index += 1) {
    const suffix = index === depth - 1 ? " x" : "";
    body += `${"  ".repeat(index)}a${index}:${suffix}\n`;
  }
  return bytes(`---\n${body}---\n`);
}

/** A mapping with `count` fields. */
function fields(count: number): Uint8Array {
  let body = "";
  for (let index = 0; index < count; index += 1) body += `f${index}: x\n`;
  return bytes(`---\n${body}---\n`);
}

/** One sequence with `count` entries. */
const sequence = (count: number): Uint8Array =>
  bytes(`---\nitems:\n${"  - x\n".repeat(count)}---\n`);

/**
 * A document that reaches the node ceiling, or steps one node past it.
 *
 * The count is what the parser builds rather than what the text looks like: a
 * sequence costs one node for itself plus one per entry. Fifteen full
 * sequences and a last one carrying the remainder is the only shape that fits,
 * because spelling the same node count as separate fields would need more
 * fields than the field ceiling allows.
 */
function nodeCase(over: boolean): [Uint8Array, FrontmatterMapping] {
  const fullSequences = 15;
  const finalEntries =
    MAX_NODES - 1 - fullSequences * (1 + MAX_SEQUENCE_ENTRIES) - 1 + (over ? 1 : 0);
  const counts = [
    ...(Array<number>(fullSequences).fill(MAX_SEQUENCE_ENTRIES)),
    finalEntries,
  ];
  const parsed: FrontmatterMapping = {};
  let text = "";
  counts.forEach((count, index) => {
    const key = `s${index}`;
    parsed[key] = Array<FrontmatterValue>(count).fill("x");
    text += `${key}:\n${"  - x\n".repeat(count)}`;
  });
  return [bytes(`---\n${text}---\n`), parsed];
}

/** Every generator the manifest may name, in the order the ceilings are declared. */
export const GENERATORS: readonly string[] = [
  "bom",
  "crlf",
  "invalid-utf8",
  "tab",
  "nul",
  "c0",
  "document-at-limit",
  "document-over-limit",
  "file-at-limit",
  "file-over-limit",
  "line-at-limit",
  "line-over-limit",
  "scalar-at-limit",
  "scalar-over-limit",
  "depth-at-limit",
  "depth-over-limit",
  "fields-at-limit",
  "fields-over-limit",
  "sequence-at-limit",
  "sequence-over-limit",
  "nodes-at-limit",
  "nodes-over-limit",
];

/** The generated case a manifest entry names: its bytes, and what it parses to. */
export function generatedCase(name: string): [Uint8Array, FrontmatterMapping | null] {
  if (name === "nodes-at-limit") return nodeCase(false);
  if (name === "nodes-over-limit") return [nodeCase(true)[0], null];
  const valid = bytes("---\nx: y\n---\n");
  const xy: FrontmatterMapping = { x: "y" };
  const cases: Record<string, [Uint8Array, FrontmatterMapping | null]> = {
    bom: [join([new Uint8Array([0xef, 0xbb, 0xbf]), valid]), null],
    crlf: [bytes("---\r\nx: y\r\n---\r\n"), null],
    "invalid-utf8": [
      join([bytes("---\nx: "), new Uint8Array([0xff]), bytes("\n---\n")]),
      null,
    ],
    tab: [bytes("---\nx:\n\t- y\n---\n"), null],
    nul: [
      join([bytes("---\nx: a"), new Uint8Array([0x00]), bytes("b\n---\n")]),
      null,
    ],
    c0: [
      join([bytes("---\nx: a"), new Uint8Array([0x01]), bytes("b\n---\n")]),
      null,
    ],
    "document-at-limit": [sizedFenced(MAX_DOCUMENT_BYTES), xy],
    "document-over-limit": [sizedFenced(MAX_DOCUMENT_BYTES + 1), null],
    "file-at-limit": [join([valid, fill(X, MAX_FILE_BYTES - valid.length)]), xy],
    "file-over-limit": [
      join([valid, fill(X, MAX_FILE_BYTES + 1 - valid.length)]),
      null,
    ],
    "line-at-limit": [
      join([bytes("---\nx: "), fill(X, MAX_LINE_BYTES - 3), bytes("\n---\n")]),
      { x: "x".repeat(MAX_LINE_BYTES - 3) },
    ],
    "line-over-limit": [
      join([bytes("---\nx: "), fill(X, MAX_LINE_BYTES - 2), bytes("\n---\n")]),
      null,
    ],
    "scalar-at-limit": [
      foldedScalar(MAX_SCALAR_BYTES),
      { x: `${"x".repeat(4_094)} ${"x".repeat(4_094)} xx` },
    ],
    "scalar-over-limit": [foldedScalar(MAX_SCALAR_BYTES + 1), null],
    "depth-at-limit": [
      nested(8),
      { a0: { a1: { a2: { a3: { a4: { a5: { a6: { a7: "x" } } } } } } } },
    ],
    "depth-over-limit": [nested(9), null],
    "fields-at-limit": [
      fields(64),
      Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [`f${index}`, "x"]),
      ),
    ],
    "fields-over-limit": [fields(65), null],
    "sequence-at-limit": [
      sequence(1_024),
      { items: Array<FrontmatterValue>(1_024).fill("x") },
    ],
    "sequence-over-limit": [sequence(1_025), null],
  };
  const found = cases[name];
  if (found === undefined) throw new Error(`no generated case ${name}`);
  return found;
}

/**
 * `PurePosixPath(path).with_suffix(".json")`.
 *
 * The suffix is the last dot in the last component, and a name that is all
 * suffix has none: CPython reads `.fm` as a dotfile with an empty suffix and
 * appends rather than replaces, so a fixture named `.fm` looks for `.fm.json`
 * and not for `.json`. Slicing three characters off the end would disagree
 * there, on the one input where nobody would look.
 */
function withJsonSuffix(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  return `${path.slice(0, slash + 1)}${stem}.json`;
}

/** A manifest field that has to be there, read the way a missing key reads. */
function required(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  if (typeof value !== "string") {
    throw new Error(`fixtures/grammar/generated.json: entry has no ${key}`);
  }
  return value;
}

/** The complaints the suite drew, and how many cases it ran. */
export interface ConformanceReport {
  readonly errors: string[];
  readonly count: number;
}

export function runConformance(repoRoot: string): ConformanceReport {
  const errors: string[] = [];
  let count = 0;
  let reader: AtlasReader;
  let accept: ScannedFile[];
  let reject: ScannedFile[];
  try {
    reader = new AtlasReader(repoRoot);
    accept = reader.scan("fixtures/grammar/accept", { suffix: ".fm" });
    reject = reader.scan("fixtures/grammar/reject", { suffix: ".fm" });
  } catch (error) {
    if (error instanceof ReaderError) return { errors: [error.message], count };
    throw error;
  }

  for (const source of accept) {
    const path = source.path;
    const expected = withJsonSuffix(source.relativePath);
    try {
      const expectedFile = reader.optionalFile(expected);
      if (expectedFile === null) {
        errors.push(`${path}: accept fixture has no expected JSON`);
        count += 1;
        continue;
      }
      const wanted = readJsonFile(expectedFile);
      const parsed = parseFrontmatter(source.readBytes(), path);
      if (!sameJson(parsed, wanted)) {
        errors.push(`${path}: parsed ${show(parsed)}, expected ${show(wanted)}`);
      }
    } catch (error) {
      if (
        error instanceof FrontmatterError ||
        error instanceof JsonInputError ||
        error instanceof ReaderError
      ) {
        errors.push(error.message);
      } else throw error;
    }
    count += 1;
  }

  for (const source of reject) {
    const path = source.path;
    try {
      parseFrontmatter(source.readBytes(), path);
      errors.push(`${path}: reject fixture unexpectedly parsed`);
    } catch (error) {
      if (error instanceof ReaderError) errors.push(error.message);
      else if (!(error instanceof FrontmatterError)) throw error;
    }
    count += 1;
  }

  let manifest: unknown;
  try {
    const manifestFile = reader.optionalFile("fixtures/grammar/generated.json");
    if (manifestFile === null) {
      return {
        errors: ["fixtures/grammar/generated.json: missing manifest"],
        count,
      };
    }
    manifest = readJsonFile(manifestFile);
  } catch (error) {
    if (error instanceof JsonInputError || error instanceof ReaderError) {
      return { errors: [error.message], count };
    }
    throw error;
  }

  for (const entry of manifest as Array<Record<string, unknown>>) {
    // The manifest is committed canon, not input: an entry that names no
    // generator or no mode is a broken repository, and the only safe reading
    // of it is none. The oracle stops on the missing key rather than guessing
    // a mode, and a guess here would silently turn an unwritten case into a
    // passing one.
    const generator = required(entry, "generator");
    const mode = required(entry, "mode");
    const [data, wanted] = generatedCase(generator);
    const source = `generated:${generator}`;
    try {
      const parsed = parseFrontmatter(data, source);
      if (mode === "reject") {
        errors.push(`${source}: reject fixture unexpectedly parsed`);
      } else if (!sameJson(parsed, wanted)) {
        errors.push(`${source}: parsed object differs from expected`);
      }
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
      if (mode === "accept") {
        errors.push(`${source}: accept fixture was rejected`);
      }
    }
    count += 1;
  }

  return { errors, count };
}
