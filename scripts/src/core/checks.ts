// The joins a schema cannot express (§9.8, §14.5–§14.8, §33.4).
//
// Every rule here reads an *emitted* graph or snapshot and asks whether it
// could have come out of a real fold. None of them re-folds: target and link
// semantics and same-day journal position stay the producer's, and the
// boundary uses only identities, dates and classes the graph itself repeats.
//
// That restraint is the design. A checker that re-derived the answer would
// either be a second producer to drift from the first, or would have to
// re-read the journals the graph was built from — and the thing being guarded
// against is a graph that was never built from them at all: a fixture or an
// alternate producer importing understanding past the §14.6 review gate (§31).

import {
  CONCEPT_EXPOSURE,
  DECISION_OUTCOMES,
  DECISION_VALUES,
  FOLDED_DECISION_TARGETS,
  GATED_DEFAULTS,
  MATERIAL_DEPTH,
  SENSITIVITY_CLASSES,
  STALE_EVIDENCE_KIND,
  STALE_EVIDENCE_PREFIXES,
  STATUS_EVIDENCE_PREFIXES,
  depthCeiling,
  exposureCeiling,
  freshnessOf,
  graphFieldExpectations,
  idType,
} from "./domain.ts";
import { isCalendarDate } from "../boundary/schema.ts";
import { compareCodePoint } from "../boundary/ordering.ts";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const REGION_ID_RE = new RegExp(`^(?:concept|pattern|zone):${SLUG}$`);
export const EVIDENCE_ID_RE = new RegExp(`^(?:artifact|encounter|question):${SLUG}$`);
export const MATERIAL_ID_RE = new RegExp(
  `^(?:material:${SLUG}|part:${SLUG}/${SLUG})$`,
);
export const ZONE_ID_RE = new RegExp(`^zone:${SLUG}$`);

/** The §9.12 evidence kinds a snapshot's `evidence_refs` table must resolve. */
const EVIDENCE_PREFIXES = ["artifact:", "encounter:", "question:"] as const;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDict = (value: unknown): Dict => (isDict(value) ? value : {});
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * A value as it appears inside a diagnostic.
 *
 * JSON spelling rather than CPython's `repr`: the identity in the message is
 * the contract and the punctuation around it is not, and a port that copied
 * Python's quoting would be carrying an accident of the implementation it
 * replaces into the one that replaces it.
 */
export function show(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  return JSON.stringify(value) ?? String(value);
}

/** The prefix of an id, or the whole of it when it carries no colon. */
const prefixOf = (id: string): string => id.split(":", 1)[0] as string;

/** Whether a state entry rests on a §20.1 dated fold input. */
export function stateEntryHasDatedInput(entry: unknown): boolean {
  if (!isDict(entry)) return false;
  if ("last_seen" in entry) return true;
  return asList(entry["decisions"]).some(
    (reference) => isDict(reference) && "date" in reference,
  );
}

/**
 * §9.8: emitted status evidence keeps the journal outcome restriction.
 *
 * The stale note kind is knowable only when every cited artifact resolves;
 * §20.1 deliberately permits a decision to retain dangling evidence.
 */
export function stateStatusEvidenceErrors(
  entry: Dict,
  path: unknown,
  position: number,
  nodes: ReadonlyMap<string, unknown>,
): string[] {
  const status = asString(entry["status"]);
  if (status === null || DECISION_VALUES.get("status")?.has(status) !== true) {
    return [];
  }
  const reference = asList(entry["decisions"]).find(
    (item) => isDict(item) && item["dimension"] === "status",
  );
  if (reference === undefined) return [];
  const evidence = (reference as Dict)["evidence"];
  const prefixes =
    status === "stale" ? STALE_EVIDENCE_PREFIXES : STATUS_EVIDENCE_PREFIXES;

  if (
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    evidence.some((ref) => typeof ref !== "string" || !prefixes.has(prefixOf(ref)))
  ) {
    return [
      `${path}: /state property #${position} carries status decision ` +
        "evidence outside the §9.8 outcome restriction",
    ];
  }

  if (status === "stale") {
    const resolved = (evidence as string[])
      .map((ref) => nodes.get(ref))
      .filter((node): node is Dict => isDict(node));
    if (
      resolved.length === evidence.length &&
      !resolved.some(
        (node) => node["type"] === "artifact" && node["kind"] === STALE_EVIDENCE_KIND,
      )
    ) {
      return [
        `${path}: /state property #${position} carries stale status ` +
          "without the user's own note (§9.8/§31.5)",
      ];
    }
  }
  return [];
}

