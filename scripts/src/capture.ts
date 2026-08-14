// Appending one explicitly authored journal row (§13.2/§33.2/§12.4, #47).
//
// The manual lane and the intake lane end in the same place — a row in a
// journal, bracketed by two receipts — and differ in who wrote the record. Here
// the user did, by hand, and that changes what the tool owes them: the record
// is taken as authored rather than translated, its ids are the ones they typed
// rather than ones this program minted, and a dry run is the default so that
// the answer to "is this right" costs nothing.
//
// What it shares with intake is the part that must not diverge: the same
// resolution of retired ids, the same withholding of ids an interrupted record
// wrote, the same receipt transition, and the same report format. Those come
// from intake.ts rather than being written twice.
//
// Ported from scripts/append_record.py.

import fs from "node:fs";

import {
  AtlasIOError,
  AtlasInstance,
  DiagnosticLevel,
  JOURNAL_ROW_BYTES,
  ReasonCode,
  enforceCeiling,
  formatDiagnostics,
  makeReceiptKey,
} from "./instance.ts";
import {
  IntakeFailure,
  encoded,
  journalOutputs,
  loadKnownIds,
  maximumDepth,
  preflightTree,
  pythonEqual,
  stringSizes,
} from "./intake.ts";

type Dict = Record<string, unknown>;

// Measured-floor corpus (scripts/test_append_record.py): three realistic dense
// Vera Example journal rows. Raw maxima were 1,152 record-file bytes, 768
// string bytes, and depth 2. Values are ~10x headroom rounded to the
// §20.4/§25.8 family (depth follows §20.4's fixed ceiling of 8).
export const MANUAL_RECORD_BYTES = 16_384;
export const MANUAL_STRING_BYTES = 8_192;
export const MANUAL_NESTING_DEPTH = 8;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPORT_ID = /^(?:artifact|encounter|question):[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESULT_CLASSES = [
  "applied",
  "replayed",
  "unresolved",
  "unsupported",
  "rejected",
  "interrupted",
  "conflict",
] as const;

const ROUTES: ReadonlyMap<string, string> = new Map([
  ["encounter", "state/encounters.jsonl"],
  ["artifact", "state/artifacts.jsonl"],
  ["question", "state/questions.jsonl"],
]);

const DATES: ReadonlyMap<string, string> = new Map([
  ["encounter", "date"],
  ["artifact", "observed_at"],
  ["question", "created_at"],
]);

// Every id-bearing journal field is resolved, including the fields named by the
// manual-lane contract and the artifact schema's two additional id fields.
const REFERENCE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["encounter", ["target", "context"]],
  ["artifact", ["touches", "supports_state_updates", "probe"]],
  ["question", ["pulls", "source"]],
]);

interface Arguments {
  readonly root: string;
  readonly recordFile: string;
  readonly key: string | null;
  readonly commit: boolean;
}

interface Prepared {
  readonly kind: string;
  readonly destination: string;
  readonly row: Dict;
  readonly date: string;
}

/** One report-shaped, content-free refusal. */
export class ManualFailure extends Error {
  readonly classification: string;
  readonly reason: string;
  readonly pointer: string;

  constructor(classification: string, reason: string, pointer = "/records/0") {
    super(reason);
    this.name = "ManualFailure";
    this.classification = classification;
    this.reason = reason;
    this.pointer = pointer;
  }
}

/** A content-free failure that has no report-batch reason code. */
export class ManualRuntimeFailure extends Error {}

export class InjectedCrash extends ManualRuntimeFailure {}

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The components of a path, as the oracle's path type splits them. */
const pathParts = (path: string): string[] =>
  path.split("/").filter((part) => part !== "" && part !== ".");

/** The three arguments and two options, or nothing. */
export function parseArgs(args: readonly string[]): Arguments | null {
  if (args.length === 0 || (args[0] as string).startsWith("-") || args[0] === "") {
    return null;
  }
  const root = args[0] as string;
  let recordFile: string | null = null;
  let key: string | null = null;
  let commit = false;
  let index = 1;
  while (index < args.length) {
    const option = args[index] as string;
    if (option === "--commit") {
      if (commit) return null;
      commit = true;
      index += 1;
      continue;
    }
    if (
      (option !== "--record-file" && option !== "--key") ||
      index + 1 >= args.length
    ) {
      return null;
    }
    const value = args[index + 1] as string;
    if (value === "" || value.startsWith("-")) return null;
    if (option === "--record-file") {
      if (recordFile !== null) return null;
      recordFile = value;
    } else {
      if (key !== null || !SLUG.test(value)) return null;
      key = value;
    }
    index += 2;
  }
  if (recordFile === null || (commit && key === null)) return null;
  return { root, recordFile, key, commit };
}

