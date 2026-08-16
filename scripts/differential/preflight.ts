import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the validator's input layer against the CPython oracle.
//
// Three things are compared, all of them diagnostics rather than values,
// because that is what this layer produces: which file was refused, on which
// line, and for which reason. The line is the part worth the machinery — it is
// the half of a diagnostic §24.4 makes stable, and it is also the half a port
// silently loses, since a message with the wrong line still reads correctly
// and still passes any test that only greps for the reason.
//
// The root differs between the two runs by construction, so the absolute
// prefix is folded to a placeholder before comparing. Everything after it —
// the path inside the instance, the line, the reason — is compared verbatim.

import fs from "node:fs";

import { JsonInputError, readJsonFile } from "../src/json-input.ts";
import {
  CURATED_DIRS,
  JOURNALS,
  journalLines,
  journalPaths,
  readJsonl,
} from "../src/journal.ts";
import {
  SCHEMA_NAMES,
  loadRegistry,
  runnerManifestErrors,
  schemaErrors,
} from "../src/schema-registry.ts";
import { SUPPORTED_KEYWORDS, isCalendarDate } from "../src/schema.ts";
import { AtlasReader, ReaderError } from "../src/reader.ts";
import { compareCodePoint } from "../src/ordering.ts";
import { foldParserProse } from "./spelling.ts";

interface SetupEntry {
  readonly kind: "dir" | "file";
  readonly path: string;
  /** base64, so a fixture can hold bytes that are not text. */
  readonly data?: string;
}

interface Op {
  readonly op: string;
  readonly [key: string]: unknown;
}

interface Scenario {
  readonly name: string;
  readonly setup?: readonly SetupEntry[];
  readonly ops: readonly Op[];
  /** Set when the two implementations are known and agreed to differ. */
  readonly oracleDiffers?: string;
}

const REPO = `${import.meta.dir}/../..`;

type Result =
  | { ok: unknown }
  | { error: string }
  | { reader: string }
  | { missing: true };

const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const bytes = (data: readonly number[]): string =>
  Buffer.from(Uint8Array.from(data)).toString("base64");
const b64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");

function build(root: string, entries: readonly SetupEntry[]): void {
  for (const entry of entries) {
    const target = `${root}/${entry.path}`;
    if (entry.kind === "dir") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, Buffer.from(entry.data as string, "base64"));
  }
}