/**
 * Check emitted §9.8/§14/§32.6 joins without partially re-folding.
 *
 * Target/link semantics and same-day journal position remain producer
 * concerns. The boundary uses only identities, dates, and classes that the
 * graph itself repeats.
 */
export function stateProvenanceErrors(
  entry: Dict,
  path: unknown,
  position: number,
  stateId: string,
  nodeType: string | null,
  nodes: ReadonlyMap<string, unknown>,
): string[] {
  const errors: string[] = [];
  const stateEvidence = asList(entry["evidence"]);

  if (nodeType === "concept") {
    for (const reference of asList(entry["decisions"])) {
      if (!isDict(reference)) continue;
      if (
        asList(reference["evidence"]).some(
          (ref) => typeof ref === "string" && !stateEvidence.includes(ref),
        )
      ) {
        errors.push(
          `${path}: /state property #${position} omits concept ` +
            "decision evidence from its state provenance (§14.6)",
        );
        break;
      }
    }

    // State evidence also contains decision citations, so their dates cannot
    // safely define the latest contact. The producer's last_seen must
    // nevertheless equal one resolved artifact/encounter date in that union;
    // an unrelated invented date is never possible.
    const contactDates: string[] = [];
    for (const ref of stateEvidence) {
      if (typeof ref !== "string") continue;
      const node = nodes.get(ref);
      if (!isDict(node)) continue;
      let date: unknown = null;
      if (node["type"] === "artifact") date = node["observed_at"];
      else if (node["type"] === "encounter") date = node["date"];
      if (typeof date === "string" && isCalendarDate(date)) contactDates.push(date);
    }
    const lastSeen = asString(entry["last_seen"]);
    if (lastSeen !== null && !contactDates.includes(lastSeen)) {
      errors.push(
        `${path}: /state property #${position} carries concept ` +
          "last_seen absent from its cited contact evidence (§14.5)",
      );
    }
  } else if (nodeType === "material" || nodeType === "material_part") {
    const encounterDates: string[] = [];
    for (const ref of stateEvidence) {
      if (typeof ref !== "string") continue;
      const node = nodes.get(ref);
      if (!isDict(node) || node["type"] !== "encounter") continue;
      const date = node["date"];
      if (typeof date === "string" && isCalendarDate(date)) encounterDates.push(date);
    }
    const lastSeen = asString(entry["last_seen"]);
    // An ISO date sorts as text, so the latest is the greatest — but only
    // under a code-point comparison; the default one is a locale's.
    const latest = encounterDates.reduce<string | null>(
      (best, date) => (best === null || compareCodePoint(date, best) > 0 ? date : best),
      null,
    );
    if (latest !== null && lastSeen !== null && lastSeen !== latest) {
      errors.push(
        `${path}: /state property #${position} carries material ` +
          "last_seen other than its latest cited encounter (§14.8)",
      );
    }
  } else if (nodeType === "question") {
    const reference = asList(entry["decisions"]).find(
      (item) => isDict(item) && item["dimension"] === "status",
    );
    const decisionEvidence =
      reference === undefined ? [] : (reference as Dict)["evidence"];
    if (
      Array.isArray(entry["evidence"]) &&
      Array.isArray(decisionEvidence) &&
      !sameJson(entry["evidence"], decisionEvidence)
    ) {
      errors.push(
        `${path}: /state property #${position} carries question ` +
          "evidence that differs from its status decision (§9.8)",
      );
    }
  }

  const provenanceRefs: string[] = stateEvidence.filter(
    (ref): ref is string => typeof ref === "string",
  );
  for (const reference of asList(entry["decisions"])) {
    if (!isDict(reference)) continue;
    for (const ref of asList(reference["evidence"])) {
      if (typeof ref === "string") provenanceRefs.push(ref);
    }
  }

  const sources: Dict[] = [];
  const target = nodes.get(stateId);
  if (isDict(target)) sources.push(target);
  for (const ref of provenanceRefs) {
    const source = nodes.get(ref);
    if (isDict(source)) sources.push(source);
  }
  const requiredClasses = new Set(
    sources
      .map((source) => source["sensitivity"])
      .filter(
        (sensitivity): sensitivity is string =>
          typeof sensitivity === "string" && SENSITIVITY_CLASSES.has(sensitivity),
      ),
  );
  const entrySensitivity = asString(entry["sensitivity"]);
  if (
    requiredClasses.size > 0 &&
    (entrySensitivity === null || !requiredClasses.has(entrySensitivity))
  ) {
    errors.push(
      `${path}: /state property #${position} omits sensitivity ` +
        "carried by its target or resolved evidence (§32.6)",
    );
  }

  return errors;
}