/**
 * Refuse `..` before the path is resolved at all.
 *
 * The instance's own containment would catch a traversal that lands outside,
 * but only after resolving it — and a `..` in an argument is a mistake worth
 * naming as one rather than a path worth following to see where it ends up.
 */
function refuseLexicalTraversal(path: string, reason: ReasonCode): void {
  if (pathParts(path).includes("..")) {
    throw new AtlasIOError({
      reason,
      level: DiagnosticLevel.Error,
      relativePath: ".",
      recordIndex: null,
    });
  }
}

/** The two ceilings a hand-authored record answers to beyond its bytes. */
function enforceStructure(value: unknown): void {
  for (const size of stringSizes(value)) {
    enforceCeiling(size, {
      maximum: MANUAL_STRING_BYTES,
      kind: "bytes",
      relativePath: "record-file",
    });
  }
  enforceCeiling(maximumDepth(value), {
    maximum: MANUAL_NESTING_DEPTH,
    kind: "count",
    relativePath: "record-file",
  });
}

/** Which journal an authored record belongs in, decided by its own id. */
function route(value: unknown): [string, string] {
  if (!isDict(value)) throw new ManualFailure("rejected", "schema-invalid");
  const nodeId = value["id"];
  if (typeof nodeId !== "string") {
    throw new ManualFailure("rejected", "schema-invalid", "/records/0/id");
  }
  const kind = nodeId.includes(":") ? (nodeId.split(":", 1)[0] as string) : "";
  const destination = ROUTES.get(kind);
  if (destination === undefined) {
    throw new ManualFailure("rejected", "schema-invalid", "/records/0/id");
  }
  return [kind, destination];
}

const POINTER_STEP = /\.([A-Za-z0-9_]+)|\[([0-9]+)\]/g;

function pointerFromSchemaError(error: string): string {
  const colon = error.indexOf(":");
  const path = colon < 0 ? error : error.slice(0, colon);
  let pointer = "/records/0";
  for (const match of path.matchAll(POINTER_STEP)) {
    pointer += `/${match[1] ?? (match[2] as string)}`;
  }
  return pointer;
}

/** Every id in a reference field, replaced by the id it resolves to. */
function resolveValue(
  value: unknown,
  known: ReadonlyMap<string, string>,
  pointer: string,
): unknown {
  if (typeof value === "string") {
    const resolved = known.get(value);
    if (resolved === undefined) {
      throw new ManualFailure("unresolved", "unresolved-reference", pointer);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveValue(item, known, `${pointer}/${index}`));
  }
  if (isDict(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        resolveValue(item, known, `${pointer}/${name}`),
      ]),
    );
  }
  // The closed journal schema prevents this path; retaining it here keeps
  // resolution fail-closed if a caller changes validation order later.
  throw new ManualFailure("rejected", "schema-invalid", pointer);
}

function resolveReferences(
  kind: string,
  row: Dict,
  known: ReadonlyMap<string, string>,
): Dict {
  const resolved: Dict = { ...row };
  for (const field of REFERENCE_FIELDS.get(kind) ?? []) {
    if (Object.hasOwn(resolved, field)) {
      resolved[field] = resolveValue(resolved[field], known, `/records/0/${field}`);
    }
  }
  return resolved;
}

/** The same mapping, but tolerating an id nothing answers — for comparison. */
function normalizedReferences(
  kind: string,
  row: Dict,
  known: ReadonlyMap<string, string>,
): Dict {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return known.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalize);
    if (isDict(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, normalize(item)]),
      );
    }
    return value;
  };
  const fields = new Set(REFERENCE_FIELDS.get(kind) ?? []);
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      fields.has(name) ? normalize(value) : value,
    ]),
  );
}

function replayMatches(
  expected: Prepared,
  recorded: [string, Dict] | undefined,
  known: ReadonlyMap<string, string>,
): boolean {
  if (recorded === undefined) return false;
  const [kind, durable] = recorded;
  return (
    kind === expected.kind &&
    pythonEqual(
      normalizedReferences(kind, expected.row, known),
      normalizedReferences(kind, durable, known),
    )
  );
}