function runOp(root: string, op: Op): Result {
  const reader = new AtlasReader(root);
  switch (op.op) {
    case "read_json": {
      const found = reader.optionalFile(op.path as string);
      if (found === null) return { missing: true };
      return { ok: readJsonFile(found, (op.delivered as boolean | undefined) ?? false) };
    }
    case "journal_lines": {
      const found = reader.optionalFile(op.path as string);
      if (found === null) return { missing: true };
      return {
        ok: [...journalLines(found)].map((line) => [
          line.number,
          b64(line.raw),
          line.oversized,
        ]),
      };
    }
    case "read_jsonl": {
      const found = reader.optionalFile(op.path as string);
      if (found === null) return { missing: true };
      return { ok: [...readJsonl(found)].map((entry) => [entry.number, entry.row]) };
    }
    case "read_jsonl_raw": {
      const found = reader.optionalFile(op.path as string);
      if (found === null) return { missing: true };
      return {
        ok: [...readJsonl(found)].map((entry) => [
          entry.number,
          entry.row,
          b64(entry.raw),
        ]),
      };
    }
    case "journal_paths":
      return {
        ok: journalPaths(reader, op.stem as string).map((path) => path.relativePath),
      };
    case "load_registry": {
      const registry = loadRegistry((op.root as string | undefined) ?? root);
      return {
        ok: [[...registry.schemas.keys()].sort(compareCodePoint), registry.errors],
      };
    }
    case "runner_manifest":
      return { ok: runnerManifestErrors(op.value, op.source) };
    case "schema_errors":
      // The place, not the prose: §24.4 makes the source a contract and the
      // English after it explicitly not one, and this port words it
      // differently on purpose rather than reproducing CPython punctuation.
      return {
        ok: schemaErrors(
          op.value,
          op.schema as Record<string, unknown>,
          op.source,
        ).map(sourceOnly),
      };
    case "calendar_date":
      return { ok: (op.values as string[]).map(isCalendarDate) };
    case "vocabulary":
      return {
        ok: [
          [...SCHEMA_NAMES].sort(compareCodePoint),
          Object.fromEntries(CURATED_DIRS),
          Object.fromEntries(JOURNALS),
          [...SUPPORTED_KEYWORDS].sort(compareCodePoint),
        ],
      };
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

const sourceOnly = (message: string): string => message.split(": ", 1)[0] as string;

function observe(scenario: Scenario, root: string): Result[] {
  build(root, scenario.setup ?? []);
  const observed: Result[] = [];
  for (const op of scenario.ops) {
    try {
      observed.push(runOp(root, op));
    } catch (error) {
      if (error instanceof JsonInputError) observed.push({ error: error.message });
      else if (error instanceof ReaderError) observed.push({ reader: error.message });
      else throw error;
    }
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRAPH = '{"format":"atlas-graph","version":1,"nodes":[],"edges":[]}\n';

/** A JSON document whose fault is on a known line, well past the first. */
const MULTILINE = (fault: string): string =>
  `{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  ${fault}\n}\n`;

const ROW = (id: string): string => `{"id":"${id}"}`;

/** Every date string the two calendar implementations could disagree about. */
const CALENDAR_PROBES: string[] = (() => {
  const years = new Set<number>();
  for (let year = 0; year <= 16; year += 1) years.add(year);
  for (const year of [99, 100, 200, 400, 1600, 1700, 1900, 2000, 2026, 9999]) {
    years.add(year);
  }
  const values: string[] = [];
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  for (const year of [...years].sort((left, right) => left - right)) {
    for (let month = 0; month <= 13; month += 1) {
      for (const day of [0, 1, 28, 29, 30, 31, 32]) {
        const stamp = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
        values.push(stamp, `${stamp}T00:00:00Z`);
      }
    }
  }
  // Shapes the pattern gate lets through and the calendar still has to judge,
  // plus two it must refuse before judging anything.
  values.push("2026-07-16T23:59:59Z", "2026-07-16T24:00:00Z", "2026-7-16", "");
  return values;
})();

const SCENARIOS: Scenario[] = [
  {
    name: "a well-formed document",
    setup: [{ kind: "file", path: "atlas/graph.json", data: encode(GRAPH) }],
    ops: [{ op: "read_json", path: "atlas/graph.json" }],
  },
  {
    name: "a document that is not there",
    ops: [{ op: "read_json", path: "atlas/absent.json" }],
  },
  {
    name: "a byte-order mark, authored and delivered",
    setup: [
      { kind: "file", path: "atlas/bom.json", data: encode(`﻿${GRAPH}`) },
    ],
    ops: [
      { op: "read_json", path: "atlas/bom.json" },
      { op: "read_json", path: "atlas/bom.json", delivered: true },
    ],
  },
  {
    name: "a carriage return on the first line",
    setup: [{ kind: "file", path: "atlas/cr.json", data: encode('{"a":1}\r\n') }],
    ops: [
      { op: "read_json", path: "atlas/cr.json" },
      { op: "read_json", path: "atlas/cr.json", delivered: true },
    ],
  },
  {
    name: "a carriage return on the fourth line",
    setup: [
      {
        kind: "file",
        path: "atlas/cr4.json",
        data: encode('{\n  "a": 1,\n  "b": 2,\n  "c": 3\r\n}\n'),
      },
    ],
    ops: [{ op: "read_json", path: "atlas/cr4.json" }],
  },
  {
    name: "a lone carriage return with no newline before it",
    setup: [{ kind: "file", path: "atlas/cr0.json", data: encode('\r{"a":1}') }],
    ops: [{ op: "read_json", path: "atlas/cr0.json" }],
  },
  {
    name: "an invalid lead byte on the third line",
    setup: [
      {
        kind: "file",
        path: "atlas/bad.json",
        data: bytes([0x7b, 0x0a, 0x22, 0x61, 0x22, 0x0a, 0x3a, 0xff, 0x7d]),
      },
    ],
    ops: [{ op: "read_json", path: "atlas/bad.json" }],
  },
  {
    name: "a truncated multi-byte sequence at the end",
    setup: [
      { kind: "file", path: "atlas/cut.json", data: bytes([0x7b, 0x0a, 0xc3]) },
    ],
    ops: [{ op: "read_json", path: "atlas/cut.json" }],
  },
  {
    name: "a continuation byte with no lead",
    setup: [
      { kind: "file", path: "atlas/cont.json", data: bytes([0x7b, 0x80, 0x7d]) },
    ],
    ops: [{ op: "read_json", path: "atlas/cont.json" }],
  },
  {
    name: "an encoded surrogate half",
    setup: [
      {
        kind: "file",
        path: "atlas/surrogate.json",
        data: bytes([0x7b, 0x0a, 0xed, 0xa0, 0x80, 0x7d]),
      },
    ],
    ops: [{ op: "read_json", path: "atlas/surrogate.json" }],
  },
  {
    name: "an overlong encoding of a plain character",
    setup: [
      {
        kind: "file",
        path: "atlas/overlong.json",
        data: bytes([0x7b, 0xc0, 0xaf, 0x7d]),
      },
    ],
    ops: [{ op: "read_json", path: "atlas/overlong.json" }],
  },
  {
    name: "a code point past the last one",
    setup: [
      {
        kind: "file",
        path: "atlas/past.json",
        data: bytes([0x7b, 0xf5, 0x80, 0x80, 0x80, 0x7d]),
      },
    ],
    ops: [{ op: "read_json", path: "atlas/past.json" }],
  },
  {
    name: "text that is valid but not ASCII",
    setup: [
      { kind: "file", path: "atlas/utf8.json", data: encode('{"a":"日本語 ✓"}\n') },
    ],
    ops: [{ op: "read_json", path: "atlas/utf8.json" }],
  },
  {
    name: "an empty file",
    setup: [{ kind: "file", path: "atlas/empty.json", data: "" }],
    ops: [{ op: "read_json", path: "atlas/empty.json" }],
  },
  {
    name: "a trailing comma on line seven",
    setup: [
      { kind: "file", path: "atlas/a.json", data: encode(MULTILINE('"c": 3,')) },
    ],
    ops: [{ op: "read_json", path: "atlas/a.json" }],
  },
  {
    name: "a missing colon on line seven",
    setup: [
      { kind: "file", path: "atlas/b.json", data: encode(MULTILINE('"c" 3')) },
    ],
    ops: [{ op: "read_json", path: "atlas/b.json" }],
  },
  {
    name: "an unquoted name on line seven",
    setup: [
      { kind: "file", path: "atlas/c.json", data: encode(MULTILINE("c: 3")) },
    ],
    ops: [{ op: "read_json", path: "atlas/c.json" }],
  },
  {
    name: "a single quote on line seven",
    setup: [
      { kind: "file", path: "atlas/d.json", data: encode(MULTILINE("'c': 3")) },
    ],
    ops: [{ op: "read_json", path: "atlas/d.json" }],
  },
  {
    name: "a document that ends in the middle of a string",
    setup: [
      { kind: "file", path: "atlas/e.json", data: encode('{\n  "a": "un\n') },
    ],
    ops: [{ op: "read_json", path: "atlas/e.json" }],
  },
  {
    name: "a second document after the first",
    setup: [
      { kind: "file", path: "atlas/f.json", data: encode('{"a":1}\n{"b":2}\n') },
    ],
    ops: [{ op: "read_json", path: "atlas/f.json" }],
  },
  {
    name: "a bare word where a value belongs",
    setup: [
      { kind: "file", path: "atlas/g.json", data: encode('{\n"a": undefined\n}\n') },
    ],
    ops: [{ op: "read_json", path: "atlas/g.json" }],
  },
  {
    name: "a duplicate key, which has no line to report",
    setup: [
      { kind: "file", path: "atlas/h.json", data: encode('{\n"a":1,\n"a":2\n}\n') },
    ],
    ops: [{ op: "read_json", path: "atlas/h.json" }],
  },
  {
    name: "a non-finite number, which has no line to report",
    setup: [{ kind: "file", path: "atlas/i.json", data: encode('{\n"a": NaN\n}\n') }],
    ops: [{ op: "read_json", path: "atlas/i.json" }],
  },
  {
    name: "an infinity, spelled both ways",
    setup: [
      { kind: "file", path: "atlas/j.json", data: encode('{"a": Infinity}\n') },
      { kind: "file", path: "atlas/k.json", data: encode('{"a": -Infinity}\n') },
    ],
    ops: [
      { op: "read_json", path: "atlas/j.json" },
      { op: "read_json", path: "atlas/k.json" },
    ],
  },
  {
    name: "a directory where a document belongs",
    setup: [{ kind: "dir", path: "atlas/graph.json" }],
    ops: [{ op: "read_json", path: "atlas/graph.json" }],
  },

  // -- journals ------------------------------------------------------------
  {
    name: "three ordinary rows",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n${ROW("b")}\n${ROW("c")}\n`),
      },
    ],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
      { op: "read_jsonl_raw", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a last row with no newline after it",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n${ROW("b")}`),
      },
    ],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "an empty journal",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: "" }],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a journal that is one newline",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: encode("\n") }],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a blank row between two good ones",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n\n${ROW("c")}\n`),
      },
    ],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a byte-order mark before the first row",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`﻿${ROW("a")}\n`),
      },
    ],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a carriage return inside the second row",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n${ROW("b")}\r\n`),
      },
    ],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a malformed row, whose line number is the row's own",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n{"id":\n${ROW("c")}\n`),
      },
    ],
    ops: [{ op: "read_jsonl", path: "state/artifacts.jsonl" }],
  },
  {
    name: "a duplicate key in the third row",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${ROW("a")}\n${ROW("b")}\n{"id":"c","id":"d"}\n`),
      },
    ],
    ops: [{ op: "read_jsonl", path: "state/artifacts.jsonl" }],
  },
  {
    name: "a row that is not UTF-8",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: bytes([0x7b, 0x7d, 0x0a, 0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
      },
    ],
    ops: [{ op: "read_jsonl", path: "state/artifacts.jsonl" }],
  },

  // -- the §25.8 row ceiling, and the chunk boundary it interacts with -----
  {
    name: "a row of exactly the ceiling",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: encode(atCeiling(0)) }],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a row one byte over the ceiling",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: encode(atCeiling(1)) }],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "an over-long row followed by a good one",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${atCeiling(4096)}${ROW("after")}\n`),
      },
    ],
    ops: [{ op: "journal_lines", path: "state/artifacts.jsonl" }],
  },
  {
    name: "an over-long row that is also the last, with no newline",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(atCeiling(500).slice(0, -1)),
      },
    ],
    ops: [{ op: "journal_lines", path: "state/artifacts.jsonl" }],
  },
  {
    name: "rows that straddle every read boundary",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: encode(straddling()) }],
    ops: [
      { op: "journal_lines", path: "state/artifacts.jsonl" },
      { op: "read_jsonl", path: "state/artifacts.jsonl" },
    ],
  },
  {
    name: "a newline exactly on a read boundary",
    setup: [
      {
        kind: "file",
        path: "state/artifacts.jsonl",
        data: encode(`${"x".repeat(8191)}\n${ROW("b")}\n`),
      },
    ],
    ops: [{ op: "journal_lines", path: "state/artifacts.jsonl" }],
  },
  {
    name: "a first read that is shorter than the mark",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: bytes([0xef, 0xbb]) }],
    ops: [{ op: "journal_lines", path: "state/artifacts.jsonl" }],
  },

  // -- rotation order ------------------------------------------------------
  {
    name: "rotated files come before the live tail",
    setup: [
      { kind: "file", path: "state/artifacts/0002.jsonl", data: encode(`${ROW("b")}\n`) },
      { kind: "file", path: "state/artifacts/0001.jsonl", data: encode(`${ROW("a")}\n`) },
      { kind: "file", path: "state/artifacts/notes.md", data: encode("ignored\n") },
      { kind: "file", path: "state/artifacts.jsonl", data: encode(`${ROW("c")}\n`) },
    ],
    ops: [{ op: "journal_paths", stem: "artifacts" }],
  },
  {
    name: "a journal with no rotation directory",
    setup: [{ kind: "file", path: "state/artifacts.jsonl", data: encode(`${ROW("a")}\n`) }],
    ops: [{ op: "journal_paths", stem: "artifacts" }],
  },
  {
    name: "a rotation directory with no live tail",
    setup: [
      { kind: "file", path: "state/artifacts/0001.jsonl", data: encode(`${ROW("a")}\n`) },
    ],
    ops: [{ op: "journal_paths", stem: "artifacts" }],
  },
  {
    name: "a journal that exists in neither form",
    ops: [{ op: "journal_paths", stem: "artifacts" }],
  },

  // -- the registry --------------------------------------------------------
  {
    name: "the registry Atlas actually ships",
    ops: [{ op: "load_registry", root: REPO }],
  },
  {
    name: "no schema directory at all",
    ops: [{ op: "load_registry" }],
  },
  {
    name: "the vocabulary itself",
    ops: [{ op: "vocabulary" }],
  },
  {
    // The oracle asks `date.fromisoformat` and this port does the arithmetic,
    // so the two agree only where the proleptic Gregorian calendar and a
    // hand-written leap rule agree. That is nowhere worth guessing at: every
    // year from 0000 to 0016 (where the rule's own edges are, and where the
    // oracle's minimum year sits), every century boundary, and every month
    // with its last valid day, the day after it, and day zero.
    name: "every day the two calendars could disagree about",
    ops: [{ op: "calendar_date", values: CALENDAR_PROBES }],
  },
  {
    name: "each complaint carries the source in front of it",
    ops: [
      {
        op: "schema_errors",
        source: "state/artifacts.jsonl:12",
        schema: {
          type: "object",
          properties: { id: { type: "string", pattern: "^artifact:" } },
          required: ["id", "observed_at"],
          additionalProperties: false,
        },
        value: { id: 7, extra: true },
      },
      {
        op: "schema_errors",
        source: "atlas/graph.json",
        schema: { type: "object", required: ["nodes"] },
        value: { nodes: [] },
      },
    ],
  },
];