/**
 * §14.5–§14.7/§9.8: a gated value moves only by a reviewed decision and never
 * carries two competing references, a ladder moves only on recorded evidence,
 * and freshness is a derivation against the fold as-of.
 *
 * The schema closes each value independently and cannot express those joins,
 * which would let a fixture or an alternate producer import understanding past
 * the gate (§31).
 */
export function reviewGateErrors(
  entry: Dict,
  path: unknown,
  position: number,
  asOf: string | null,
  nodes: ReadonlyMap<string, unknown>,
  stateId: string,
  nodeType: string | null,
): string[] {
  const errors = stateStatusEvidenceErrors(entry, path, position, nodes);
  errors.push(
    ...stateProvenanceErrors(entry, path, position, stateId, nodeType, nodes),
  );

  // §14.5/§14.8: the ladders move on recorded artifact or encounter evidence,
  // so only a first value can stand uncited — and the cited records must be
  // able to reach the asserted rung. The ceiling is an upper bound (the fold
  // also weighs link kind and same-day journal position the emission does not
  // repeat), which is exactly what rejects imported understanding without
  // second-guessing a real fold (§31.3).
  const LADDERS: ReadonlyArray<{
    dimension: string;
    ladder: readonly string[];
    ceilingOf: (
      evidence: readonly unknown[],
      nodes: ReadonlyMap<string, unknown>,
    ) => number;
    // `unseen` is the one rung standing for no contact at all; material state
    // exists only because an encounter created it, so its first rung is a
    // reading, not an exemption.
    uncited: string | null;
  }> = [
    {
      dimension: "exposure",
      ladder: CONCEPT_EXPOSURE,
      ceilingOf: exposureCeiling,
      uncited: CONCEPT_EXPOSURE[0] as string,
    },
    {
      dimension: "depth_reached",
      ladder: MATERIAL_DEPTH,
      ceilingOf: depthCeiling,
      uncited: null,
    },
  ];

  for (const { dimension, ladder, ceilingOf, uncited } of LADDERS) {
    const value = entry[dimension];
    if (value === undefined || value === null || value === uncited) continue;
    const evidence = asList(entry["evidence"]);
    if (evidence.length === 0) {
      errors.push(
        `${path}: /state property #${position} moves ${dimension} off ` +
          "its first value with no evidence (§14.5/§14.8)",
      );
    } else if (
      dimension === "depth_reached" &&
      !evidence.every((ref) => {
        if (typeof ref !== "string") return false;
        const node = nodes.get(ref);
        return isDict(node) && node["type"] === "encounter";
      })
    ) {
      // Material state is sparse and exists only because an emitted encounter
      // created it. Unlike decisions, its provenance never survives a
      // deleted/out-of-cut evidence row (§14.8/§20.1).
      errors.push(
        `${path}: /state property #${position} carries material ` +
          "state without wholly emitted encounter evidence (§14.8)",
      );
    } else if (
      typeof value === "string" &&
      ladder.includes(value) &&
      ladder.indexOf(value) > ceilingOf(evidence, nodes)
    ) {
      errors.push(
        `${path}: /state property #${position} asserts ${dimension} ` +
          "beyond what its cited evidence can reach (§14.5/§14.8)",
      );
    }
  }

  const exposure = asString(entry["exposure"]);
  if (exposure !== null && CONCEPT_EXPOSURE.includes(exposure)) {
    const hasContact = exposure !== CONCEPT_EXPOSURE[0];
    const hasLastSeen = "last_seen" in entry;
    const hasFreshness = "freshness" in entry;
    if (
      (hasContact && !(hasLastSeen && hasFreshness)) ||
      (!hasContact && (hasLastSeen || hasFreshness))
    ) {
      errors.push(
        `${path}: /state property #${position} must carry last_seen ` +
          "and freshness exactly when exposure records contact " +
          "(§14.5/§14.7)",
      );
    }
  }

  // §14.7/§20.1: last_seen is a fold input, never later than the as-of it is
  // measured against, and freshness is recomputed from the two. The caller
  // only passes a calendar-valid as-of — an unparsable stamp is already an
  // error and must not become a traceback here.
  // Keyed on the pair, not on the node kind (#105): a material entry now
  // carries the class too, and an emitted class is input, not proof that
  // anything was classified — it is recomputed here for every kind that
  // carries one, against the single §20 definition of the thresholds.
  const lastSeen = asString(entry["last_seen"]);
  if (lastSeen !== null && asOf !== null) {
    if (compareCodePoint(lastSeen, asOf) > 0) {
      errors.push(
        `${path}: /state property #${position} was last seen after ` +
          "the graph as-of (§20.1)",
      );
    } else {
      const freshness = asString(entry["freshness"]);
      if (
        freshness !== null &&
        isCalendarDate(lastSeen) &&
        freshness !== freshnessOf(lastSeen, asOf)
      ) {
        errors.push(
          `${path}: /state property #${position} carries a freshness ` +
            "the §14.7 derivation does not produce",
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const reference of asList(entry["decisions"])) {
    if (!isDict(reference)) continue;
    const dimension = asString(reference["dimension"]);
    if (dimension === null) continue;
    if (seen.has(dimension)) {
      errors.push(
        `${path}: /state property #${position} carries two decision ` +
          `references for ${dimension} (§9.13)`,
      );
    }
    seen.add(dimension);
    // §20.1: the as-of bounds every dated input, decisions included — a graph
    // cannot rest on a decision it was folded before.
    const referenceDate = asString(reference["date"]);
    if (
      referenceDate !== null &&
      asOf !== null &&
      compareCodePoint(referenceDate, asOf) > 0
    ) {
      errors.push(
        `${path}: /state property #${position} cites a ${dimension} ` +
          "decision dated after the graph as-of (§20.1)",
      );
    }
  }

  for (const dimension of [...GATED_DEFAULTS.keys()].sort(compareCodePoint)) {
    const fallback = GATED_DEFAULTS.get(dimension);
    const value = entry[dimension];
    if (
      value === undefined ||
      value === null ||
      value === fallback ||
      seen.has(dimension)
    ) {
      continue;
    }
    errors.push(
      `${path}: /state property #${position} moves ${dimension} off its ` +
        "default with no decision reference (§14.6/§9.8)",
    );
  }
  return errors;
}

/**
 * §10.4: fields membership is derivable from the emitted edges — recompute it
 * for the derived kinds (via the builder's shared derivation, one source) and
 * require the persisted value to match (region kinds are pinned by the schema
 * itself).
 */
export function graphFieldErrors(instance: Dict, path: unknown): string[] {
  const errors: string[] = [];
  const expectedById = graphFieldExpectations(instance);
  for (const node of asList(instance["nodes"])) {
    if (!isDict(node)) continue;
    const id = asString(node["id"]);
    if (id === null) continue;
    const expected = expectedById.get(id);
    if (expected === undefined) continue;
    const found = node["fields"];
    if (!Array.isArray(found)) continue;
    const named = found
      .filter((value): value is string => typeof value === "string")
      .sort(compareCodePoint);
    if (!sameJson(named, expected)) {
      errors.push(
        `${path}: node ${id} fields ${show(found)} do not match ` +
          `the §10.4 derivation ${show(expected)}`,
      );
    }
  }
  return errors;
}

/** Mirror the builder's exact joins over structured state evidence. */
export function stateCitesWithheldId(
  entry: unknown,
  withheldIds: ReadonlySet<string>,
): boolean {
  if (!isDict(entry)) return false;
  const refs = new Set<string>();
  for (const ref of asList(entry["evidence"])) {
    if (typeof ref === "string") refs.add(ref);
  }
  for (const decision of asList(entry["decisions"])) {
    if (!isDict(decision)) continue;
    for (const ref of asList(decision["evidence"])) {
      if (typeof ref === "string") refs.add(ref);
    }
  }
  for (const ref of refs) if (withheldIds.has(ref)) return true;
  return false;
}

/** Keep §9.13 user-note semantics aligned with the builder. */
export function userSelfProposalErrors(
  row: unknown,
  path: unknown,
  artifactKinds: ReadonlyMap<string, unknown>,
): string[] {
  if (!isDict(row) || row["proposed_by"] !== "user") return [];
  const artifactRefs = asList(row["evidence"]).filter(
    (ref): ref is string => typeof ref === "string" && ref.startsWith("artifact:"),
  );
  if (artifactRefs.length === 0) {
    return [
      `${path}: /evidence for a user self-proposal must include ` +
        "a note artifact (§9.13)",
    ];
  }
  const resolvedKinds = artifactRefs
    .filter((ref) => artifactKinds.has(ref))
    .map((ref) => artifactKinds.get(ref));
  if (
    resolvedKinds.length === artifactRefs.length &&
    !resolvedKinds.includes(STALE_EVIDENCE_KIND)
  ) {
    return [
      `${path}: /evidence for a user self-proposal must cite ` +
        "the user's own note (§9.13)",
    ];
  }
  return [];
}

/**
 * Keep §9.8 outcome-specific evidence kinds aligned with the builder.
 *
 * The stale artifact's note kind is checked only when every cited row
 * resolves, matching the fold; §20.1 permits a dangling citation.
 */
export function statusEvidenceErrors(
  row: unknown,
  path: unknown,
  artifactKinds: ReadonlyMap<string, unknown>,
): string[] {
  if (!isDict(row) || row["dimension"] !== "status") return [];
  const evidence = row["evidence"];
  const stale = row["to"] === "stale";
  const prefixes = stale ? STALE_EVIDENCE_PREFIXES : STATUS_EVIDENCE_PREFIXES;
  const expectation = stale
    ? "the user's own note artifact"
    : "artifact or encounter ids";

  if (
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    evidence.some((ref) => typeof ref !== "string" || !prefixes.has(prefixOf(ref)))
  ) {
    return [
      `${path}: /evidence for a status decision must contain ` +
        `${expectation} (§9.8)`,
    ];
  }
  if (stale && row["decision"] === "confirmed") {
    const resolvedKinds = (evidence as string[])
      .filter((ref) => artifactKinds.has(ref))
      .map((ref) => artifactKinds.get(ref));
    if (
      resolvedKinds.length === evidence.length &&
      !resolvedKinds.includes(STALE_EVIDENCE_KIND)
    ) {
      return [
        `${path}: /evidence for a stale status must cite ` +
          "the user's own note (§9.8/§31.5)",
      ];
    }
  }
  return [];
}

/**
 * The memory of rejected proposals, carried across a whole journal read.
 *
 * Keyed by the proposal's identity — target, dimension, proposed value — and
 * holding every evidence set already refused for it. A re-proposal whose
 * evidence is a subset of one of those brings nothing new (§14.6).
 */
export type RejectedProposals = Map<string, Array<ReadonlySet<string>>>;

export const newRejectedProposals = (): RejectedProposals => new Map();

/** §14.6: retain rejected proposal identities across the journal. */
export function reproposalErrors(
  row: unknown,
  path: unknown,
  rejected: RejectedProposals,
  knownTargets: ReadonlySet<string>,
  retired: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!isDict(row)) return [];
  let target = asString(row["target"]);
  const dimension = asString(row["dimension"]);
  const proposed = asString(row["to"]);
  const evidence = row["evidence"];
  const outcome = asString(row["decision"]);
  if (
    target === null ||
    dimension === null ||
    proposed === null ||
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    !evidence.every((ref) => typeof ref === "string") ||
    outcome === null ||
    !DECISION_OUTCOMES.has(outcome)
  ) {
    return [];
  }

  target = retired.get(target)?.[0] ?? target;
  // The builder skips a missing target before proposal-memory handling.
  const kind = idType(target);
  if (
    !knownTargets.has(target) ||
    kind === null ||
    FOLDED_DECISION_TARGETS.get(dimension)?.has(kind) !== true
  ) {
    return [];
  }

  // A tuple is a dict key in Python and is not one in JavaScript, so the three
  // parts are joined on a separator no id, dimension or ladder value can
  // contain — every one of them is a slug or a slug pair (§10.1). Written as
  // an escape and never as the byte: a NUL in a source file makes the file
  // binary to grep, diff and review, which is how this one hid for a while.
  const identity = [target, dimension, proposed].join("\u0000");
  const evidenceSet: ReadonlySet<string> = new Set(evidence as string[]);
  const priors = rejected.get(identity) ?? [];
  if (priors.some((rejectedEvidence) => isSubset(evidenceSet, rejectedEvidence))) {
    return [
      `${path}: a rejected proposal cannot be re-proposed without ` +
        "new evidence (§14.6/§9.13)",
    ];
  }
  if (outcome === "rejected") {
    if (!rejected.has(identity)) rejected.set(identity, []);
    (rejected.get(identity) as Array<ReadonlySet<string>>).push(evidenceSet);
  }
  return [];
}

/**
 * §33.4: every §9.12 evidence id in an evidence-bearing field resolves in the
 * top-level evidence_refs table; curated node ids `via` may carry (a material
 * part) are node refs, never table entries.
 */
export function snapshotDanglingRefs(snapshot: Dict, path: unknown): string[] {
  const table = snapshot["evidence_refs"];
  const known = isDict(table) ? new Set(Object.keys(table)) : new Set<string>();
  const errors: string[] = [];

  // The table maps §9.12 evidence ids to {kind, date}; the key's prefix is its
  // kind — a mismatch corrupts the provenance table (§33.4).
  if (isDict(table)) {
    for (const [key, entry] of Object.entries(table)) {
      if (!EVIDENCE_ID_RE.test(key)) {
        errors.push(
          `${path}: evidence_refs key ${show(key)} is not a §9.12 evidence id`,
        );
        continue;
      }
      const kind = isDict(entry) ? entry["kind"] : null;
      if (typeof kind === "string" && prefixOf(key) !== kind) {
        errors.push(
          `${path}: evidence_refs[${key}] kind ${show(kind)} does not match ` +
            "the id prefix (§33.4)",
        );
      }
    }
  }

  // §33.4: materials is material contact state (§14.8) — keys are
  // material(part) ids only.
  for (const key of Object.keys(asDict(snapshot["materials"]))) {
    if (!MATERIAL_ID_RE.test(key)) {
      errors.push(
        `${path}: materials key ${show(key)} is not a material(part) id ` +
          "(§33.4, §14.8)",
      );
    }
  }

  const check = (refs: unknown, where: string): void => {
    for (const ref of asList(refs)) {
      if (
        typeof ref === "string" &&
        EVIDENCE_PREFIXES.some((prefix) => ref.startsWith(prefix)) &&
        !known.has(ref)
      ) {
        errors.push(`${path}: ${where} cites ${ref}, absent from evidence_refs (§33.4)`);
      }
    }
  };

  for (const [node, entry] of Object.entries(asDict(snapshot["state"]))) {
    if (!isDict(entry)) continue;
    check(entry["evidence"], `state.${node}.evidence`);
    asList(entry["decisions"]).forEach((decision, index) => {
      if (isDict(decision)) {
        check(decision["evidence"], `state.${node}.decisions[${index}].evidence`);
      }
    });
  }
  for (const [node, entry] of Object.entries(asDict(snapshot["materials"]))) {
    if (isDict(entry)) check(entry["evidence"], `materials.${node}.evidence`);
  }
  asList(snapshot["trail"]).forEach((segment, index) => {
    if (isDict(segment)) check(segment["via"], `trail[${index}].via`);
  });
  asList(snapshot["questions"]).forEach((question, index) => {
    if (isDict(question)) check(question["source"], `questions[${index}].source`);
  });
  return errors;
}

const STATE_DIMENSIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["concept", new Set(["exposure", "confidence", "clarity", "coverage", "freshness"])],
  ["pattern", new Set(["exposure", "confidence", "clarity", "coverage", "freshness"])],
  [
    "zone",
    new Set(["contact", "strength", "endurance", "mobility", "condition", "freshness"]),
  ],
]);

