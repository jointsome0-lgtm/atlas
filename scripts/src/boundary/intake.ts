// Applying one versioned intake batch, deterministically (§33.2, #56).
//
// A batch arrives from outside and is treated that way: bounded before it is
// believed, validated record by record against a closed schema, and turned
// into journal rows only after every reference it makes has been resolved
// against ids that already exist. Nothing here interprets a record's meaning —
// the placement rules below are §33.2 transcribed, and the one judgement this
// module makes is which of seven result classes a record landed in.
//
// Two properties are worth naming because they are what the shape of this file
// is for. Determinism: a reference to another record of the same delivery
// resolves in one run, and the outcome never depends on the order records were
// written in. Resumability: every applied record is bracketed by an opened and
// a processed receipt, so a run interrupted anywhere leaves a state the next
// run can describe rather than one it has to guess at.
//
// Ported from scripts/process_intake.py.

import { build } from "../core/build.ts";
import { stringifyRow } from "./canonical-json.ts";
import {
  AtlasIOError,
  AtlasInstance,
  DiagnosticLevel,
  JOURNAL_ROW_BYTES,
  ReasonCode,
  enforceCeiling,
  makeReceiptKey,
} from "./instance.ts";
import { JsonInputError } from "./json-input.ts";
import { journalPaths, readJsonl } from "./journal.ts";
import { compareCodePoint } from "./ordering.ts";
import { AtlasReader, ReaderError } from "./reader.ts";

type Dict = Record<string, unknown>;

// Measured-floor corpus (scripts/test_process_intake.py): the Vera Example
// fixture plus 1,000 dense realistic artifact records. Raw maxima were
// 1,257,100 batch bytes, 1,000 records, 1,256 record bytes, 768 string bytes,
// and depth 5. Values are ~10x headroom rounded to the §20.4/§25.8 family
// (depth follows §20.4's fixed ceiling of 8).
export const INTAKE_BATCH_BYTES = 16_777_216;
export const INTAKE_RECORDS = 16_384;
export const INTAKE_RECORD_BYTES = 16_384;
export const INTAKE_STRING_BYTES = 8_192;
export const INTAKE_NESTING_DEPTH = 8;

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESULT_CLASSES = [
  "applied",
  "replayed",
  "unresolved",
  "unsupported",
  "rejected",
  "interrupted",
  "conflict",
] as const;

const RECORD_DEFINITIONS: ReadonlyMap<string, string> = new Map([
  ["encounter", "encounterRecord"],
  ["artifact", "artifactRecord"],
  ["question", "questionRecord"],
  ["plan", "planRecord"],
]);

const JOURNALS: ReadonlyMap<string, string> = new Map([
  ["encounter", "state/encounters.jsonl"],
  ["artifact", "state/artifacts.jsonl"],
  ["question", "state/questions.jsonl"],
]);

const REGION_KINDS: ReadonlySet<string> = new Set(["concept", "pattern", "zone"]);
const MATERIAL_KINDS: ReadonlySet<string> = new Set(["material", "part"]);
const SOURCE_KINDS: ReadonlySet<string> = new Set(["artifact", "encounter"]);

/** A bounded content-free flow failure. */
export class IntakeFailure extends Error {
  readonly reason: string;
  readonly relativePath: string;

  constructor(reason: string, relativePath = "intake") {
    super(reason);
    this.name = "IntakeFailure";
    this.reason = reason;
    this.relativePath = relativePath;
  }
}

export class InjectedCrash extends IntakeFailure {}

/** Where one record landed, and the row it became if it landed anywhere. */
export interface Placement {
  readonly classification: string;
  readonly reason: string;
  readonly pointer: string;
  readonly row: Dict | null;
}

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `json.dumps` as this repository spells it, as bytes. */
export function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifyRow(value));
}

/** Count nested JSON containers; scalars do not add another level. */
export function maximumDepth(value: unknown): number {
  let maximum = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (isDict(current)) {
      maximum = Math.max(maximum, depth + 1);
      for (const item of Object.values(current)) stack.push([item, depth + 1]);
    } else if (Array.isArray(current)) {
      maximum = Math.max(maximum, depth + 1);
      for (const item of current) stack.push([item, depth + 1]);
    }
  }
  return maximum;
}