/** A row that lands exactly `over` bytes past the §25.8 ceiling, plus its newline. */
function atCeiling(over: number): string {
  const total = 16_384 + over;
  const wrapper = '{"id":""}';
  return `{"id":"${"x".repeat(total - wrapper.length)}"}\n`;
}

/**
 * Rows sized so that a row boundary falls on, just before and just after every
 * 8192-byte read — the seam where a chunked reader loses or duplicates a row.
 */
function straddling(): string {
  const WRAPPER = '{"id":""}'.length;
  const out: string[] = [];
  let written = 0;
  for (const target of [8191, 8192, 8193, 16_383, 16_384, 16_385]) {
    // The row plus its newline has to land the running total exactly on the
    // boundary, so the row itself is one byte shorter than the step.
    const width = target - written - 1;
    if (width < WRAPPER) continue;
    out.push(`{"id":"${"y".repeat(width - WRAPPER)}"}`);
    written = target;
  }
  out.push(ROW("tail"));
  return `${out.join("\n")}\n`;
}

// Manifests are compared with a fixed source string, so no path folding applies.
const MANIFEST_SOURCE = "manifests/run.json";
// `version` is deliberately loose: §17.7 wants the string "1", and a manifest
// that wrote the number 1 instead is exactly the near-miss worth comparing.
const COMPONENT = (id: string, version: unknown): Record<string, unknown> => ({
  id,
  version,
});
const IMPORTER_PAIR = [
  COMPONENT("runner-plan-importer-input", "1"),
  COMPONENT("runner-plan-importer-output", "1"),
];