// §14.8/§33.4: the material contact ladder lives under `materials` — a region
// state entry never carries it, so it is cross-kind everywhere.
const MATERIAL_STATE_DIMENSIONS: ReadonlySet<string> = new Set(["depth_reached"]);

const ALL_STATE_DIMENSIONS: ReadonlySet<string> = new Set([
  ...[...STATE_DIMENSIONS.values()].flatMap((names) => [...names]),
  ...MATERIAL_STATE_DIMENSIONS,
]);

const EXPOSURE_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "concept",
    new Set(["unseen", "touched", "read", "summarized", "applied", "taught"]),
  ],
  [
    "pattern",
    new Set(["unseen", "touched", "studied", "tried", "drilled", "reviewed"]),
  ],
]);

const DECISION_DIMENSIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["concept", new Set(["confidence", "clarity", "coverage"])],
  ["pattern", new Set(["confidence", "clarity", "coverage"])],
  ["zone", new Set(["strength", "endurance", "mobility", "condition"])],
]);

const ALL_DECISION_DIMENSIONS: ReadonlySet<string> = new Set(
  [...DECISION_DIMENSIONS.values()].flatMap((names) => [...names]),
);

/**
 * §33.4: per-node state exports on the node's own scales — a concept never
 * carries a zone ladder. Only cross-kind dimension keys are errors; unknown
 * keys stay additive (§25.7).
 */