/** Every string in the value — object keys included — as byte lengths. */
export function stringSizes(value: unknown): number[] {
  const encoder = new TextEncoder();
  const sizes: number[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      sizes.push(encoder.encode(current).length);
    } else if (isDict(current)) {
      for (const [key, item] of Object.entries(current)) {
        sizes.push(encoder.encode(key).length);
        stack.push(item);
      }
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    }
  }
  return sizes;
}

/**
 * The ceilings a batch answers to before any of it is believed (§25.8).
 *
 * Four of them, because one is not enough: a batch can be small in bytes and
 * still hold a million records, or few records each holding one enormous
 * string, or a modest string nested deeply enough to exhaust a stack while
 * being walked. Each ceiling closes a shape the others leave open.
 */
export function enforceBatchStructure(batch: Dict, display: string): void {
  const records = batch["records"] as unknown[];
  enforceCeiling(records.length, {
    maximum: INTAKE_RECORDS,
    kind: "count",
    relativePath: display,
  });
  records.forEach((record, index) => {
    enforceCeiling(encoded(record).length, {
      maximum: INTAKE_RECORD_BYTES,
      kind: "bytes",
      relativePath: `${display}#${index}`,
    });
  });
  for (const size of stringSizes(batch)) {
    enforceCeiling(size, {
      maximum: INTAKE_STRING_BYTES,
      kind: "bytes",
      relativePath: display,
    });
  }
  enforceCeiling(maximumDepth(batch), {
    maximum: INTAKE_NESTING_DEPTH,
    kind: "count",
    relativePath: display,
  });
}

/** The id one record of one delivery would take, or null for no journal. */
export function mintedId(
  kind: unknown,
  source: string,
  batch: string,
  index: number,
): string | null {
  if (typeof kind !== "string" || !JOURNALS.has(kind)) return null;
  // The trailing source segment count keeps minting injective: slugs may
  // contain hyphens, so "a-b"/"c" and "a"/"b-c" would otherwise collapse into
  // one id while their receipt keys stay distinct.
  const segments = source.split("-").length;
  return `${kind}:${source}-${batch}-${index}-${segments}`;
}

const POINTER_STEP = /\.([A-Za-z0-9_]+)|\[([0-9]+)\]/g;

/** A schema error's path, restated as the JSON Pointer a report carries. */
export function pointerFromSchemaError(error: string, index: number): string {
  const colon = error.indexOf(":");
  const path = colon < 0 ? error : error.slice(0, colon);
  let pointer = `/records/${index}`;
  for (const match of path.matchAll(POINTER_STEP)) {
    pointer += `/${match[1] ?? (match[2] as string)}`;
  }
  return pointer;
}

/** One row of a report's `records` array (§25.7 report-batch). */
export function result(
  index: number,
  key: string,
  classification: string,
  reason: string,
  pointer: string,
  minted: string | null,
): Dict {
  const value: Dict = {
    index,
    intake: key,
    class: classification,
    pointer,
    reason,
  };
  if (minted !== null) value["id"] = minted;
  return value;
}

const kindOf = (nodeId: string): string => nodeId.split(":", 1)[0] as string;

/**
 * What a reference points at, once — and only if — it points at an id.
 *
 * A reference may instead carry a url, a title or bare text (§33.1): those name
 * a material the instance may not have, and inventing an id for one is the
 * adapter's job and not this module's. Anything but a lone `id` is unresolved,
 * which is a report line and not a refusal.
 */
export function resolveReference(
  reference: unknown,
  known: ReadonlyMap<string, string>,
): string | undefined {
  if (!isDict(reference)) return undefined;
  const keys = Object.keys(reference);
  if (keys.length !== 1 || keys[0] !== "id") return undefined;
  const nodeId = reference["id"];
  if (typeof nodeId !== "string") return undefined;
  return known.get(nodeId);
}