const MANIFESTS: unknown[] = [
  null,
  [],
  "text",
  {},
  { version: 1 },
  { version: 1, prompt_bundle: { components: IMPORTER_PAIR } },
  { version: 1, prompt_bundle: { components: [COMPONENT("house-style", "1")] } },
  { version: 3, role: "plan-importer" },
  { version: 2 },
  { version: 2, role: "plan-importer" },
  { version: 2, role: "plan-importer", prompt_bundle: {} },
  { version: 2, role: "plan-importer", prompt_bundle: { components: [] } },
  { version: 2, role: "plan-importer", prompt_bundle: { components: "not-a-list" } },
  { version: 2, role: "plan-importer", prompt_bundle: { components: ["not-an-object"] } },
  { version: 2, role: "plan-importer", prompt_bundle: { components: IMPORTER_PAIR } },
  {
    version: 2,
    role: "plan-importer",
    prompt_bundle: { components: [...IMPORTER_PAIR, ...IMPORTER_PAIR] },
  },
  {
    version: 2,
    role: "plan-importer",
    prompt_bundle: {
      components: [
        COMPONENT("runner-plan-importer-input", "1"),
        COMPONENT("runner-plan-importer-output", "2"),
      ],
    },
  },
  {
    version: 2,
    role: "plan-importer",
    prompt_bundle: {
      components: [
        COMPONENT("runner-plan-importer-input", "1"),
        COMPONENT("runner-plan-importer-output", 1),
      ],
    },
  },
  {
    version: 2,
    role: "plan-importer",
    prompt_bundle: {
      components: [...IMPORTER_PAIR, COMPONENT("runner-artifact-observer-input", "1")],
    },
  },
  {
    version: 2,
    role: "artifact-observer",
    prompt_bundle: {
      components: [
        COMPONENT("runner-artifact-observer-input", "1"),
        COMPONENT("runner-artifact-observer-output", "1"),
      ],
    },
  },
  { version: 2, role: "field-cartographer" },
  { version: 2, role: "field-cartographer", outcome: "aborted", warnings: ["w"] },
  { version: 2, role: "field-cartographer", outcome: "completed" },
  {
    version: 2,
    role: "state-auditor",
    outcome: "aborted",
    warnings: ["w"],
    prompt_bundle: { components: IMPORTER_PAIR },
  },
  { version: 2, role: "unknown-role", outcome: "aborted", warnings: [] },
  { version: 2, role: 7, outcome: "aborted", warnings: ["w"] },
  {
    version: 2,
    role: "plan-importer",
    outcome: "aborted",
    prompt_bundle: { components: IMPORTER_PAIR },
    outputs: ["something"],
    decisions: ["a choice"],
    warnings: [],
  },
  {
    version: 2,
    role: "plan-importer",
    outcome: "aborted",
    prompt_bundle: { components: IMPORTER_PAIR },
    outputs: [],
    decisions: [],
    warnings: ["stable-code"],
  },
  {
    version: 2,
    role: "plan-importer",
    outcome: "aborted",
    prompt_bundle: { components: IMPORTER_PAIR },
    outputs: "not-a-list",
    decisions: "not-a-list",
    warnings: "not-a-list",
  },
];

