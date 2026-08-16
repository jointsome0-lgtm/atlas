// The Atlas vocabulary and the derivations that read it: node and edge kinds,
// the §14 ladders, the review gates, field membership (§10.4), freshness
// (§14.7). Transcribed from the § files, which own every number and word here.
//
// One source, deliberately. The builder emits against these and the boundary
// validator checks emissions against them; a second transcription is how the
// two drift apart, and a drifted validator passes exactly the graph the
// builder should not have written.
//
// Ported from the head of scripts/build_atlas_graph.py, which the Python
// validator imports for the same reason. Everything here is pure: no reading,
// no writing, and no knowledge of where a graph came from — the inputs are
// arbitrary JSON, because a boundary check runs on input that failed.

import { compareCodePoint, sortedByCodePoint } from "./ordering.ts";
import { daysBetween, parseDate } from "./calendar.ts";

/** §10.1 — closed set; a domain pass extends it in the same commit. */
export const NODE_TYPES: ReadonlySet<string> = new Set([
  "plan", "concept", "material", "material_part", "direction",
  "suggested_route", "personal_trail", "trail_segment", "artifact",
  "encounter", "question", "probe", "zone", "pattern",
]);

/** Id prefix → node type (§10.1: the hyphenated type name, or `part:`). */
export const ID_PREFIXES: ReadonlyMap<string, string> = new Map([
  ["concept", "concept"],
  ["material", "material"],
  ["part", "material_part"],
  ["direction", "direction"],
  ["suggested-route", "suggested_route"],
  ["trail-segment", "trail_segment"],
  ["personal-trail", "personal_trail"],
  ["artifact", "artifact"],
  ["encounter", "encounter"],
  ["question", "question"],
  ["probe", "probe"],
  ["plan", "plan"],
  ["zone", "zone"],
  ["pattern", "pattern"],
]);

/** §10.2 — closed set; extended only by a domain pass in the same commit. */
export const EDGE_TYPES: ReadonlySet<string> = new Set([
  "related_to", "prerequisite_of", "extends", "implements", "contradicts",
  "alternative_to", "explains", "demonstrates", "critiques", "mentions",
  "loads", "has_part", "overall_concept", "supports", "part_of_direction",
  "step_of_route", "suggested_next", "visited", "moved_to", "via",
  "pulled_by", "produced_artifact", "updates_state", "influences",
  "probed_by", "primary_for", "supporting_for",
]);

// §10.1 — the id shape is part of the graph contract (§16.4 uses ids as URL
// focus values): kebab-case slugs, underscores never, parts carry the material.
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

// The authored pattern and the compiled matcher, kept apart on purpose: the
// pattern is the transcription that has to match the oracle's, while a
// compiled `RegExp` re-escapes its own source and so cannot be compared to
// one.
export const PART_ID_PATTERN = `^part:${SLUG}/${SLUG}$`;
export const NODE_ID_PATTERN = `^[a-z-]+:${SLUG}$`;
export const PART_ID_RE = new RegExp(PART_ID_PATTERN);
export const NODE_ID_RE = new RegExp(NODE_ID_PATTERN);

/**
 * §9.1/§9.3/§32.1 — roles an author may write in `concept_edges`; the
 * structural types (has_part, step_of_route, …) are the builder's alone.
 */
export const AUTHORED_ROLES: ReadonlySet<string> = new Set([
  "related_to", "prerequisite_of", "extends", "implements", "contradicts",
  "alternative_to", "explains", "demonstrates", "critiques", "mentions",
  "loads",
]);

/**
 * §20.3: the authored concept-kind relations whose direction carries no
 * meaning; canonicalization sorts their endpoints before identity and dedup.
 */
export const SYMMETRIC_EDGE_TYPES: ReadonlySet<string> = new Set([
  "related_to", "alternative_to",
]);

/**
 * §9.10: one-hop weak influence traverses exactly this structural set.
 *
 * Influence emission is still §29 Phase 4; keeping its closed row here stops
 * the vocabulary drifting before that producer lands.
 */