/** §32.6: a record's own class, else the delivery's, else nothing. */
function withSensitivity(row: Dict, record: Dict, envelope: Dict): Dict {
  const sensitivity = Object.hasOwn(record, "sensitivity")
    ? record["sensitivity"]
    : envelope["sensitivity"];
  if (sensitivity !== undefined && sensitivity !== null) {
    row["sensitivity"] = sensitivity;
  }
  return row;
}

/** Where one schema-valid record lands, as §33.2 places it. */
export function placeRecord(
  record: Dict,
  envelope: Dict,
  known: ReadonlyMap<string, string>,
  key: string,
  minted: string,
  index: number,
): Placement {
  const pointer = `/records/${index}`;
  const kind = record["kind"];
  if (kind === "plan") {
    return { classification: "unsupported", reason: "unsupported-plan", pointer, row: null };
  }

  if (kind === "encounter") {
    const resolved = resolveReference(record["target"], known);
    if (resolved === undefined) {
      return {
        classification: "unresolved",
        reason: "unresolved-reference",
        pointer: `${pointer}/target`,
        row: null,
      };
    }
    if (!MATERIAL_KINDS.has(kindOf(resolved))) {
      return {
        classification: "unsupported",
        reason: "unsupported-target-kind",
        pointer: `${pointer}/target`,
        row: null,
      };
    }
    const row: Dict = {
      id: minted,
      date: record["date"],
      target: resolved,
      depth: record["depth"],
      mode: "background",
      intake: key,
    };
    return {
      classification: "applied",
      reason: "applied",
      pointer,
      row: withSensitivity(row, record, envelope),
    };
  }

  const refs = (record["refs"] ?? []) as unknown[];
  const resolvedRefs: string[] = [];
  for (const [refIndex, reference] of refs.entries()) {
    const resolved = resolveReference(reference, known);
    if (resolved === undefined) {
      return {
        classification: "unresolved",
        reason: "unresolved-reference",
        pointer: `${pointer}/refs/${refIndex}`,
        row: null,
      };
    }
    resolvedRefs.push(resolved);
  }

  if (kind === "artifact") {
    if (!Object.hasOwn(record, "evidence_strength")) {
      return {
        classification: "unsupported",
        reason: "missing-evidence-strength",
        pointer,
        row: null,
      };
    }
    if (resolvedRefs.some((nodeId) => !REGION_KINDS.has(kindOf(nodeId)))) {
      return {
        classification: "unsupported",
        reason: "unsupported-reference-kind",
        pointer: `${pointer}/refs`,
        row: null,
      };
    }
    const row: Dict = {
      id: minted,
      type: record["type"],
      path: `intake/${envelope["source"] as string}/${envelope["batch"] as string}.json`,
      observed_at: record["date"],
      summary: record["text"],
      touches: resolvedRefs,
      supports_state_updates: [],
      evidence_strength: record["evidence_strength"],
      intake: key,
    };
    return {
      classification: "applied",
      reason: "applied",
      pointer,
      row: withSensitivity(row, record, envelope),
    };
  }

  const sources: Dict = {};
  const pulls: string[] = [];
  for (const nodeId of resolvedRefs) {
    const refKind = kindOf(nodeId);
    if (SOURCE_KINDS.has(refKind)) {
      if (Object.hasOwn(sources, refKind)) {
        return {
          classification: "unsupported",
          reason: "duplicate-question-source-kind",
          pointer: `${pointer}/refs`,
          row: null,
        };
      }
      sources[refKind] = nodeId;
    } else if (REGION_KINDS.has(refKind)) {
      pulls.push(nodeId);
    } else {
      return {
        classification: "unsupported",
        reason: "unsupported-reference-kind",
        pointer: `${pointer}/refs`,
        row: null,
      };
    }
  }
  if (Object.keys(sources).length === 0) {
    return {
      classification: "unsupported",
      reason: "missing-question-source",
      pointer: `${pointer}/refs`,
      row: null,
    };
  }
  const row: Dict = {
    id: minted,
    type: "question",
    text: record["text"],
    created_at: record["date"],
    pulls,
    source: sources,
    intake: key,
  };
  return {
    classification: "applied",
    reason: "applied",
    pointer,
    row: withSensitivity(row, record, envelope),
  };
}

