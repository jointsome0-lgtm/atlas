import {
  JsonDisciplineError,
  JsonFloat,
  type JsonValue,
  parseStrict,
  stringifyDocument,
  stringifyRow,
} from "../src/canonical-json.ts";
import { oracleAnswer } from "./oracle.ts";

import { sortedByCodePoint } from "../src/ordering.ts";

// Reading is half the contract, so the oracle both emits and reads. Checking
// only "did it throw" would pass any input whose value we get wrong: a key
// silently lost on the way in still parses.
//
// Parsed values are compared through a projection rather than directly,
// because the two languages disagree on number *type*, not number *value* —
// Python keeps 1 and 1.0 apart, JavaScript does not. The projection renders
// every number as its IEEE-754 bits, which both sides can produce exactly and
// which still separates 0 from -0. Integers beyond 2**53 would be flattened by
// float() on the oracle side, so the corpus stays inside the safe range; one
// out there is a real divergence and should be reported, not normalised away.
const ORACLE = `
import json, struct, sys
sys.path.insert(0, "scripts")
from atlas_reader import strict_json_loads

def project(value):
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["bool", value]
    if isinstance(value, (int, float)):
        return ["num", struct.pack(">d", float(value)).hex()]
    if isinstance(value, str):
        return ["str", value]
    if isinstance(value, list):
        return ["arr", [project(item) for item in value]]
    if isinstance(value, dict):
        return ["obj", [[k, project(value[k])] for k in sorted(value)]]
    raise TypeError("unprojectable value")

payload = json.loads(sys.stdin.read())

emitted = []
for case in payload["emit"]:
    emitted.append({
        "document": json.dumps(case, ensure_ascii=False, indent=2) + "\\n",
        "row": json.dumps(
            case,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ),
    })

read = []
for text in payload["read"]:
    try:
        value = strict_json_loads(text)
    except Exception:
        read.append({"ok": False})
        continue
    projection = json.dumps(
        project(value), ensure_ascii=False, separators=(",", ":")
    )
    try:
        row = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        document = json.dumps(value, ensure_ascii=False, indent=2) + "\\n"
    except ValueError:
        # The oracle read it but cannot write it back either: 1e999 becomes
        # inf, which allow_nan=False refuses (#122). Nothing to compare.
        read.append(
            {"ok": True, "projection": projection, "row": None, "document": None}
        )
        continue
    try:
        projection.encode("utf-8")
        row.encode("utf-8")
        document.encode("utf-8")
    except UnicodeEncodeError:
        # A lone surrogate the oracle accepted (#123). It cannot cross this
        # pipe at all, which is most of the point. The accept/reject
        # comparison still runs; only the value comparisons are skipped.
        read.append(
            {"ok": True, "projection": None, "row": None, "document": None}
        )
        continue
    read.append({
        "ok": True,
        "projection": projection,
        "row": row,
        "document": document,
    })

sys.stdout.write(
    json.dumps({"emit": emitted, "read": read}, ensure_ascii=False)
)
`;

const CASES: unknown[] = [
  {},
  [],
  { a: {} },
  { a: [] },
  [[], {}, [[]]],
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1000000,
  9007199254740991,
  -9007199254740991,
  "",
  "plain",
  'quote " backslash \\ slash /',
  // Written as escapes, not as the bytes themselves: a raw NUL makes git
  // treat this source as binary, and a corpus nobody can read in a diff is
  // a corpus nobody reviews. The parsed values are identical.
  "controls \u0000\u0001\u0007\b\t\n\u000b\f\r\u001f",
  "del \u007f",
  "non-ascii: привет ünïcodë 日本語 emoji 🜂",
  "astral \u{1f600}\u{10000}\u{10ffff}",
  "combining é and zwj ‍",
  { "�": "bmp", "\u{10000}": "astral", "": "pua" },
  { z: 1, a: 2, M: 3, "": 4 },
  { "key with space": 1, "key\nwith\nnewline": 2, 'key"quote': 3 },
  { nested: { deep: { deeper: { deepest: [1, 2, { k: "v" }] } } } },
  [{ b: 1, a: 2 }, { d: 3, c: 4 }],
  { unicode_key_привет: "значение", 日本: "語" },
  { mixed: [1, "two", null, true, false, {}, []] },
  { "\u007f": "del-key", "\u0001": "ctrl-key" },
];