export const WEAK_HALO_EDGE_TYPES: ReadonlySet<string> = new Set([
  "related_to", "prerequisite_of", "extends", "contradicts",
  "alternative_to", "loads",
]);

// §10.4: fields = the union of the fields of the region nodes reachable
// through the kind's listed refs; chains bottom out at the §10.1 registry
// (concept → knowledge; zone, pattern → body), so resolution is acyclic.
export const REGISTRY_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["concept", ["knowledge"]],
  ["zone", ["body"]],
  ["pattern", ["body"]],
]);

const FIELD_DERIVED_KINDS: ReadonlySet<string> = new Set([
  "material", "material_part", "suggested_route", "direction", "probe",
  "question", "artifact", "encounter", "trail_segment", "plan",
]);

const PART_EDGE_ROLES: ReadonlySet<string> = new Set([
  "prerequisite_of", "extends", "contradicts", "implements",
  "explains", "demonstrates", "critiques", "mentions",
]);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * §10.4 over an emitted graph: recompute every derived-kind node's fields from
 * the instance's own edges and payload-held refs.
 *
 * Shared canon — the boundary validator checks emissions against it and
 * redaction withholds the nodes it strands — so it is hardened for arbitrary
 * JSON, not only for the builder's own output.
 */
export function graphFieldExpectations(
  instance: unknown,
): Map<string, string[]> {
  const graph = asRecord(instance) ?? {};

  const types = new Map<string, string | null>();
  for (const entry of asList(graph["nodes"])) {
    const node = asRecord(entry);
    if (node === null || typeof node["id"] !== "string") continue;
    // A non-string type already carries its own schema diagnostic; null keeps
    // every membership test below over a value that can be compared.
    const nodeType = node["type"];
    types.set(node["id"], typeof nodeType === "string" ? nodeType : null);
  }

  const refs = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const existing = refs.get(from);
    if (existing === undefined) refs.set(from, [to]);
    else existing.push(to);
  };

  for (const entry of asList(graph["edges"])) {
    const edge = asRecord(entry);
    if (edge === null) continue;
    const source = edge["source"];
    const target = edge["target"];
    const kind = edge["type"];
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      typeof kind !== "string"
    ) {
      continue;
    }
    if (kind === "overall_concept" || kind === "has_part") {
      link(source, target);
    } else if (PART_EDGE_ROLES.has(kind) && types.get(source) === "material_part") {
      link(source, target);
    } else if (
      kind === "step_of_route" ||
      kind === "part_of_direction" ||
      kind === "probed_by" ||
      kind === "pulled_by"
    ) {
      link(target, source);
    } else if (kind === "influences" || kind === "updates_state" || kind === "visited") {
      link(source, target);
    }
  }

  for (const entry of asList(graph["nodes"])) {
    const node = asRecord(entry);
    if (node === null || typeof node["id"] !== "string") continue;
    const id = node["id"];
    // §10.4 payload-held refs: a trail segment derives from ∪ to, and a plan
    // derives its routes' fields through their source_plan.
    if (types.get(id) === "encounter" && typeof node["target"] === "string") {
      link(id, node["target"]);
    }
    if (types.get(id) === "trail_segment") {
      const origin = node["from"];
      const origins = Array.isArray(origin) ? origin : [origin];
      for (const ref of [...origins, node["to"]]) {
        if (typeof ref === "string") link(id, ref);
      }
    }
    const sourcePlan = node["source_plan"];
    if (types.get(id) === "suggested_route" && typeof sourcePlan === "string") {
      link(sourcePlan, id);
    }
  }

  const fieldsOf = (nodeId: string, seen: ReadonlySet<string>): Set<string> => {
    if (seen.has(nodeId)) return new Set();
    const registry = REGISTRY_FIELDS.get(types.get(nodeId) ?? "");
    if (registry !== undefined) return new Set(registry);
    const result = new Set<string>();
    const deeper = new Set(seen).add(nodeId);
    for (const ref of refs.get(nodeId) ?? []) {
      for (const field of fieldsOf(ref, deeper)) result.add(field);
    }
    return result;
  };

  const expectations = new Map<string, string[]>();
  for (const [nodeId, kind] of types) {
    if (kind !== null && FIELD_DERIVED_KINDS.has(kind)) {
      expectations.set(nodeId, sortedByCodePoint([...fieldsOf(nodeId, new Set())]));
    }
  }
  return expectations;
}