/**
 * Every id a reference may name, mapped to the id it resolves to.
 *
 * §33.2: an interrupted record's outputs await the user's explicit
 * reconciliation — a journal row whose intake key has no processed receipt must
 * not resolve references (the caller passes those ids as withheld), or later
 * records would silently build on state the user has not resolved.
 */
export function loadKnownIds(
  instance: AtlasInstance,
  withheld: ReadonlySet<string>,
): Map<string, string> {
  let built: ReturnType<typeof build>;
  try {
    built = build(`${instance.root}/atlas`);
  } catch (error) {
    if (error instanceof AtlasIOError || error instanceof IntakeFailure) throw error;
    throw new IntakeFailure("instance-state-invalid");
  }
  if (built.errors.length > 0) throw new IntakeFailure("instance-state-invalid");
  const known = new Map<string, string>();
  for (const node of built.graph["nodes"] as Dict[]) {
    const nodeId = node["id"] as string;
    if (withheld.has(nodeId)) continue;
    known.set(nodeId, nodeId);
    for (const retired of (node["formerly"] ?? []) as string[]) {
      known.set(retired, nodeId);
    }
  }
  return known;
}

/**
 * Refuse symlinks and special files under the resolution input roots.
 *
 * §24.2 containment: reference resolution must not trust ids reachable only
 * through a symlink out of the instance or ignore boundary. The same shared
 * lstat/no-follow walker used by the validator and builder checks the whole
 * input tree before any id is loaded.
 */
export function preflightTree(instance: AtlasInstance): void {
  try {
    const reader = new AtlasReader(instance.root);
    for (const top of ["atlas", "state"]) {
      reader.scan(top, { recursive: true });
    }
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    throw new AtlasIOError({
      reason: ReasonCode.UnsafePath,
      level: DiagnosticLevel.Error,
      relativePath: error.relativePath,
      recordIndex: null,
    });
  }
}

/** Map every journal row's intake key to its (record kind, row). */
export function journalOutputs(
  instance: AtlasInstance,
): Map<string, [string, Dict]> {
  const outputs = new Map<string, [string, Dict]>();
  let relative = "state";
  try {
    const reader = new AtlasReader(instance.root);
    for (const [stem, kind] of [
      ["encounters", "encounter"],
      ["artifacts", "artifact"],
      ["questions", "question"],
    ] as const) {
      for (const found of journalPaths(reader, stem)) {
        relative = found.relativePath;
        for (const { row } of readJsonl(found)) {
          if (isDict(row) && typeof row["intake"] === "string") {
            outputs.set(row["intake"], [kind, row as Dict]);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof ReaderError) {
      throw new AtlasIOError({
        reason: ReasonCode.UnsafePath,
        level: DiagnosticLevel.Error,
        relativePath: error.relativePath,
        recordIndex: null,
      });
    }
    if (error instanceof JsonInputError) {
      throw new AtlasIOError({
        reason: ReasonCode.InvalidJsonl,
        level: DiagnosticLevel.Error,
        relativePath: relative,
        recordIndex: null,
      });
    }
    throw error;
  }
  return outputs;
}

/**
 * Structural equality the way the oracle's `==` answers it.
 *
 * One rule is not JavaScript's: Python's booleans are integers, so `True == 1`
 * there and `true !== 1` here. A durable row holding one where the record
 * produces the other would replay clean on one side and conflict on the other,
 * which is a difference about the data and not about the language.
 */
export function pythonEqual(left: unknown, right: unknown): boolean {
  const number = (value: unknown): number | null =>
    typeof value === "number"
      ? value
      : typeof value === "boolean"
        ? Number(value)
        : null;
  const leftNumber = number(left);
  const rightNumber = number(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => pythonEqual(item, right[index]))
    );
  }
  if (isDict(left) || isDict(right)) {
    if (!isDict(left) || !isDict(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) => Object.hasOwn(right, key) && pythonEqual(left[key], right[key]),
      )
    );
  }
  return left === right;
}