// `__proto__` is an ordinary JSON key. In an object literal — even quoted —
// it sets the prototype instead of becoming a member, so these cases are built
// by assignment onto a prototype-less object, which is also what the parser
// must produce.
function withKeys(entries: [string, unknown][]): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) result[key] = value;
  return result;
}

CASES.push(
  withKeys([["__proto__", { sensitivity: "medical" }]]),
  withKeys([["id", "artifact:1"], ["__proto__", { sensitivity: "medical" }]]),
  withKeys([
    ["constructor", 1],
    ["prototype", 2],
    ["toString", 3],
    ["hasOwnProperty", 4],
    ["valueOf", 5],
  ]),
  withKeys([["__proto__", null], ["__proto__x", 1], ["proto", 2]]),
  { nested: withKeys([["__proto__", { deep: true }]]) },
  [withKeys([["__proto__", "in-array"]])],
);

// An index-like key is not an ordinary key in JavaScript: the engine puts it
// first, ascending, whatever order it was written in. So the insertion order
// the oracle emits in document form is already gone before the writer is
// called, and the writer refuses rather than emitting an order nothing chose.
// The row form is decided by content, so it still has to match byte for byte —
// which is what these cases check, alongside the required refusal.
const ROW_ONLY_CASES: unknown[] = [
  { "10": 1, "9": 2, "1": 3, a: 4, A: 5, _: 6 },
  { b: 1, "2": 2, "1": 3, a: 4, "10": 5, "-1": 6, "01": 7 },
  { "0": "zero" },
  { outer: { "1": 1, b: 2 } },
];

interface EmitResult {
  document: string;
  row: string;
}

type ReadResult =
  | { ok: false }
  | {
    ok: true;
    projection: string | null;
    row: string | null;
    document: string | null;
  };

interface OracleResult {
  emit: EmitResult[];
  read: ReadResult[];
}

function runOracle(emit: unknown[], read: string[]): OracleResult {
  const payload = JSON.stringify({ emit, read });
  return oracleAnswer("json-forms", payload, () => {
    const proc = Bun.spawnSync(["python3", "-c", ORACLE], {
      stdin: Buffer.from(payload, "utf-8"),
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `oracle failed (${proc.exitCode}): ${proc.stderr.toString()}`,
      );
    }
    return JSON.parse(proc.stdout.toString()) as unknown;
  }) as OracleResult;
}

function show(value: string): string {
  return JSON.stringify(value);
}