function result(
  key: string,
  classification: string,
  reason: string,
  pointer: string,
  nodeId: string | null,
): Dict {
  const value: Dict = {
    index: 0,
    intake: key,
    class: classification,
    pointer,
    reason,
  };
  if (nodeId !== null && REPORT_ID.test(nodeId)) value["id"] = nodeId;
  return value;
}

function report(batch: string, outcome: Dict): Dict {
  const counts: Dict = {};
  for (const name of RESULT_CLASSES) counts[name] = 0;
  counts[outcome["class"] as string] = 1;
  return {
    format: "report-batch",
    version: 1,
    source: "manual",
    batch,
    records: [outcome],
    counts: { total: 1, ...counts },
  };
}

function emitReport(instance: AtlasInstance, value: Dict): void {
  instance.validateFormat(value);
  process.stdout.write(`${new TextDecoder().decode(encoded(value))}\n`);
}

function emitFailure(failure: ManualFailure | ManualRuntimeFailure): void {
  if (failure instanceof ManualFailure) {
    process.stderr.write(
      `ERROR: record-file: ${failure.reason}; pointer ${failure.pointer}\n`,
    );
  } else {
    process.stderr.write(`ERROR: instance: ${failure.message}\n`);
  }
}

/**
 * Everything that has to be true before a row is written, and the outcome if
 * the answer is already settled.
 *
 * Returned rather than acted on: the dry run and the commit ask exactly the
 * same questions, and the only difference between them is what happens after
 * this returns. A second code path here would be a second set of answers.
 */
function prepare(
  instance: AtlasInstance,
  value: Dict,
  kind: string,
  destination: string,
  receiptKey: string | null,
): [Prepared, Dict | null] {
  let row: Dict = { ...value };
  if (Object.hasOwn(row, "intake")) {
    throw new ManualFailure("rejected", "schema-invalid", "/records/0/intake");
  }
  if (receiptKey !== null) row["intake"] = receiptKey;

  const errors = instance.schemaErrors(row, `journal-${kind}`);
  if (errors.length > 0) {
    throw new ManualFailure(
      "rejected",
      "schema-invalid",
      pointerFromSchemaError(errors[0] as string),
    );
  }
  const tooLarge = (candidate: Dict): void => {
    try {
      enforceCeiling(encoded(candidate).length, {
        maximum: JOURNAL_ROW_BYTES,
        kind: "bytes",
        relativePath: destination,
      });
    } catch (error) {
      if (!(error instanceof AtlasIOError)) throw error;
      throw new ManualFailure("rejected", "derived-row-too-large");
    }
  };
  tooLarge(row);

  preflightTree(instance);
  const receiptStatus = instance.receiptStatus();
  const outputs = journalOutputs(instance);
  const withheld = new Set<string>();
  for (const key of receiptStatus.interrupted) {
    const output = outputs.get(key);
    if (output !== undefined && typeof output[1]["id"] === "string") {
      withheld.add(output[1]["id"]);
    }
  }
  let known: Map<string, string>;
  try {
    known = loadKnownIds(instance, withheld);
  } catch (error) {
    if (!(error instanceof IntakeFailure)) throw error;
    throw new ManualRuntimeFailure(error.reason);
  }

  row = resolveReferences(kind, row, known);
  const prepared: Prepared = {
    kind,
    destination,
    row,
    date: row[DATES.get(kind) as string] as string,
  };
  tooLarge(row);

  if (receiptKey !== null && receiptStatus.processed.has(receiptKey)) {
    if (!replayMatches(prepared, outputs.get(receiptKey), known)) {
      throw new ManualFailure("conflict", "batch-content-conflict");
    }
    return [
      prepared,
      result(
        receiptKey,
        "replayed",
        "processed-receipt",
        "/records/0",
        (row["id"] ?? null) as string | null,
      ),
    ];
  }
  if (receiptKey !== null && receiptStatus.interrupted.has(receiptKey)) {
    throw new ManualFailure("interrupted", "interrupted-receipt");
  }
  if (known.has(row["id"] as string)) {
    throw new ManualFailure("conflict", "id-conflict");
  }
  return [prepared, null];
}

function crash(point: string): void {
  if (process.env["ATLAS_MANUAL_CRASH"] === `${point}:0`) {
    throw new InjectedCrash("injected-crash");
  }
}