export function snapshotStateKindErrors(snapshot: Dict, path: unknown): string[] {
  const errors: string[] = [];
  for (const [node, entry] of Object.entries(asDict(snapshot["state"]))) {
    if (!REGION_ID_RE.test(node)) {
      errors.push(`${path}: state key ${show(node)} is not a region node id (§33.4)`);
      continue;
    }
    const kind = prefixOf(node);
    const allowed = STATE_DIMENSIONS.get(kind) as ReadonlySet<string>;
    if (!isDict(entry)) continue;

    for (const key of Object.keys(entry)) {
      if (ALL_STATE_DIMENSIONS.has(key) && !allowed.has(key)) {
        errors.push(
          `${path}: state.${node} carries ${show(key)} — not a ${kind} ` +
            "dimension (§33.4: a node exports its own scales)",
        );
      }
    }

    const exposure = asString(entry["exposure"]);
    const ladder = EXPOSURE_VALUES.get(kind);
    if (exposure !== null && ladder !== undefined && !ladder.has(exposure)) {
      errors.push(
        `${path}: state.${node} exposure ${show(exposure)} is outside the ` +
          `${kind} ladder (§14.1/§32.3)`,
      );
    }

    const gated = DECISION_DIMENSIONS.get(kind) ?? new Set<string>();
    asList(entry["decisions"]).forEach((decision, index) => {
      if (!isDict(decision)) return;
      const dimension = asString(decision["dimension"]);
      if (
        dimension !== null &&
        ALL_DECISION_DIMENSIONS.has(dimension) &&
        !gated.has(dimension)
      ) {
        errors.push(
          `${path}: state.${node}.decisions[${index}] gates ` +
            `${show(dimension)} — not a ${kind} dimension (§33.4, §14.6)`,
        );
      }
    });
  }
  return errors;
}

/**
 * Whether two JSON values are the same value.
 *
 * Structural, because the oracle's `==` is: a list of strings compared here
 * arrives from two different documents and is never the same object.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (isDict(left) && isDict(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
      )
    );
  }
  return false;
}

const isSubset = (
  inner: ReadonlySet<string>,
  outer: ReadonlySet<string>,
): boolean => {
  for (const value of inner) if (!outer.has(value)) return false;
  return true;
};