SCENARIOS.push({
  name: "the §17.7 manifest bindings",
  ops: MANIFESTS.map((value) => ({
    op: "runner_manifest",
    value,
    source: MANIFEST_SOURCE,
  })),
});

// A registry with exactly one thing wrong with it, one scenario per thing. The
// inventory line names every schema, so these also compare that list in full.
const REGISTRY_FAULTS: ReadonlyArray<{
  readonly name: string;
  readonly stem: string;
  readonly body: string;
  readonly oracleDiffers?: string;
}> = [
  {
    name: "a schema naming the wrong dialect",
    stem: "probe",
    body: JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://atlas-sdd.local/schemas/probe.schema.json",
      type: "object",
    }),
  },
  {
    name: "a schema naming the wrong id",
    stem: "probe",
    body: JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://atlas-sdd.local/schemas/other.schema.json",
      type: "object",
    }),
  },
  {
    name: "a schema reaching past the admitted keywords",
    stem: "probe",
    body: JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://atlas-sdd.local/schemas/probe.schema.json",
      type: "object",
      patternProperties: { "^x": { type: "string" } },
    }),
  },
  {
    name: "a schema that is a bare true",
    stem: "probe",
    body: "true",
    // The oracle reaches `.get` on the value and reports the AttributeError
    // CPython raised — a sentence with no file in it, which §24.4 does not
    // allow a diagnostic to be. This port names the schema and says what was
    // wrong with it. A validator that cannot say which of twenty-five files
    // it choked on is not a preflight (#130).
    oracleDiffers: "the oracle's message names no file",
  },
  {
    name: "a schema that is a list",
    stem: "probe",
    body: "[]",
    oracleDiffers: "the oracle's message names no file",
  },
  {
    name: "a schema that is malformed",
    stem: "probe",
    body: '{"$schema": ',
  },
];