/**
 * §32.1: patterns are concept-kind nodes — a program part maps to patterns
 * exactly as a chapter maps to concepts.
 */
export const CONCEPT_KIND: ReadonlySet<string> = new Set(["concept", "pattern"]);

const withConcept = (...extra: string[]): ReadonlySet<string> =>
  new Set([...CONCEPT_KIND, ...extra]);

/**
 * §10.2's endpoint-kind contract per emitted edge type, as (source, target)
 * kinds — transcribed in full so check-constants can catch either-side drift.
 */
export const ENDPOINT_RULES: ReadonlyMap<
  string,
  readonly [ReadonlySet<string>, ReadonlySet<string>]
> = new Map([
  ["related_to", [CONCEPT_KIND, CONCEPT_KIND]],
  ["prerequisite_of", [withConcept("material_part"), CONCEPT_KIND]],
  ["extends", [withConcept("material_part"), CONCEPT_KIND]],
  ["implements", [new Set(["material_part"]), CONCEPT_KIND]],
  ["contradicts", [withConcept("material_part"), CONCEPT_KIND]],
  ["alternative_to", [CONCEPT_KIND, CONCEPT_KIND]],
  ["explains", [new Set(["material_part"]), CONCEPT_KIND]],
  ["demonstrates", [new Set(["material_part"]), CONCEPT_KIND]],
  ["critiques", [new Set(["material_part"]), CONCEPT_KIND]],
  ["mentions", [new Set(["material_part"]), CONCEPT_KIND]],
  ["loads", [new Set(["pattern"]), new Set(["zone"])]],
  ["supports", [
    new Set(["material", "material_part"]),
    new Set(["material", "material_part"]),
  ]],
  ["has_part", [new Set(["material"]), new Set(["material_part"])]],
  ["overall_concept", [new Set(["material"]), CONCEPT_KIND]],
  ["part_of_direction", [CONCEPT_KIND, new Set(["direction"])]],
  ["step_of_route", [CONCEPT_KIND, new Set(["suggested_route"])]],
  ["suggested_next", [CONCEPT_KIND, CONCEPT_KIND]],
  ["probed_by", [withConcept("zone"), new Set(["probe"])]],
  ["pulled_by", [withConcept("zone"), new Set(["question"])]],
  ["visited", [new Set(["encounter"]), new Set(["material", "material_part"])]],
  ["influences", [new Set(["artifact"]), withConcept("zone")]],
  ["updates_state", [new Set(["artifact"]), withConcept("zone")]],
  ["moved_to", [CONCEPT_KIND, CONCEPT_KIND]],
  ["via", [new Set(["trail_segment"]), new Set(["material", "material_part"])]],
  ["produced_artifact", [new Set(["trail_segment"]), new Set(["artifact"])]],
  ["primary_for", [
    new Set(["material", "material_part"]),
    new Set(["suggested_route", "question", "trail_segment"]),
  ]],
  ["supporting_for", [
    new Set(["material", "material_part"]),
    new Set(["suggested_route", "question", "trail_segment"]),
  ]],
]);

/** §14.9 — authored edge weight is a closed scale (the import-time guess). */
export const EDGE_WEIGHTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * §8: at least one domain directory distinguishes a curated tree from a
 * missing or mis-mounted instance path.
 */
export const CURATED_SUBDIRECTORIES: readonly string[] = [
  "concepts", "materials", "zones", "patterns", "directions",
  "suggested-routes", "trails", "probes",
];

/**
 * §9.6/§9.7/§9.8 (§25.7): the journal schemas close their key sets, so a typo
 * key must fail here too and never be quietly ignored — a misspelled
 * `sensitivity` drops a privacy marking.
 */
