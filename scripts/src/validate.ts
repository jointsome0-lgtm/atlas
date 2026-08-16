// One walk of a whole instance: curated frontmatter, extracted plans,
// delivered intake, the state journals, run manifests, and the emitted graph
// (§8, §20.1, §25.7, §33.2, §34.4).
//
// Almost every rule applied here lives in another module. What this one owns
// is the *order* they are applied in and the state carried between them — the
// §34.4 retired map that spans the instance, the living ids a decision may
// name, and the rejection memory a decisions journal folds in date order
// rather than in file order. The order is part of the contract: diagnostics
// are compared as a sequence, so a rearranged pass is a changed answer even
// when the set of complaints is identical.
//
// Ported from validate_instance in scripts/validate_atlas.py.

import {
  newRejectedProposals,
  reproposalErrors,
  show,
  snapshotDanglingRefs,
  snapshotStateKindErrors,
  statusEvidenceErrors,
  userSelfProposalErrors,
} from "./checks.ts";
import { foldOrderKey } from "./domain.ts";
import {
  FrontmatterError,
  parseDocument,
  parseFrontmatter,
} from "./frontmatter.ts";
import { emittedGraphErrors } from "./graph-rules.ts";
import { JsonInputError, readJsonFile } from "./json-input.ts";
import { CURATED_DIRS, JOURNALS, journalPaths, readJsonl } from "./journal.ts";
import { compareCodePoint } from "./ordering.ts";
import { AtlasReader, ReaderError, type ScannedFile } from "./reader.ts";
import {
  type Registry,
  loadRegistry,
  runnerManifestErrors,
  schemaErrors,
} from "./schema-registry.ts";
import { type SchemaError, SchemaValidator } from "./schema.ts";

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const sortedByCodePoint = (values: Iterable<string>): string[] =>
  [...values].sort(compareCodePoint);

// A row is deduplicated by its bytes, so the bytes have to become a key
// without going through a decoder that can lose or replace any of them.
// `Buffer`'s `latin1` is the one spelling here that is byte identity: the
// same label on `TextDecoder` means WHATWG windows-1252, which renumbers
// thirty-two bytes on the way out — still one key per byte string, but a key
// nobody reading it could check, and a UTF-8 decoder would replace whole runs
// of bytes with one character and fold two different rows into one.
const bytesAsKey = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("latin1");

/** The emitted files the preflight judges, and the schema each answers to. */
const EMITTED: ReadonlyArray<readonly [string, string]> = [
  ["atlas-graph.json", "atlas-graph"],
  ["atlas-graph.redacted.json", "atlas-graph"],
  ["atlas-snapshot.json", "atlas-snapshot"],
];

export interface InstanceCounts {
  frontmatter: number;
  rows: number;
  intake: number;
  emitted: number;
}

export interface InstanceReport {
  readonly errors: string[];
  readonly warnings: string[];
  readonly counts: InstanceCounts;
}