/** Both sides' reference ids mapped through the current retirement resolution. */
function resolvedThrough(value: unknown, known: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return known.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => resolvedThrough(item, known));
  if (isDict(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, resolvedThrough(item, known)]),
    );
  }
  return value;
}

/**
 * Check a replayed record still matches its recorded durable output.
 *
 * Every field is compared, reference fields included — an edited ref must
 * conflict like an edited text. Both sides' reference ids are mapped through
 * the current retirement resolution first, so a §34.4 rename between the
 * original run and the replay is not a false drift.
 */
export function replayMatches(
  instance: AtlasInstance,
  record: unknown,
  envelope: Dict,
  known: ReadonlyMap<string, string>,
  key: string,
  minted: string | null,
  index: number,
  recorded: [string, Dict] | undefined,
): boolean {
  if (recorded === undefined || !isDict(record)) return false;
  const [kind, row] = recorded;
  if (record["kind"] !== kind || row["id"] !== minted) return false;
  const definition = RECORD_DEFINITIONS.get(kind);
  if (
    definition === undefined ||
    instance.schemaErrors(record, "atlas-intake", { definition }).length > 0
  ) {
    return false;
  }
  const placement = placeRecord(record, envelope, known, key, minted as string, index);
  if (placement.row === null) return false;
  const reference = new Set(ROW_REFERENCE_FIELDS.get(kind) ?? []);

  const project = (value: Dict): Dict =>
    Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        reference.has(field) ? resolvedThrough(item, known) : item,
      ]),
    );
  return pythonEqual(project(placement.row), project(row));
}

/** A crash injected at a named point, for the §33.2 resumability proofs. */
export function crash(point: string, index: number): void {
  if (process.env["ATLAS_INTAKE_CRASH"] === `${point}:${index}`) {
    throw new InjectedCrash("injected-crash");
  }
}

/** One report over one delivery, with its class tally (§25.7 report-batch). */
export function makeReport(source: string, batch: string, records: Dict[]): Dict {
  const counts: Dict = {};
  for (const name of RESULT_CLASSES) counts[name] = 0;
  for (const record of records) {
    const name = record["class"] as string;
    counts[name] = (counts[name] as number) + 1;
  }
  return {
    format: "report-batch",
    version: 1,
    source,
    batch,
    records,
    counts: { total: records.length, ...counts },
  };
}

/** A report in which the whole delivery is refused, record by record. */
export function conflictReport(
  envelope: Dict,
  classification = "conflict",
  reason = "batch-content-conflict",
): Dict {
  const records: Dict[] = [];
  const source = envelope["source"] as string;
  const batch = envelope["batch"] as string;
  (envelope["records"] as unknown[]).forEach((record, index) => {
    const key = makeReceiptKey(source, batch, index);
    records.push(
      result(
        index,
        key,
        classification,
        reason,
        `/records/${index}`,
        mintedId(isDict(record) ? record["kind"] : null, source, batch, index),
      ),
    );
  });
  return makeReport(source, batch, records);
}

/**
 * Classify pending records against a fixpoint of intra-batch ids.
 *
 * §33.2 determinism: a reference to any other record of the same delivery
 * resolves in one run — the candidate set starts as every pending record's
 * minted id (self excluded) and shrinks as records fail, so the outcome never
 * depends on record order or on a second pass over the batch.
 */