for (const fault of REGISTRY_FAULTS) {
  SCENARIOS.push({
    name: fault.name,
    oracleDiffers: fault.oracleDiffers,
    setup: [...SCHEMA_NAMES].map((name) => ({
      kind: "file" as const,
      path: `spec/schemas/${name}.schema.json`,
      data: encode(
        name === fault.stem
          ? fault.body
          : JSON.stringify({
              $schema: "https://json-schema.org/draft/2020-12/schema",
              $id: `https://atlas-sdd.local/schemas/${name}.schema.json`,
              type: "object",
            }),
      ),
    })),
    ops: [{ op: "load_registry" }],
  });
}

SCENARIOS.push({
  name: "a registry missing one schema and holding one it should not",
  setup: [...SCHEMA_NAMES]
    .filter((name) => name !== "probe")
    .concat(["invented"])
    .map((name) => ({
      kind: "file" as const,
      path: `spec/schemas/${name}.schema.json`,
      data: encode(
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: `https://atlas-sdd.local/schemas/${name}.schema.json`,
          type: "object",
        }),
      ),
    })),
  ops: [{ op: "load_registry" }],
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// What a diagnostic promises is the place and the reason: the path, the line,
// the exit code. The sentence is not a promise, and these two are the only
// places the two implementations write a different one — so they are folded
// here rather than back-ported, which would mean carrying CPython's wording
// and its punctuation into a codebase that has neither.
const PROSE: ReadonlyArray<{ from: RegExp; to: string }> = [
  // Python's repr quotes a name with apostrophes and JavaScript with double
  // quotes. The keyword itself is kept, because which keyword is the finding.
  {
    from: /unsupported schema keyword ["'](.+?)["']/,
    to: "unsupported schema keyword <$1>",
  },
];

/** Fold the run's own temporary root away; the path inside it is the contract. */
const fold = (text: string, root: string): string => {
  let folded = foldParserProse(text.split(root).join("<root>"));
  for (const rule of PROSE) folded = folded.replace(rule.from, rule.to);
  return folded;
};

function normalise(results: readonly Result[], root: string): string {
  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return fold(value, root);
    if (Array.isArray(value)) return value.map(deep);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, deep(inner)]),
      );
    }
    return value;
  };
  return JSON.stringify(results.map(deep), null, 2);
}