export const JOURNAL_ROW_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["artifacts", new Set([
    "id", "type", "path", "observed_at", "summary", "touches",
    "supports_state_updates", "evidence_strength", "probe", "sensitivity",
    "intake",
  ])],
  ["encounters", new Set([
    "id", "date", "target", "depth", "mode", "context", "sensitivity", "intake",
  ])],
  ["questions", new Set([
    "id", "type", "text", "created_at", "pulls", "source", "sensitivity",
    "intake",
  ])],
  ["decisions", new Set([
    "date", "target", "dimension", "to", "evidence", "proposed_by", "decision",
    "sensitivity", "intake",
  ])],
]);

/**
 * §9.6/§9.8: touches, supports_state_updates and pulls hold region ids — the
 * journal schemas pin regionId to these three kinds.
 */
export const REGION_PREFIXES: ReadonlySet<string> = new Set([
  "concept", "pattern", "zone",
]);

/** §33.2 (§25.7): the optional intake provenance key — batch/entry#row. */
export const INTAKE_KEY_PATTERN = `^${SLUG}/${SLUG}#[0-9]+$`;
export const INTAKE_KEY_RE = new RegExp(INTAKE_KEY_PATTERN);

/** §9.2/§9.11 — lifecycle vocabulary for everything that is not a route. */
export const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set(["active", "archived"]);

/** §9.2 material kinds, transcribed verbatim (checked by check-constants). */
export const MATERIAL_KINDS: ReadonlySet<string> = new Set([
  "article", "docs", "paper", "book", "repo", "video", "course", "spec",
  "tutorial", "internal",
]);

/** §32.6/§33.2 sensitivity classes, transcribed verbatim. */
export const SENSITIVITY_CLASSES: ReadonlySet<string> = new Set(["medical"]);

/** §9.7 — encounter scales, transcribed verbatim. */
export const ENCOUNTER_DEPTHS: ReadonlySet<string> = new Set([
  "skim", "read", "summarized", "applied", "taught",
]);

export const ENCOUNTER_MODES: ReadonlySet<string> = new Set([
  "plan-driven", "question-driven", "artifact-driven", "background",
]);

/** §11.2 — deep use folds a question-context material primary. */
export const DEEP_USE_DEPTHS: ReadonlySet<string> = new Set(["applied", "taught"]);

/** §9.6 — artifact evidence strengths, transcribed verbatim. */
export const EVIDENCE_STRENGTHS: ReadonlySet<string> = new Set([
  "noticed", "read", "summarized", "applied", "explained", "reviewed",
  "performed", "drilled",
]);

/**
 * §14.1–§14.8/§9.8 — the knowledge-only V-build fold scales.
 *
 * Pattern and zone ladders stay frozen under #45; edge weight is §20 step 10's
 * sibling work and is validated only when its decision rows are read.
 */
export const CONCEPT_EXPOSURE: readonly string[] = [
  "unseen", "touched", "read", "summarized", "applied", "taught",
];

export const CONCEPT_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ["confidence", "unknown"],
  ["clarity", "vague"],
  ["coverage", "none"],
]);

export const QUESTION_DEFAULT_STATUS = "open";

/**
 * §14.5 — the artifact strength → concept exposure ladder, as ranks into
 * CONCEPT_EXPOSURE. Encounters enter the same ladder capped at `read`.
 */
export const ARTIFACT_EXPOSURE_RANK: ReadonlyMap<string, number> = new Map([
  ["noticed", 1],
  ["read", 2],
  ["summarized", 3],
  ["explained", 3],
  ["applied", 4],
  ["reviewed", 4],
  ["performed", 4],
  ["drilled", 4],
]);

export const MATERIAL_DEPTH: readonly string[] = [
  "skim", "read", "summarized", "applied", "taught",
];

/**
 * §14.5: the highest exposure rank the cited records could produce.
 *
 * An upper bound, because the fold also depends on link kind and on same-day
 * journal position the emission does not repeat. The boundary uses it to
 * reject an exposure no cited evidence can support (§31.3).
 */