export function classifyPending(
  instance: AtlasInstance,
  envelope: Dict,
  known: ReadonlyMap<string, string>,
  pending: Map<number, [Dict, string]>,
): { placements: Map<number, Placement>; failures: Map<number, Dict> } {
  const source = envelope["source"] as string;
  const batch = envelope["batch"] as string;
  const failures = new Map<number, Dict>();
  const surviving = new Map(pending);
  for (;;) {
    const placements = new Map<number, Placement>();
    const candidateIds = new Map<string, string>();
    for (const [, minted] of surviving.values()) candidateIds.set(minted, minted);
    let changed = false;
    for (const [index, [record, minted]] of [...surviving]) {
      const key = makeReceiptKey(source, batch, index);
      const resolution = new Map([...candidateIds, ...known]);
      resolution.delete(minted);
      const placement = placeRecord(record, envelope, resolution, key, minted, index);
      let failure: Dict | null = null;
      if (placement.row === null) {
        failure = result(
          index,
          key,
          placement.classification,
          placement.reason,
          placement.pointer,
          minted,
        );
      } else {
        const kind = record["kind"] as string;
        try {
          enforceCeiling(encoded(placement.row).length, {
            maximum: JOURNAL_ROW_BYTES,
            kind: "bytes",
            relativePath: JOURNALS.get(kind) as string,
          });
          if (instance.schemaErrors(placement.row, `journal-${kind}`).length > 0) {
            failure = result(
              index,
              key,
              "rejected",
              "derived-row-invalid",
              `/records/${index}`,
              minted,
            );
          }
        } catch (error) {
          if (!(error instanceof AtlasIOError)) throw error;
          failure = result(
            index,
            key,
            "rejected",
            "derived-row-too-large",
            `/records/${index}`,
            minted,
          );
        }
      }
      if (failure !== null) {
        failures.set(index, failure);
        surviving.delete(index);
        changed = true;
      } else {
        placements.set(index, placement);
      }
    }
    if (!changed) return { placements, failures };
  }
}

// The rows' structural reference fields — free text (summary, text) is data and
// never creates a dependency, even when it equals a minted id verbatim.
const ROW_REFERENCE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["encounter", ["target"]],
  ["artifact", ["touches"]],
  ["question", ["pulls", "source"]],
]);

function rowReferenceIds(kind: string, row: Dict): Set<string> {
  const ids = new Set<string>();
  for (const field of ROW_REFERENCE_FIELDS.get(kind) ?? []) {
    const value = row[field];
    if (typeof value === "string") ids.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") ids.add(item);
    } else if (isDict(value)) {
      for (const item of Object.values(value)) {
        if (typeof item === "string") ids.add(item);
      }
    }
  }
  return ids;
}

/**
 * Order appends so an intra-batch dependency is durable first.
 *
 * A crash between two records must never leave a processed dependent citing a
 * minted id whose own record stayed interrupted or unwritten — dependencies
 * commit before dependents, ties break by record index. The closed record
 * family cannot form reference cycles (only questions cite other records); an
 * impossible cycle still fails closed.
 */
export function appendOrder(
  pending: ReadonlyMap<number, [Dict, string]>,
  placements: ReadonlyMap<number, Placement>,
): number[] {
  const mintedToIndex = new Map<string, number>();
  for (const [index, [, minted]] of pending) {
    if (placements.has(index)) mintedToIndex.set(minted, index);
  }
  const dependencies = new Map<number, number[]>();
  for (const [index, placement] of placements) {
    const kind = (pending.get(index) as [Dict, string])[0]["kind"] as string;
    const referenced = [...rowReferenceIds(kind, placement.row as Dict)].sort(
      compareCodePoint,
    );
    dependencies.set(
      index,
      referenced
        .filter((ref) => mintedToIndex.has(ref) && mintedToIndex.get(ref) !== index)
        .map((ref) => mintedToIndex.get(ref) as number),
    );
  }
  const order: number[] = [];
  const done = new Set<number>();
  let remaining = [...placements.keys()].sort((left, right) => left - right);
  while (remaining.length > 0) {
    const deferred: number[] = [];
    for (const index of remaining) {
      if ((dependencies.get(index) as number[]).every((dep) => done.has(dep))) {
        order.push(index);
        done.add(index);
      } else {
        deferred.push(index);
      }
    }
    if (deferred.length === remaining.length) throw new IntakeFailure("reference-cycle");
    remaining = deferred;
  }
  return order;
}

