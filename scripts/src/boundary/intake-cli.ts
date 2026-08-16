// §33.2: the intake command line.
//
// One delivery, one lock, one report. Everything that decides an outcome
// happens while the lock is held — reading the batch, preserving the canonical
// original, and applying the records — and the report is printed after the lock
// is gone, so a reader of the output is never waiting on a writer.
//
// The order of the checks before the records is the contract and is preserved
// exactly. A delivery claiming a reserved direct-lane source is refused in the
// report rather than by the schema; a batch that names itself something other
// than what was asked for is refused before anything is preserved; and the
// canonical original is written only once every one of those has passed.
//
// Ported from main and its helpers in scripts/process_intake.py.

import {
  AtlasIOError,
  AtlasInstance,
  RESERVED_RECEIPT_NAMESPACES,
  ReasonCode,
  formatDiagnostics,
} from "./instance.ts";
import {
  INTAKE_BATCH_BYTES,
  IntakeFailure,
  SLUG,
  conflictReport,
  enforceBatchStructure,
  encoded,
  processRecords,
} from "./intake.ts";
import { abspath } from "./paths.ts";

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What one locked flow decided, which is all the caller needs afterwards. */
interface Outcome {
  readonly report: Dict;
  readonly wholeConflict: boolean;
  readonly refusalLine: string;
}

/** The three arguments, or nothing — there is no other accepted shape. */
export function parseArgs(args: readonly string[]): [string, string, string] | null {
  if (args.length !== 3 || (args[1] !== "--batch-file" && args[1] !== "--batch")) {
    return null;
  }
  if (args[0] === "" || args[2] === "") return null;
  if (args[1] === "--batch") {
    const parts = (args[2] as string).split("/");
    if (parts.length !== 2 || !parts.every((part) => SLUG.test(part))) return null;
  }
  return [args[0] as string, args[1] as string, args[2] as string];
}

/** Whether `path` is `root` or lies beneath it, lexically (`relative_to`). */
function isUnder(path: string, root: string): boolean {
  const parts = path.split("/");
  const rootParts = root.split("/");
  return (
    parts.length >= rootParts.length &&
    rootParts.every((part, index) => parts[index] === part)
  );
}

function emitRecordDiagnostics(report: Dict): void {
  for (const record of report["records"] as Dict[]) {
    const classification = record["class"] as string;
    if (classification !== "applied" && classification !== "replayed") {
      process.stderr.write(
        `ERROR: intake/${report["source"] as string}/${report["batch"] as string}` +
          `.json#${record["index"] as number}: ${record["reason"] as string}; ` +
          `pointer ${record["pointer"] as string}\n`,
      );
    }
  }
}

/** A report is only printed once the instance agrees it is one (§25.7). */
function emitReport(instance: AtlasInstance, report: Dict): void {
  instance.validateFormat(report);
  process.stdout.write(`${new TextDecoder().decode(encoded(report))}\n`);
}