export function exposureCeiling(
  evidenceIds: readonly unknown[],
  nodes: ReadonlyMap<string, unknown>,
): number {
  let ceiling = 0;
  const explanations: string[] = [];
  const reviews: string[] = [];
  for (const ref of evidenceIds) {
    if (typeof ref !== "string") continue;
    const node = asRecord(nodes.get(ref));
    if (node === null) continue;
    if (node["type"] === "artifact") {
      const strength = node["evidence_strength"];
      // The graph is untrusted boundary input. Its schema reports a malformed
      // strength, but this shared semantic check still runs, so never hand a
      // rejected value to a lookup that assumes one.
      if (typeof strength !== "string") continue;
      const observedAt = node["observed_at"];
      if (typeof observedAt === "string") {
        if (strength === "explained") explanations.push(observedAt);
        else if (strength === "reviewed") reviews.push(observedAt);
      }
      ceiling = Math.max(ceiling, ARTIFACT_EXPOSURE_RANK.get(strength) ?? 0);
    } else if (node["type"] === "encounter") {
      // A skim is contact; read or deeper is capped at read (§14.5).
      ceiling = Math.max(ceiling, node["depth"] === "skim" ? 1 : 2);
    }
  }
  // Cross-day order is repeated by the emitted artifact dates. Same-day
  // position is not, so equality stays an intentional upper-bound case.
  if (explanations.length > 0 && reviews.length > 0) {
    const latestReview = maxByCodePoint(reviews);
    const earliestExplanation = minByCodePoint(explanations);
    if (compareCodePoint(latestReview, earliestExplanation) >= 0) {
      ceiling = CONCEPT_EXPOSURE.length - 1;
    }
  }
  return ceiling;
}

/**
 * §14.8: the deepest rank the cited encounter records could produce — the
 * boundary's upper bound. The producer fold additionally joins each encounter
 * to its exact target; this does not partially refold.
 */
export function depthCeiling(
  evidenceIds: readonly unknown[],
  nodes: ReadonlyMap<string, unknown>,
): number {
  let ceiling = 0;
  for (const ref of evidenceIds) {
    if (typeof ref !== "string") continue;
    const node = asRecord(nodes.get(ref));
    if (node === null || node["type"] !== "encounter") continue;
    const depth = node["depth"];
    if (typeof depth === "string") {
      const rank = MATERIAL_DEPTH.indexOf(depth);
      if (rank >= 0) ceiling = Math.max(ceiling, rank);
    }
  }
  return ceiling;
}

/**
 * §14.7 owns these numbers; this transcribes them, as `viewer/contract.js`
 * transcribes them for its acceptance recompute. Two transcriptions of one
 * canon, not two policies — tuning them is a version bump there, never a
 * config edit here (#108), so the parity test reads the § and checks both.
 */
export const FRESHNESS_DAYS: ReadonlyMap<string, number> = new Map([
  ["fresh", 30],
  ["aging", 90],
]);

/**
 * §14.7: freshness is a derivation, not a stored judgement — the age of the
 * last contact against the fold's as-of, in inclusive buckets. Every boundary
 * recomputes it from this one definition.
 */
export function freshnessOf(lastSeen: string, asOf: string): string {
  const age = daysBetween(parseDate(lastSeen), parseDate(asOf));
  if (age <= (FRESHNESS_DAYS.get("fresh") as number)) return "fresh";
  return age <= (FRESHNESS_DAYS.get("aging") as number) ? "aging" : "stale";
}

/**
 * §14.6/§9.8: the review-gated values, and the value each holds until a
 * decision moves it. A non-default value without its decision is imported
 * understanding (§31), so the graph boundary rejects it.
 */
export const GATED_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ...CONCEPT_DEFAULTS,
  ["status", QUESTION_DEFAULT_STATUS],
]);

export const DECISION_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["confidence", new Set(["unknown", "low", "medium", "high"])],
  ["clarity", new Set(["vague", "rough", "stable", "disputed"])],
  ["coverage", new Set(["none", "partial", "broad"])],
  ["weight", new Set(["low", "medium", "high"])],
  ["status", new Set(["open", "clarified", "resolved", "stale"])],
]);

/**
 * §20 step 9's slice boundary, in one place.
 *
 * The only source of truth for what this build applies: the refusals and the
 * fold's own scope predicate both read it, so no dimension or target kind can
 * be accepted into a build that then quietly fails to fold it.
 */