/** Apply one delivery's records; the flag says the whole batch was refused. */
export function processRecords(
  instance: AtlasInstance,
  envelope: Dict,
): { report: Dict; conflict: boolean } {
  const source = envelope["source"] as string;
  const batch = envelope["batch"] as string;
  const receiptStatus = instance.receiptStatus();
  // §33.2: a batch id names one immutable delivery — a receipt recorded beyond
  // the current record range means the canonical original no longer matches
  // what the receipts covered (e.g. a truncated file), so the whole batch fails
  // closed instead of reporting a clean partial replay that hides recorded rows.
  const prefix = `${source}/${batch}#`;
  const total = (envelope["records"] as unknown[]).length;
  const recorded = new Set([...receiptStatus.opened, ...receiptStatus.processed]);
  for (const key of recorded) {
    if (key.startsWith(prefix) && Number(key.slice(key.lastIndexOf("#") + 1)) >= total) {
      return { report: conflictReport(envelope), conflict: true };
    }
  }
  preflightTree(instance);
  const outputs = journalOutputs(instance);
  const withheld = new Set<string>();
  for (const key of receiptStatus.interrupted) {
    const output = outputs.get(key);
    if (output !== undefined && typeof output[1]["id"] === "string") {
      withheld.add(output[1]["id"]);
    }
  }
  const known = loadKnownIds(instance, withheld);
  const results = new Map<number, Dict>();
  const pending = new Map<number, [Dict, string]>();

  for (const [index, record] of (envelope["records"] as unknown[]).entries()) {
    const key = makeReceiptKey(source, batch, index);
    const pointer = `/records/${index}`;
    const kind = isDict(record) ? record["kind"] : undefined;
    const minted = mintedId(kind, source, batch, index);

    if (receiptStatus.processed.has(key)) {
      // §33.2: the receipt alone does not prove the current record is the one
      // it covered — an in-place edit of the canonical original with the same
      // record count must not replay clean.
      if (
        !replayMatches(
          instance,
          record,
          envelope,
          known,
          key,
          minted,
          index,
          outputs.get(key),
        )
      ) {
        return { report: conflictReport(envelope), conflict: true };
      }
      results.set(
        index,
        result(index, key, "replayed", "processed-receipt", pointer, minted),
      );
      continue;
    }
    if (receiptStatus.interrupted.has(key)) {
      results.set(
        index,
        result(index, key, "interrupted", "interrupted-receipt", pointer, minted),
      );
      continue;
    }

    const definition =
      typeof kind === "string" ? RECORD_DEFINITIONS.get(kind) : undefined;
    if (definition === undefined) {
      results.set(
        index,
        result(index, key, "rejected", "schema-invalid", `${pointer}/kind`, minted),
      );
      continue;
    }
    const schemaErrors = instance.schemaErrors(record, "atlas-intake", { definition });
    if (schemaErrors.length > 0) {
      results.set(
        index,
        result(
          index,
          key,
          "rejected",
          "schema-invalid",
          pointerFromSchemaError(schemaErrors[0] as string, index),
          minted,
        ),
      );
      continue;
    }

    if (minted !== null && known.has(minted)) {
      results.set(index, result(index, key, "conflict", "id-conflict", pointer, minted));
      continue;
    }

    if (kind === "plan") {
      results.set(
        index,
        result(index, key, "unsupported", "unsupported-plan", pointer, minted),
      );
      continue;
    }
    pending.set(index, [record as Dict, minted as string]);
  }

  const { placements, failures } = classifyPending(instance, envelope, known, pending);
  for (const [index, failure] of failures) results.set(index, failure);

  for (const index of appendOrder(pending, placements)) {
    const [record] = pending.get(index) as [Dict, string];
    const key = makeReceiptKey(source, batch, index);
    const kind = record["kind"] as string;
    crash("before-opened", index);
    instance.appendReceipt(key, "opened", record["date"] as string);
    crash("after-opened", index);
    instance.appendRecord(
      JOURNALS.get(kind) as string,
      (placements.get(index) as Placement).row as Dict,
    );
    crash("after-output", index);
    crash("before-processed", index);
    instance.appendReceipt(key, "processed", record["date"] as string);
    results.set(
      index,
      result(
        index,
        key,
        "applied",
        "applied",
        `/records/${index}`,
        (pending.get(index) as [Dict, string])[1],
      ),
    );
  }

  const ordered = [...results.keys()].sort((left, right) => left - right);
  return {
    report: makeReport(
      source,
      batch,
      ordered.map((index) => results.get(index) as Dict),
    ),
    conflict: false,
  };
}