let compared = 0;
let diverged = 0;
let recorded = 0;

for (const scenario of SCENARIOS) {
  const mineRoot = fs.mkdtempSync("/tmp/atlas-pre-mine-");
  const oracleRoot = fs.mkdtempSync("/tmp/atlas-pre-oracle-");

  let mine: Result[];
  try {
    mine = observe(scenario, mineRoot);
  } catch (error) {
    console.error(`preflight: ${scenario.name}: the port threw outside its contract`);
    console.error(String(error));
    diverged += 1;
    continue;
  }

  // One recorded answer per scenario, with this run's root folded out of both
  // the question and the answer so neither carries a directory that is gone by
  // the next run.
  //
  // The checkout is folded for the same reason and a stronger one: one scenario
  // asks about the registry this repository ships, so the question names the
  // checkout, and a checkout sits at a different path on every machine. Left
  // unfolded, the recording answers on the machine that made it and nowhere
  // else — which is what CI is, and a corpus only that one laptop can replay is
  // not a proof anybody can check.
  const theirRoots = [oracleRoot, REPO, fs.realpathSync(REPO)];
  const question = JSON.stringify({ ...scenario, root: oracleRoot });
  let theirs: Result[];
  try {
    theirs = JSON.parse(
      unfoldRoots(
        oracleAnswer("preflight", foldRoots(question, theirRoots)) as string,
        theirRoots,
      ),
    ) as Result[];
  } catch (error) {
    console.error(`preflight: ${scenario.name}: the oracle failed`);
    console.error(String(error));
    diverged += 1;
    continue;
  }

  compared += scenario.ops.length;
  const mineText = normalise(mine, mineRoot);
  const theirsText = normalise(theirs, oracleRoot);
  if (mineText !== theirsText) {
    if (scenario.oracleDiffers !== undefined) {
      recorded += 1;
    } else {
      diverged += 1;
      console.error(`preflight: ${scenario.name}`);
      console.error(`  mine:   ${mineText.replaceAll("\n", "\n          ")}`);
      console.error(`  oracle: ${theirsText.replaceAll("\n", "\n          ")}`);
    }
  }

  fs.rmSync(mineRoot, { recursive: true, force: true });
  fs.rmSync(oracleRoot, { recursive: true, force: true });
}

console.log(
  `preflight: ${compared} comparisons over ${SCENARIOS.length} scenarios, ` +
    `${diverged} unexplained, ${recorded} recorded`,
);
process.exit(diverged === 0 ? 0 : 1);