export const FOLDED_DECISION_TARGETS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["confidence", new Set(["concept"])],
    ["clarity", new Set(["concept"])],
    ["coverage", new Set(["concept"])],
    ["status", new Set(["question"])],
  ]);

/**
 * Canon-valid §9.13 rows this slice does not fold, with the reason the owner
 * reads. §9.13 and journal-decision.schema.json keep the whole vocabulary
 * (#58): only the builder defers, and each gate reopens by deleting a line.
 */
export const DEFERRED_DIMENSIONS: ReadonlyMap<string, string> = new Map([
  ["weight", "§14.9 edge weight, folded in a later slice"],
  ["strength", "a §32 body ladder, deferred during the Body Atlas freeze (§29, #45)"],
  ["endurance", "a §32 body ladder, deferred during the Body Atlas freeze (§29, #45)"],
  ["mobility", "a §32 body ladder, deferred during the Body Atlas freeze (§29, #45)"],
  ["condition", "a §32 body ladder, deferred during the Body Atlas freeze (§29, #45)"],
]);

export const DEFERRED_DECISION_TARGET_KINDS: ReadonlyMap<string, string> = new Map([
  ["pattern", "a §32 body-domain target, deferred during the Body Atlas freeze (§29, #45)"],
]);

export const DECISION_TARGET_PREFIXES: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["confidence", new Set(["concept", "pattern"])],
    ["clarity", new Set(["concept", "pattern"])],
    ["coverage", new Set(["concept", "pattern"])],
    ["status", new Set(["question"])],
  ]);

export const DECISION_OUTCOMES: ReadonlySet<string> = new Set(["confirmed", "rejected"]);

export const EVIDENCE_PREFIXES: ReadonlySet<string> = new Set([
  "artifact", "encounter", "question",
]);

/**
 * §9.8: question status cites the record that made the transition true, so a
 * question's own creation record is not evidence for its own outcome.
 */
export const STATUS_EVIDENCE_PREFIXES: ReadonlySet<string> = new Set([
  "artifact", "encounter",
]);

/** §9.8/§31.5: staleness is the user's own judgment, recorded as a note. */
export const STALE_EVIDENCE_PREFIXES: ReadonlySet<string> = new Set(["artifact"]);
export const STALE_EVIDENCE_KIND = "note";

/**
 * §17.1 — the four core roles, pinned against run-manifest.schema.json by
 * check-constants. §9.13 admits one of these, or the user, as a proposer.
 */
export const AGENT_ROLES: ReadonlySet<string> = new Set([
  "plan-importer", "artifact-observer", "field-cartographer", "state-auditor",
]);

export const PROPOSERS: ReadonlySet<string> = new Set([...AGENT_ROLES, "user"]);

/** §9.4 — route lifecycle vocabulary; task-state words are §4 leakage. */
export const ROUTE_STATUSES: ReadonlySet<string> = new Set([
  "available", "hidden", "partially_followed", "ignored", "archived",
]);

export const FORBIDDEN_ROUTE_STATUSES: ReadonlySet<string> = new Set([
  "done", "failed", "late", "blocked",
]);

/** The node type an id's prefix names, or null when the prefix is unknown. */
export function idType(nodeId: string): string | null {
  const prefix = nodeId.split(":", 1)[0] as string;
  return ID_PREFIXES.get(prefix) ?? null;
}

/** §20.1's total order inside one journal. */
export function foldOrderKey(date: string, position: number): [string, number] {
  return [date, position];
}

// Python compares dates as strings here, and so does this: both are the same
// comparison on the same ASCII shape, but going through the code-point helper
// says which comparison it is rather than leaning on a host default.
function maxByCodePoint(values: readonly string[]): string {
  return values.reduce((best, value) =>
    compareCodePoint(value, best) > 0 ? value : best,
  );
}

function minByCodePoint(values: readonly string[]): string {
  return values.reduce((best, value) =>
    compareCodePoint(value, best) < 0 ? value : best,
  );
}