/** A path split the way `PurePosixPath` splits one. */
function purePosix(path: string): { root: string; parts: string[] } {
  // POSIX leaves a leading `//` implementation-defined and CPython keeps it,
  // while three or more slashes collapse to one.
  const leading = (/^\/*/.exec(path) as RegExpExecArray)[0].length;
  const root = leading === 0 ? "" : leading === 2 ? "//" : "/";
  return {
    root,
    parts: path.split("/").filter((part) => part !== "" && part !== "."),
  };
}

const spell = (root: string, parts: readonly string[]): string => {
  const text = root + parts.join("/");
  // `PurePosixPath("")` is `.`, and so is the join of two empty spellings.
  return text === "" ? "." : text;
};

/**
 * `PurePosixPath(directory) / name`, for the one comparison that needs to be.
 *
 * §33.2 compares a delivered file's place under `intake/` against the place
 * its own envelope names, and the oracle builds that second place with `Path`.
 * When the envelope validates both halves are slugs and this is a plain join —
 * but the comparison also runs on an envelope that did *not* validate, where
 * the strings can be anything, and there the difference between a match and a
 * complaint is `Path` folding `a/`, `./a` and `a/./b`, keeping `..`, and
 * letting an absolute right-hand side discard the left one entirely.
 */
function posixJoin(directory: string, name: string): string {
  const right = purePosix(name);
  if (right.root !== "") return spell(right.root, right.parts);
  const left = purePosix(directory);
  return spell(left.root, [...left.parts, ...right.parts]);
}

/**
 * Every diagnostic one instance draws, in the order the passes draw them.
 *
 * The two roots are separate on purpose: schemas are the *repository's*
 * canon (§25.7) and the instance is whatever the caller points at, which for
 * a private instance is a directory this repository has never seen. The
 * oracle reaches its own file's parent for the first and takes only the
 * second as an argument; naming both is the same reach, said out loud.
 */
export function validateInstance(root: string, repoRoot: string): InstanceReport {
  const counts: InstanceCounts = {
    frontmatter: 0,
    rows: 0,
    intake: 0,
    emitted: 0,
  };
  const warnings: string[] = [];

  const registry: Registry = loadRegistry(repoRoot);
  const errors: string[] = [...registry.errors];
  if (errors.length > 0) return { errors, warnings, counts };
  const schemaOf = (name: string): Record<string, unknown> =>
    registry.schemas.get(name) as Record<string, unknown>;

  let reader: AtlasReader;
  let curatedPrefix: string;
  try {
    reader = new AtlasReader(root);
    curatedPrefix = reader.isDirectory("atlas") ? "atlas" : "";
  } catch (error) {
    if (error instanceof ReaderError) {
      return { errors: [error.message], warnings, counts };
    }
    throw error;
  }

  // A refused walk is a diagnostic in sequence, not an abandoned pass: the
  // rest of the instance is still worth judging, and the caller gets every
  // complaint from one run rather than one per run.
  const scan = (
    relativePath: string,
    options: { suffix?: string; recursive?: boolean } = {},
  ): ScannedFile[] => {
    try {
      return reader.scan(relativePath, options);
    } catch (error) {
      if (error instanceof ReaderError) {
        errors.push(error.message);
        return [];
      }
      throw error;
    }
  };

  const optionalFile = (relativePath: string): ScannedFile | null => {
    try {
      return reader.optionalFile(relativePath);
    } catch (error) {
      if (error instanceof ReaderError) {
        errors.push(error.message);
        return null;
      }
      throw error;
    }
  };

  // §34.4: the retired -> living map spans the instance, so cross-file id
  // checks run after the whole curated pass — a stale curated ref resolves
  // through the map (a warning, never an error), mirroring the builder.
  const retired = new Map<string, readonly [string, string]>();
  const living = new Map<string, string>();
  const routeChecks: Array<readonly [string, Dict]> = [];

  const claimLiving = (nodeId: string, origin: string): void => {
    // §10.1: one id, one record — the builder fails on a duplicate, so the
    // boundary rejects it too.
    const prior = living.get(nodeId);
    if (prior !== undefined) {
      errors.push(
        `${origin}: duplicate id ${nodeId} (also declared in ${prior}) (§10.1)`,
      );
      return;
    }
    living.set(nodeId, origin);
  };

  const claimRetired = (old: string, survivor: string, origin: string): void => {
    // §34.4: one retired id has one survivor — a 1->n redirect is
    // unrepresentable and the builder rejects it.
    const prior = retired.get(old);
    if (prior !== undefined && prior[0] !== survivor) {
      errors.push(
        `${origin}: retired id ${old} redirects to both ${prior[0]} and ` +
          `${survivor} (§34.4)`,
      );
      return;
    }
    retired.set(old, [survivor, origin]);
  };

  for (const [dirname, schemaName] of CURATED_DIRS) {
    const directory =
      curatedPrefix === "" ? dirname : `${curatedPrefix}/${dirname}`;
    for (const source of scan(directory, { suffix: ".md" })) {
      const path = source.path;
      if (source.name.startsWith("_")) continue;
      try {
        const instance = parseFrontmatter(source.readBytes(), path);
        errors.push(...schemaErrors(instance, schemaOf(schemaName), path));
        if (isDict(instance)) {
          const docId = asString(instance["id"]);
          if (docId !== null) claimLiving(docId, path);
          for (const old of asList(instance["formerly"])) {
            if (typeof old === "string" && docId !== null) {
              claimRetired(old, docId, path);
            }
          }
          for (const part of asList(instance["parts"])) {
            if (!isDict(part)) continue;
            const partId = asString(part["id"]);
            if (partId !== null) claimLiving(partId, path);
            for (const old of asList(part["formerly"])) {
              if (typeof old === "string" && partId !== null) {
                claimRetired(old, partId, path);
              }
            }
          }
        }
        // §9.4: each material_roles entry names a member of steps — deferred
        // until the retired map is complete (§34.4).
        if (schemaName === "suggested-route" && isDict(instance)) {
          routeChecks.push([path, instance]);
        }
        // §10.1: an embedded part id carries its material's slug.
        if (schemaName === "material" && isDict(instance)) {
          const materialId = asString(instance["id"]);
          const slug =
            materialId !== null && materialId.includes(":")
              ? materialId.slice(materialId.indexOf(":") + 1)
              : "";
          asList(instance["parts"]).forEach((part, index) => {
            const partId = isDict(part) ? asString(part["id"]) : null;
            if (
              slug !== "" &&
              partId !== null &&
              !partId.startsWith(`part:${slug}/`)
            ) {
              errors.push(
                `${path}: parts[${index}].id ${partId} does not carry its ` +
                  `material's slug ${show(slug)} (§10.1)`,
              );
            }
          });
        }
        counts.frontmatter += 1;
      } catch (error) {
        if (error instanceof FrontmatterError || error instanceof ReaderError) {
          errors.push(error.message);
        } else {
          throw error;
        }
      }
    }
  }

  // §34.4: a retired id is never a living one — curation keeping both cannot
  // build, so the boundary rejects it like the builder does.
  for (const old of sortedByCodePoint(
    [...retired.keys()].filter((id) => living.has(id)),
  )) {
    const [survivor, origin] = retired.get(old) as readonly [string, string];
    errors.push(
      `${origin}: formerly ${old} on ${survivor} is still a living id (§34.4)`,
    );
  }

  const resolve = (ref: unknown, origin: string): unknown => {
    const entry = typeof ref === "string" ? retired.get(ref) : undefined;
    if (entry === undefined) return ref;
    warnings.push(
      `${origin}: stale curated ref ${ref} resolved to ${entry[0]} (§34.4)`,
    );
    return entry[0];
  };

  // §9.4 on §34.4-resolved ids: each material_roles entry names a member of
  // steps, and per step the two lists are disjoint — a stale spelling
  // converges on the survivor first instead of failing builder-valid curation.
  for (const [path, instance] of routeChecks) {
    const steps = instance["steps"];
    const members = new Set<string>();
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (typeof step !== "string") continue;
        const value = resolve(step, path);
        if (typeof value === "string") members.add(value);
      }
    }
    asList(instance["material_roles"]).forEach((role, index) => {
      if (!isDict(role)) return;
      const step = resolve(role["step"], path);
      if (typeof step === "string" && !members.has(step)) {
        errors.push(
          `${path}: material_roles[${index}].step ${step} is not a member ` +
            "of steps (§9.4)",
        );
      }
      const collect = (key: string): Set<string> => {
        const seen = new Set<string>();
        for (const material of asList(role[key])) {
          if (typeof material !== "string") continue;
          const value = resolve(material, path);
          if (typeof value === "string") seen.add(value);
        }
        return seen;
      };
      const primary = collect("primary_materials");
      const supporting = collect("supporting_materials");
      for (const shared of sortedByCodePoint(
        [...primary].filter((id) => supporting.has(id)),
      )) {
        errors.push(
          `${path}: material_roles[${index}] lists ${shared} as both ` +
            "primary and supporting (§9.4)",
        );
      }
    });
  }

  for (const source of scan("plans/extracted")) {
    const path = source.path;
    try {
      const instance = parseDocument(source.readBytes(), path);
      errors.push(...schemaErrors(instance, schemaOf("plan-extract"), path));
      counts.frontmatter += 1;
    } catch (error) {
      if (error instanceof FrontmatterError || error instanceof ReaderError) {
        errors.push(error.message);
      } else {
        throw error;
      }
    }
  }

  const intakeSources = scan("intake", { suffix: ".json", recursive: true });
  if (intakeSources.length > 0) {
    // §33.2/§25.7: delivered batches are a persisted format; the JSON envelope
    // validates structurally — batch content stays as delivered and is never
    // term-scanned here (§19 keeps out of intake/ entirely). A schema-invalid
    // record inside a valid envelope is the flow's per-record refusal (its
    // outcome lives in the batch report), while the delivery is preserved as
    // the audit original — so it surfaces here as a warning, never as instance
    // invalidity.
    const intakeValidator = new SchemaValidator(schemaOf("atlas-intake"));
    const envelopeSchema = intakeValidator.resolve("#/$defs/envelope");
    const recordSchema = intakeValidator.resolve("#/$defs/record");
    for (const sourceFile of intakeSources) {
      const path = sourceFile.path;
      try {
        const instance = readJsonFile(sourceFile, true);
        const envelopeMessages = intakeValidator.validateAgainst(
          instance,
          envelopeSchema,
        );
        errors.push(
          ...envelopeMessages.map((message) => `${path}: ${message.message}`),
        );
        if (envelopeMessages.length === 0 && isDict(instance)) {
          asList(instance["records"]).forEach((record, index) => {
            const recordMessages = intakeValidator.validateAgainst(
              record,
              recordSchema,
              `$.records[${index}]`,
            );
            if (recordMessages.length > 0) {
              const first = recordMessages[0] as SchemaError;
              warnings.push(
                `${path}: ${first.message} (record refused per §33.2; ` +
                  "delivery preserved as delivered)",
              );
            }
          });
        }
        // §33.2: source scopes the intake/ path and batch names the delivery —
        // the <source>/<batch>#n provenance and receipt keys must point back
        // at exactly this file.
        if (isDict(instance)) {
          const source = asString(instance["source"]);
          const batch = asString(instance["batch"]);
          if (source !== null && batch !== null) {
            const delivered = sourceFile.relativePath.slice("intake/".length);
            if (delivered !== posixJoin(source, `${batch}.json`)) {
              errors.push(
                `${path}: envelope names ${source}/${batch}, delivered as ` +
                  `${sourceFile.relativePath} (§33.2)`,
              );
            }
          }
        }
        counts.intake += 1;
      } catch (error) {
        if (error instanceof JsonInputError) errors.push(error.message);
        else throw error;
      }
    }
  }

  let hasState = false;
  try {
    hasState = reader.isDirectory("state");
  } catch (error) {
    if (error instanceof ReaderError) errors.push(error.message);
    else throw error;
  }
  if (hasState) {
    const artifactKinds = new Map<string, string>();
    const knownDecisionTargets = new Set<string>(living.keys());
    const rejectedProposals = newRejectedProposals();
    const decisionRecords: Array<readonly [string, number, Dict, string]> = [];
    let decisionPosition = 0;
    for (const [stem, schemaName] of JOURNALS) {
      const seenRows = new Set<string>();
      let paths: ScannedFile[] = [];
      try {
        paths = journalPaths(reader, stem);
      } catch (error) {
        if (error instanceof ReaderError) errors.push(error.message);
        else throw error;
      }
      for (const sourceFile of paths) {
        const path = sourceFile.path;
        try {
          for (const { number, row, raw } of readJsonl(sourceFile)) {
            const rowPath = `${path}:${number}`;
            // §20.1: the builder folds a byte-identical duplicate once across
            // the rotated prefix and the direct tail. The key is the row's
            // bytes and nothing derived from them — two spellings of the same
            // object are two rows.
            const key = bytesAsKey(raw);
            if (seenRows.has(key)) {
              warnings.push(
                `${rowPath}: byte-identical duplicate row folded once (§20.1)`,
              );
              continue;
            }
            seenRows.add(key);
            if (stem === "decisions") {
              // §20.1 position counts through the rotated-prefix plus
              // direct-tail concatenation. Schema-invalid rows still occupy
              // their physical position.
              decisionPosition += 1;
            }
            const rowErrors = schemaErrors(row, schemaOf(schemaName), rowPath);
            errors.push(...rowErrors);
            if (stem === "artifacts" && isDict(row)) {
              const artifactId = asString(row["id"]);
              const artifactKind = asString(row["type"]);
              if (artifactId !== null && artifactKind !== null) {
                artifactKinds.set(artifactId, artifactKind);
              }
            } else if (stem === "questions" && isDict(row)) {
              const questionId = asString(row["id"]);
              if (questionId !== null) knownDecisionTargets.add(questionId);
            } else if (stem === "decisions") {
              const semanticErrors = [
                ...statusEvidenceErrors(row, rowPath, artifactKinds),
                ...userSelfProposalErrors(row, rowPath, artifactKinds),
              ];
              errors.push(...semanticErrors);
              if (
                rowErrors.length === 0 &&
                semanticErrors.length === 0 &&
                isDict(row)
              ) {
                decisionRecords.push([
                  row["date"] as string,
                  decisionPosition,
                  row,
                  rowPath,
                ]);
              }
            }
            counts.rows += 1;
          }
        } catch (error) {
          if (error instanceof JsonInputError) errors.push(error.message);
          else throw error;
        }
      }
    }
    // Rejection memory is an order-sensitive decisions-journal fold, so
    // backfill follows activity date before physical journal position.
    const ordered = decisionRecords
      .map((record, index) => ({ record, index }))
      .sort((left, right) => {
        const [leftDate, leftPosition] = foldOrderKey(
          left.record[0],
          left.record[1],
        );
        const [rightDate, rightPosition] = foldOrderKey(
          right.record[0],
          right.record[1],
        );
        const byDate = compareCodePoint(leftDate, rightDate);
        if (byDate !== 0) return byDate;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
        // Python's sort is stable and the oracle's key has no third element;
        // arrival order is the rest of the comparison rather than whatever
        // the host's sort happens to do with a tie.
        return left.index - right.index;
      })
      .map((entry) => entry.record);
    for (const [, , row, rowPath] of ordered) {
      errors.push(
        ...reproposalErrors(
          row,
          rowPath,
          rejectedProposals,
          knownDecisionTargets,
          retired,
        ),
      );
    }
  }

  for (const sourceFile of scan("runs", { suffix: ".json" })) {
    const path = sourceFile.path;
    try {
      const instance = readJsonFile(sourceFile);
      errors.push(...schemaErrors(instance, schemaOf("run-manifest"), path));
      errors.push(...runnerManifestErrors(instance, path));
      // §17.6: the file name is the manifest's date-serial — run_id and path
      // never disagree. The mismatched value is not echoed (§24.4).
      if (isDict(instance)) {
        const runId = asString(instance["run_id"]);
        const expected = `run:${sourceFile.name.slice(0, -".json".length)}`;
        if (runId !== null && runId !== expected) {
          errors.push(`${path}: run_id does not match the file name (§17.6)`);
        }
      }
      counts.emitted += 1;
    } catch (error) {
      if (error instanceof JsonInputError) errors.push(error.message);
      else throw error;
    }
  }

  let fullGraph: Dict | null = null;
  for (const [filename, schemaName] of EMITTED) {
    const sourceFile = optionalFile(`graph/${filename}`);
    if (sourceFile === null) continue;
    const path = sourceFile.path;
    try {
      const instance = readJsonFile(sourceFile);
      errors.push(...schemaErrors(instance, schemaOf(schemaName), path));
      if (filename === "atlas-graph.json" && isDict(instance)) {
        fullGraph = instance;
      }
      if (schemaName === "atlas-snapshot" && isDict(instance)) {
        errors.push(...snapshotDanglingRefs(instance, path));
        errors.push(...snapshotStateKindErrors(instance, path));
      }
      if (schemaName === "atlas-graph" && isDict(instance)) {
        errors.push(...emittedGraphErrors(instance, path, filename, fullGraph));
      }
      counts.emitted += 1;
    } catch (error) {
      if (error instanceof JsonInputError) errors.push(error.message);
      else throw error;
    }
  }

  return { errors, warnings, counts };
}