/** Read the delivery, preserve it, apply it — all under the one lock. */
function locked(instance: AtlasInstance, mode: string, value: string): Outcome {
  let deliveredBytes: Uint8Array | null = null;
  let requested: [string, string] | null = null;
  let envelope: unknown;
  if (mode === "--batch-file") {
    const delivered = instance.readDeliveredJson(value, {
      maxBytes: INTAKE_BATCH_BYTES,
    });
    envelope = delivered.value;
    deliveredBytes = delivered.data;
  } else {
    const cut = value.indexOf("/");
    requested = [value.slice(0, cut), value.slice(cut + 1)];
    envelope = instance.readJson(`intake/${requested[0]}/${requested[1]}.json`, {
      maxBytes: INTAKE_BATCH_BYTES,
      delivered: true,
    });
  }

  let report: Dict | null = null;
  let wholeConflict = false;
  let refusalLine = "batch-content-conflict; expected one immutable delivery";
  let canonical = "";

  if (
    isDict(envelope) &&
    typeof envelope["source"] === "string" &&
    RESERVED_RECEIPT_NAMESPACES.has(envelope["source"]) &&
    typeof envelope["batch"] === "string" &&
    SLUG.test(envelope["batch"]) &&
    Array.isArray(envelope["records"])
  ) {
    // §33.2: a delivery claiming a reserved direct-lane source is refused in
    // the batch report, like a content-mismatched batch id — never preserved,
    // never a bare schema error.
    const display = `intake/${envelope["source"]}/${envelope["batch"]}.json`;
    enforceBatchStructure(envelope, display);
    report = conflictReport(envelope, "rejected", "reserved-source");
    refusalLine = "reserved-source; expected a non-reserved source slug";
    wholeConflict = true;
  }

  if (report === null) {
    instance.validateFormat(envelope, { definition: "envelope" });
    const valid = envelope as Dict;
    canonical = `intake/${valid["source"] as string}/${valid["batch"] as string}.json`;
    enforceBatchStructure(valid, canonical);
  }

  const batch = envelope as Dict;
  if (
    report === null &&
    requested !== null &&
    (requested[0] !== batch["source"] || requested[1] !== batch["batch"])
  ) {
    report = conflictReport(batch);
    wholeConflict = true;
  } else if (report === null && deliveredBytes !== null) {
    const supplied = abspath(value);
    const canonicalAbsolute = `${instance.root}/${canonical}`;
    const insideIntake = isUnder(supplied, `${instance.root}/intake`);
    let canonicalPresent: boolean;
    try {
      instance.path(canonical);
      canonicalPresent = true;
    } catch (error) {
      if (!(error instanceof AtlasIOError)) throw error;
      canonicalPresent = false;
    }
    if (insideIntake && supplied !== canonicalAbsolute && !canonicalPresent) {
      report = conflictReport(batch);
      wholeConflict = true;
    }
    if (report === null && !canonicalPresent) {
      // §33.2: a batch id names one immutable delivery. With receipts already
      // on record but the canonical original gone, a redelivery cannot be
      // byte-compared against what those receipts covered — replay
      // verification is impossible, so the whole batch fails closed; a
      // corrected batch is a new id.
      const prefix = `${batch["source"] as string}/${batch["batch"] as string}#`;
      const status = instance.receiptStatus();
      const seen = [...status.opened, ...status.processed];
      if (seen.some((key) => key.startsWith(prefix))) {
        report = conflictReport(batch);
        wholeConflict = true;
      }
    }
    if (report === null) {
      try {
        instance.preserveBytes(canonical, deliveredBytes);
      } catch (error) {
        if (
          error instanceof AtlasIOError &&
          error.diagnostic.reason === ReasonCode.ContentConflict
        ) {
          report = conflictReport(batch);
          wholeConflict = true;
        } else {
          throw error;
        }
      }
    }
  }

  if (report === null) {
    const outcome = processRecords(instance, batch);
    report = outcome.report;
    wholeConflict = wholeConflict || outcome.conflict;
  }
  return { report, wholeConflict, refusalLine };
}

export function main(argv: readonly string[], program: string): number {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(
      `ERROR: usage: ${program} INSTANCE_ROOT ` +
        "(--batch-file PATH | --batch SOURCE/BATCH-ID)\n",
    );
    return 2;
  }
  const [root, mode, value] = parsed;

  try {
    const instance = new AtlasInstance(root);
    const { report, wholeConflict, refusalLine } = instance.withLock(() =>
      locked(instance, mode, value),
    );

    emitReport(instance, report);
    if (wholeConflict) {
      process.stderr.write(
        `ERROR: intake/${report["source"] as string}/` +
          `${report["batch"] as string}.json: ${refusalLine}\n`,
      );
    } else {
      emitRecordDiagnostics(report);
    }
    const records = report["records"] as Dict[];
    return !wholeConflict &&
      records.every(
        (item) => item["class"] === "applied" || item["class"] === "replayed",
      )
      ? 0
      : 1;
  } catch (error) {
    if (error instanceof AtlasIOError) {
      process.stderr.write(`${formatDiagnostics(error.diagnostic)}\n`);
      return 1;
    }
    if (error instanceof IntakeFailure) {
      process.stderr.write(
        `ERROR: ${error.relativePath}: ${error.reason}; expected a complete ` +
          "deterministic intake run\n",
      );
      return 1;
    }
    // The oracle names four exception types here; this names none, because the
    // set of things a port can throw is not the set CPython can, and the one
    // outcome both must produce for an unforeseen failure is the same bounded
    // line rather than a traceback (§24.4).
    process.stderr.write(
      "ERROR: intake: processing-failed; expected a complete " +
        "deterministic intake run\n",
    );
    return 1;
  }
}