// Mirror of the oracle's `project`: numbers as their IEEE-754 bits, objects as
// code-point-ordered pairs. Emission is compared directly against the oracle
// just below, so rendering the projection with it adds no blind spot.
function projectNumber(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let hex = "";
  for (let i = 0; i < 8; i += 1) {
    hex += view.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}

function project(value: JsonValue): JsonValue {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["bool", value];
  if (typeof value === "number") return ["num", projectNumber(value)];
  // The oracle projects an int and a float alike, as the bits of the double —
  // so a float projects the same way here, and the comparison stays about the
  // value while the type keeps its separate proof in the reason column.
  if (value instanceof JsonFloat) return ["num", projectNumber(value.value)];
  if (typeof value === "string") return ["str", value];
  if (Array.isArray(value)) return ["arr", value.map(project)];
  const record = value as { [key: string]: JsonValue };
  return [
    "obj",
    sortedByCodePoint(Object.keys(record)).map(
      (key) => [key, project(record[key] as JsonValue)],
    ),
  ];
}

interface ReadCase {
  text: string;
  // The canon's reason code, or null where the document is accepted.
  reason: string | null;
  // Set only where the canon deliberately parts company with the oracle; the
  // note names the issue. The harness then *requires* the disagreement to
  // still be there, so a silent convergence cannot rot the record.
  oracleDiffers?: string;
  // The narrower case: both sides accept, and the values differ. `ours` is the
  // answer canon requires, not merely "something else" — a marker that asked
  // only for inequality would accept any wrong answer as the expected
  // divergence, which is a check that cannot fail for the reason it claims.
  oracleValueDiffers?: Divergence;
  // Both sides accept and agree on the value, but writing it back gives
  // different bytes — the oracle keeps `1.0` a float where §25.7 has one
  // integer domain. Pinned the same way, by value.
  oracleRowDiffers?: Divergence;
  // The document form is narrower than the row form by exactly one key shape
  // (see `isIndexLikeKey`): JavaScript has already lost the insertion order
  // the oracle would emit. Recorded per case rather than inferred, so the
  // asymmetry is stated where someone reading the corpus will see it.
  documentRefuses?: string;
  // Both readers accept it and neither writer here may put it back: a float is
  // read so a schema can refuse the document that carried it, and §25.7 has no
  // float spelling to write. The reason is named so a case cannot claim this
  // exemption and then be refused for something else entirely.
  writeRefuses?: string;
  // As `oracleRowDiffers`, for the order-preserving form.
  oracleDocumentDiffers?: Divergence;
}

/** The one reason canon gives for refusing to write a value it can read. */
const FLOAT = "non-integer-json-number";

interface Divergence {
  issue: string;
  ours: string;
}

const READS: ReadCase[] = [
  { text: '{"a":1,"a":2}', reason: "duplicate-json-key" },
  { text: '{"a":{"b":1,"b":2}}', reason: "duplicate-json-key" },
  { text: "NaN", reason: "non-finite-json-number" },
  { text: "Infinity", reason: "non-finite-json-number" },
  { text: "-Infinity", reason: "non-finite-json-number" },
  { text: "1e999", reason: "non-finite-json-number", oracleDiffers: "#122" },
  { text: "-1e999", reason: "non-finite-json-number", oracleDiffers: "#122" },
  { text: '{"a":1,}', reason: "invalid-json" },
  { text: "[1,2,]", reason: "invalid-json" },
  { text: "{'a':1}", reason: "invalid-json" },
  { text: "01", reason: "invalid-json" },
  { text: "+1", reason: "invalid-json" },
  { text: "", reason: "invalid-json" },
  { text: '"unterminated', reason: "invalid-json" },
  { text: '{"a":1} trailing', reason: "invalid-json" },
  { text: '{"a":1}', reason: null },
  { text: "[1,2,3]", reason: null },
  { text: '{"nested":{"a":[1,{"b":null}]}}', reason: null },
  { text: '"\\u0041\\u00e9\\ud83d\\ude00"', reason: null },
  { text: '  { "a" : 1 }  ', reason: null },
  // A float reads as a float on both sides: Python's int/float split decides
  // whether `{"version": 1.0}` passes an envelope's integer test, so the reader
  // carries it (#119). What canon does not carry is a way to *write* one —
  // §25.7 has a single integer domain and no Atlas schema declares a
  // non-integer field — so each of these reads and then refuses to be written.
  { text: '{"a":1.5}', reason: null, writeRefuses: FLOAT },
  { text: "-1.5e-3", reason: null, writeRefuses: FLOAT },
  { text: "1.0000000000000001", reason: null, writeRefuses: FLOAT },
  { text: "-0.0", reason: null, writeRefuses: FLOAT },
  { text: "0.0", reason: null, writeRefuses: FLOAT },
  { text: "1e2", reason: null, writeRefuses: FLOAT },
  { text: "1E+2", reason: null, writeRefuses: FLOAT },
  { text: "1.0", reason: null, writeRefuses: FLOAT },
  // §25.7 has one integer zero, and the bare spellings are the integer ones.
  { text: "-0", reason: null },
  { text: "0", reason: null },
  { text: "9007199254740991", reason: null },
  { text: '{"":1}', reason: null },
  { text: "true", reason: null },
  { text: "null", reason: null },
  { text: '{"a":[],"b":{}}', reason: null },
  // Shaped like what actually crosses this reader, so a mutation that
  // corrupts a real field — the emitted envelope's version, a journal row's
  // subject — has something to corrupt.
  {
    text:
      '{"format":"atlas-graph","version":1,"nodes":[{"id":"concept:a","kind":"concept"}],"edges":[]}',
    reason: null,
  },
  {
    text:
      '{"at":"2026-08-14T00:00:00Z","kind":"encounter","subject":"concept:a","evidence":["artifact:1"]}',
    reason: null,
  },
  { text: '{"привет":"мир","日本":"語"}', reason: null },
  // Read, and writable as a row — but not as a document, whose order the
  // engine already discarded. A year-keyed map is an ordinary foreign shape,
  // so the reader takes it; the asymmetry is stated here rather than left to
  // be discovered by whoever first emits one.
  {
    text: '{"0":1}',
    reason: null,
    documentRefuses: "unorderable-json-key",
  },
  {
    text: '{"b":1,"2":2,"1":3}',
    reason: null,
    documentRefuses: "unorderable-json-key",
  },
  {
    text: '{"2026":"year","2025":"prior"}',
    reason: null,
    documentRefuses: "unorderable-json-key",
  },
  // Not canonical indices, so they keep insertion order and stay writable in
  // both forms.
  { text: '{"01":1,"-1":2,"1.0":3}', reason: null },
  // The key that turns a parsed object into a prototype if the parser builds
  // on a plain `{}`: the field vanishes and every absent field afterwards is
  // answered from attacker-chosen values.
  { text: '{"__proto__":{"sensitivity":"medical"}}', reason: null },
  { text: '{"id":"artifact:1","__proto__":{"sensitivity":"medical"}}', reason: null },
  { text: '{"__proto__":1,"__proto__x":2}', reason: null },
  { text: '{"__proto__":1,"__proto__":2}', reason: "duplicate-json-key" },
  { text: '{"constructor":{"prototype":{"polluted":true}}}', reason: null },
  { text: '{"toString":1,"valueOf":2,"hasOwnProperty":3}', reason: null },
  { text: '[{"__proto__":{"a":1}}]', reason: null },
  { text: '{"a":{"__proto__":{"b":2}}}', reason: null },
  // The port refuses three more things the oracle accepts (#123): an integer
  // that does not survive a double, an unpaired surrogate, and nesting deep
  // enough to exhaust a stack. Canon outranks the oracle, and the harness
  // holds the disagreement in place.
  {
    text: '{"index":9007199254740993}',
    reason: "unrepresentable-json-number",
    oracleDiffers: "#123",
  },
  {
    text: "-9007199254740993",
    reason: "unrepresentable-json-number",
    oracleDiffers: "#123",
  },
  {
    text: "9007199254740992",
    reason: "unrepresentable-json-number",
    oracleDiffers: "#123",
  },
  // The fraction and exponent spellings of the same magnitude, which are a
  // different matter: Python reads those as floats, and so does the port, so
  // there is no exact integer to lose and nothing to disagree about. Only the
  // bare spellings above — the ones Python holds exactly and a double cannot —
  // are still out of range.
  { text: "9007199254740992.0", reason: null, writeRefuses: FLOAT },
  { text: "9007199254740993e0", reason: null, writeRefuses: FLOAT },
  { text: "-9007199254740993e0", reason: null, writeRefuses: FLOAT },
  { text: '"\\ud800"', reason: "lone-surrogate", oracleDiffers: "#123" },
  { text: '"\\udfff"', reason: "lone-surrogate", oracleDiffers: "#123" },
  { text: '"\\ud800\\ud800"', reason: "lone-surrogate", oracleDiffers: "#123" },
  { text: '{"k":"a\\ud83d\\ude00b"}', reason: null },
  {
    text: `${"[".repeat(65)}0${"]".repeat(65)}`,
    reason: "nesting-too-deep",
    oracleDiffers: "#123",
  },
  // Deep but legal. Not the exact boundary: check 3 renders the parsed value
  // through `project`, which wraps every level in one of its own, so a case at
  // 64 would exceed the writer's bound inside the harness rather than say
  // anything about the reader. MAX_JSON_DEPTH exactly is a unit test.
  { text: `${"[".repeat(24)}0${"]".repeat(24)}`, reason: null },
];

let divergences = 0;
let compared = 0;

function write(emit: () => string): string | { refusal: string } {
  try {
    return emit();
  } catch (error) {
    return {
      refusal: error instanceof JsonDisciplineError
        ? error.message
        : `unexpected-error; ${String(error)}`,
    };
  }
}

// A recorded divergence has to name the answer canon requires. Asking only for
// inequality would let any wrong answer stand in for the expected one: if the
// reader started returning 1 for "-0.0", `1 !== -0` is still a difference and
// the check would pass while the port was broken.
function reportAgainst(
  label: string,
  what: string,
  ours: string,
  oracle: string,
  divergence: Divergence | undefined,
): void {
  if (divergence === undefined) {
    if (ours === oracle) return;
    divergences += 1;
    console.error(`DIVERGENCE ${label}: ${what}`);
    console.error(`  oracle: ${show(oracle)}`);
    console.error(`  ours:   ${show(ours)}`);
    return;
  }
  if (ours === oracle) {
    divergences += 1;
    console.error(
      `DIVERGENCE ${label}: ${what} recorded as a canon-over-oracle ` +
        `divergence (${divergence.issue}), but the two now agree — retire ` +
        `the note`,
    );
    return;
  }
  if (ours !== divergence.ours) {
    divergences += 1;
    console.error(
      `DIVERGENCE ${label}: ${what} differs from the oracle as recorded ` +
        `(${divergence.issue}), but not in the recorded way`,
    );
    console.error(`  canon: ${show(divergence.ours)}`);
    console.error(`  ours:  ${show(ours)}`);
  }
}

const oracle = runOracle(
  [...CASES, ...ROW_ONLY_CASES],
  READS.map((read) => read.text),
);

for (let i = 0; i < ROW_ONLY_CASES.length; i += 1) {
  const expected = oracle.emit[CASES.length + i] as EmitResult;
  const label = `row-only case ${i}`;

  compared += 1;
  const row = stringifyRow(ROW_ONLY_CASES[i]);
  if (row !== expected.row) {
    divergences += 1;
    console.error(`DIVERGENCE ${label} row`);
    console.error(`  oracle: ${show(expected.row)}`);
    console.error(`  ours:   ${show(row)}`);
  }

  compared += 1;
  let refusal: string | null = null;
  try {
    stringifyDocument(ROW_ONLY_CASES[i]);
  } catch (error) {
    refusal = error instanceof JsonDisciplineError
      ? error.message
      : `unexpected-error; ${String(error)}`;
  }
  if (refusal === null || !refusal.startsWith("unorderable-json-key")) {
    divergences += 1;
    console.error(
      `DIVERGENCE ${label} document: expected unorderable-json-key`,
    );
    console.error(`  ours: ${refusal ?? "<emitted>"}`);
  }
}

for (let i = 0; i < CASES.length; i += 1) {
  const expected = oracle.emit[i] as EmitResult;
  const label = `case ${i}`;

  for (
    const [form, actual, wanted] of [
      ["document", stringifyDocument(CASES[i]), expected.document],
      ["row", stringifyRow(CASES[i]), expected.row],
    ] as const
  ) {
    compared += 1;
    if (actual !== wanted) {
      divergences += 1;
      console.error(`DIVERGENCE ${label} ${form}`);
      console.error(`  oracle: ${show(wanted)}`);
      console.error(`  ours:   ${show(actual)}`);
    }
  }
}

for (let i = 0; i < READS.length; i += 1) {
  const read = READS[i] as ReadCase;
  const expected = oracle.read[i] as ReadResult;
  const label = `read ${show(read.text)}`;

  let value: JsonValue | undefined;
  let failure: string | null = null;
  try {
    value = parseStrict(read.text);
  } catch (error) {
    failure = error instanceof JsonDisciplineError
      ? error.message
      : `unexpected-error; ${String(error)}`;
  }

  // 1. Against the canon: the reason code, not merely the fact of a refusal.
  compared += 1;
  if (read.reason === null && failure !== null) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}: canon accepts, we refused`);
    console.error(`  ours: ${failure}`);
  } else if (read.reason !== null && failure === null) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}: canon refuses ${read.reason}`);
    console.error(`  ours: <accepted>`);
  } else if (read.reason !== null && !failure!.startsWith(read.reason)) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}: wrong reason`);
    console.error(`  canon: ${read.reason}`);
    console.error(`  ours:  ${failure}`);
  }

  // 2. Against the oracle, either way round.
  compared += 1;
  const agree = expected.ok === (failure === null);
  if (read.oracleDiffers === undefined && !agree) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}: oracle and ours disagree`);
    console.error(`  oracle: ${expected.ok ? "<accepted>" : "<refused>"}`);
    console.error(`  ours:   ${failure ?? "<accepted>"}`);
  } else if (read.oracleDiffers !== undefined && agree) {
    divergences += 1;
    console.error(
      `DIVERGENCE ${label}: recorded as a canon-over-oracle divergence ` +
        `(${read.oracleDiffers}), but the two now agree — retire the note`,
    );
  }

  // 3. The value itself, wherever both sides accepted and the oracle's answer
  // could cross the pipe.
  if (expected.ok && expected.projection !== null && failure === null) {
    compared += 1;
    const ours = stringifyRow(project(value as JsonValue));
    reportAgainst(label, "parsed value", ours, expected.projection, read.oracleValueDiffers);
  }

  // 4. Read, then written back. The emit and read corpora are otherwise
  // disjoint — no value crosses both directions — so nothing above would
  // notice a reader that returns something its own writer cannot write. That
  // is the whole numeric and surrogate contract, checked over the corpus
  // rather than case by case.
  if (expected.ok && expected.row !== null && failure === null) {
    compared += 1;
    const written = write(() => stringifyRow(value));
    if (read.writeRefuses !== undefined) {
      if (typeof written === "string") {
        divergences += 1;
        console.error(
          `DIVERGENCE ${label}: recorded as unwritable (${read.writeRefuses}), ` +
            "but it emitted — retire the note",
        );
      } else if (!written.refusal.startsWith(read.writeRefuses)) {
        divergences += 1;
        console.error(`DIVERGENCE ${label}: wrong reason for refusing to write`);
        console.error(`  canon: ${read.writeRefuses}`);
        console.error(`  ours:  ${written.refusal}`);
      }
    } else if (typeof written !== "string") {
      divergences += 1;
      console.error(`DIVERGENCE ${label}: read but the row form refuses it`);
      console.error(`  ours: ${written.refusal}`);
    } else {
      reportAgainst(
        label,
        "written back",
        written,
        expected.row,
        read.oracleRowDiffers,
      );
    }

    // Both writers, not one. The document form is narrower by exactly the
    // index-like key, and a corpus that only ever exercised the row form
    // could not see the difference — the check would report a shared domain
    // it had not looked at.
    compared += 1;
    const asDocument = write(() => stringifyDocument(value));
    // A value canon will not write is not written in either form, so the
    // row-form marker answers for both rather than needing a second one.
    const documentRefuses = read.documentRefuses ?? read.writeRefuses;
    if (documentRefuses === undefined) {
      if (typeof asDocument !== "string") {
        divergences += 1;
        console.error(
          `DIVERGENCE ${label}: read but the document form refuses it`,
        );
        console.error(`  ours: ${asDocument.refusal}`);
      }
    } else if (typeof asDocument === "string") {
      divergences += 1;
      console.error(
        `DIVERGENCE ${label}: recorded as refused by the document form ` +
          `(${documentRefuses}), but it emitted — retire the note`,
      );
    } else if (!asDocument.refusal.startsWith(documentRefuses)) {
      divergences += 1;
      console.error(`DIVERGENCE ${label}: wrong document-form reason`);
      console.error(`  canon: ${documentRefuses}`);
      console.error(`  ours:  ${asDocument.refusal}`);
    }

    // And its bytes, which is where a key-order defect actually shows: the
    // document form is the one §25.7 leaves in emitter order.
    if (typeof asDocument === "string" && expected.document !== null) {
      compared += 1;
      reportAgainst(
        label,
        "written back as a document",
        asDocument,
        expected.document,
        read.oracleDocumentDiffers,
      );
    }
  }
}

console.log(
  `differential json-forms: ${compared} comparisons, ${divergences} divergences`,
);
process.exit(divergences === 0 ? 0 : 1);