/**
 * What this run is about to do, before it does any of it.
 *
 * Printed unconditionally and before the lock, because the one thing a person
 * committing by hand needs to see is which instance they are writing to — and
 * they need to see it whether or not the run then succeeds.
 */
function headers(
  instance: AtlasInstance,
  destination: string,
  receiptKey: string | null,
): void {
  process.stdout.write(`instance: ${instance.root}\n`);
  process.stdout.write(`destination: ${destination}\n`);
  process.stdout.write(
    `backup: ${fs.existsSync(`${instance.root}/.git`) ? "git" : "none"}\n`,
  );
  if (receiptKey !== null) process.stdout.write(`key: ${receiptKey}\n`);
}

export function main(argv: readonly string[], program: string): number {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(
      `usage: ${program} INSTANCE_ROOT --record-file PATH [--key KEY] [--commit]\n` +
        "\n" +
        "Validate one authored encounter, artifact, or question row. " +
        "Dry-run is the default.\n" +
        "--commit requires --key; prefer a §34.6 date-serial key such as " +
        "2026-07-20-001.\n",
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(
      `ERROR: usage: ${program} INSTANCE_ROOT --record-file PATH ` +
        "[--key KEY] [--commit]\n",
    );
    process.stderr.write(
      "ERROR: key: use a §34.6 date-serial slug such as 2026-07-20-001\n",
    );
    return 2;
  }

  let instance: AtlasInstance | null = null;
  let nodeId: unknown = null;
  let receiptKey: string | null = null;
  try {
    refuseLexicalTraversal(parsed.root, ReasonCode.InvalidRoot);
    refuseLexicalTraversal(parsed.recordFile, ReasonCode.UnsafePath);
    instance = new AtlasInstance(parsed.root);
    const delivered = instance.readDeliveredJson(parsed.recordFile, {
      maxBytes: MANUAL_RECORD_BYTES,
      delivered: false,
    });
    const value = delivered.value;
    enforceStructure(value);
    if (isDict(value)) nodeId = value["id"];
    const [kind, destination] = route(value);
    if (parsed.key !== null) receiptKey = makeReceiptKey("manual", parsed.key, 0);
    headers(instance, destination, receiptKey);

    if (parsed.commit) {
      const written = instance.withLock(() => {
        const [prepared, replayed] = prepare(
          instance as AtlasInstance,
          value as Dict,
          kind,
          destination,
          receiptKey,
        );
        if (replayed !== null) return replayed;
        const key = receiptKey as string;
        crash("before-opened");
        (instance as AtlasInstance).appendReceipt(key, "opened", prepared.date);
        crash("after-opened");
        (instance as AtlasInstance).appendRecord(prepared.destination, prepared.row);
        crash("after-output");
        crash("before-processed");
        (instance as AtlasInstance).appendReceipt(key, "processed", prepared.date);
        return result(
          key,
          "applied",
          "applied",
          "/records/0",
          prepared.row["id"] as string,
        );
      });
      emitReport(instance, report(parsed.key as string, written));
      return 0;
    }

    const [, outcome] = prepare(instance, value as Dict, kind, destination, receiptKey);
    if (outcome !== null) {
      emitReport(instance, report(parsed.key as string, outcome));
      return 0;
    }
    process.stdout.write("result: valid\n");
    return 0;
  } catch (error) {
    if (error instanceof ManualFailure) {
      emitFailure(error);
      if (instance !== null && parsed.key !== null) {
        const key = receiptKey ?? makeReceiptKey("manual", parsed.key, 0);
        emitReport(
          instance,
          report(
            parsed.key,
            result(
              key,
              error.classification,
              error.reason,
              error.pointer,
              typeof nodeId === "string" ? nodeId : null,
            ),
          ),
        );
      }
      return 1;
    }
    if (error instanceof ManualRuntimeFailure) {
      emitFailure(error);
      return 1;
    }
    if (error instanceof AtlasIOError) {
      process.stderr.write(`${formatDiagnostics(error.diagnostic)}\n`);
      return 1;
    }
    // The oracle names four exception types here; this names none, for the
    // reason the intake lane gives at the same place: an unforeseen failure
    // owes the caller one bounded line, not a traceback (§24.4).
    process.stderr.write(
      "ERROR: instance: processing-failed; expected a complete " +
        "deterministic manual append\n",
    );
    return 1;
  }
}
