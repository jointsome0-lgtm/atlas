// Generated from viewer/src/contract.ts by scripts/build_viewer.ts — do not edit.
export const CEILINGS = {
  graph_file_bytes: 67108864,
  graph_nodes: 131072,
  graph_edges: 262144,
  fragment_raw_bytes: 1024,
  parameter_decoded_bytes: 512
};
export const FRESHNESS_DAYS = {
  fresh: 30,
  aging: 90
};
export const ENVELOPE_KEYS = ["format", "version", "generated_at", "nodes", "edges", "trails", "state", "influence", "frontier", "projections", "withheld"];
export const NODE_KEYS = ["id", "type", "title", "fields", "formerly", "sensitivity", "aliases", "notes", "material", "kind", "url", "status", "source_plan", "attractor", "stable_while", "text", "created_at", "source", "body", "path", "observed_at", "summary", "evidence_strength", "probe", "date", "target", "depth", "mode", "context", "direction", "from", "to", "via", "reason", "resulting_questions"];
export const EDGE_KEYS = ["source", "target", "type", "provenance", "sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note", "alternative_in"];
export const NODE_TYPES = ["plan", "concept", "material", "material_part", "direction", "suggested_route", "personal_trail", "trail_segment", "artifact", "encounter", "question", "probe", "zone", "pattern"];
export const EDGE_TYPES = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "alternative_to", "explains", "demonstrates", "critiques", "mentions", "loads", "has_part", "overall_concept", "supports", "part_of_direction", "step_of_route", "suggested_next", "visited", "moved_to", "via", "pulled_by", "produced_artifact", "updates_state", "influences", "probed_by", "primary_for", "supporting_for"];
export const AUTHORED_ROLES = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "alternative_to", "explains", "demonstrates", "critiques", "mentions", "loads"];
export const FIELDS = ["knowledge", "body"];
export const ID_PREFIXES = { concept: "concept", material: "material", part: "material_part", direction: "direction", "suggested-route": "suggested_route", "trail-segment": "trail_segment", "personal-trail": "personal_trail", artifact: "artifact", encounter: "encounter", question: "question", probe: "probe", plan: "plan", zone: "zone", pattern: "pattern" };
export const MATERIAL_KINDS = ["article", "docs", "paper", "book", "repo", "video", "course", "spec", "tutorial", "internal"];
export const EVIDENCE_STRENGTHS = ["noticed", "read", "summarized", "applied", "explained", "reviewed", "performed", "drilled"];
export const ENCOUNTER_DEPTHS = ["skim", "read", "summarized", "applied", "taught"];
export const ENCOUNTER_MODES = ["plan-driven", "question-driven", "artifact-driven", "background"];
export const SENSITIVITY_CLASSES = ["medical"];
export const EDGE_WEIGHTS = ["low", "medium", "high", "unassessed"];
export const CONFIDENCE_VALUES = ["unknown", "low", "medium", "high"];
export const CONCEPT_EXPOSURES = ["unseen", "touched", "read", "summarized", "applied", "taught"];
export const CLARITY_VALUES = ["vague", "rough", "stable", "disputed"];
export const COVERAGE_VALUES = ["none", "partial", "broad"];
export const FRESHNESS_VALUES = ["fresh", "aging", "stale"];
export const QUESTION_STATUSES = ["open", "clarified", "resolved", "stale"];
export const LIFECYCLE_STATUSES = ["active", "archived"];
export const ROUTE_STATUSES = ["available", "hidden", "partially_followed", "ignored", "archived"];
export const ENDPOINT_RULES = { related_to: [["concept", "pattern"], ["concept", "pattern"]], prerequisite_of: [["concept", "material_part", "pattern"], ["concept", "pattern"]], extends: [["concept", "material_part", "pattern"], ["concept", "pattern"]], implements: [["material_part"], ["concept", "pattern"]], contradicts: [["concept", "material_part", "pattern"], ["concept", "pattern"]], alternative_to: [["concept", "pattern"], ["concept", "pattern"]], explains: [["material_part"], ["concept", "pattern"]], demonstrates: [["material_part"], ["concept", "pattern"]], critiques: [["material_part"], ["concept", "pattern"]], mentions: [["material_part"], ["concept", "pattern"]], loads: [["pattern"], ["zone"]], supports: [["material", "material_part"], ["material", "material_part"]], has_part: [["material"], ["material_part"]], overall_concept: [["material"], ["concept", "pattern"]], part_of_direction: [["concept", "pattern"], ["direction"]], step_of_route: [["concept", "pattern"], ["suggested_route"]], suggested_next: [["concept", "pattern"], ["concept", "pattern"]], probed_by: [["concept", "pattern", "zone"], ["probe"]], pulled_by: [["concept", "pattern", "zone"], ["question"]], visited: [["encounter"], ["material", "material_part"]], influences: [["artifact"], ["concept", "pattern", "zone"]], updates_state: [["artifact"], ["concept", "pattern", "zone"]], moved_to: [["concept", "pattern"], ["concept", "pattern"]], via: [["trail_segment"], ["material", "material_part"]], produced_artifact: [["trail_segment"], ["artifact"]], primary_for: [["material", "material_part"], ["suggested_route", "question", "trail_segment"]], supporting_for: [["material", "material_part"], ["suggested_route", "question", "trail_segment"]] };
export const MODES = ["field", "material", "route", "trail", "influence", "state", "frontier", "question"];
export const DEFAULT_FIELD = FIELDS[0];
export const RENDER_NODE_LINK_CEILING = 2400;
const TEXT_ENCODER = new TextEncoder;
const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SLUG_RE = new RegExp("^" + SLUG_SOURCE + "$");
const NODE_ID_RE = new RegExp("^(?:(?:plan|concept|material|direction|suggested-route|personal-trail|trail-segment|artifact|encounter|question|probe|zone|pattern):" + SLUG_SOURCE + "|part:" + SLUG_SOURCE + "/" + SLUG_SOURCE + ")$");
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const GENERATED_AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;
const KNOWN_FRAGMENT_KEYS = new Set(["mode", "focus", "field"]);
const AUTHORED_WEIGHT_TYPES = new Set([...AUTHORED_ROLES, "supports"]);
const DERIVED_WEIGHT_TYPES = new Set(EDGE_TYPES.filter((type) => !AUTHORED_WEIGHT_TYPES.has(type)));
const STATUS_FORBIDDEN = new Set(["concept", "pattern", "zone", "material_part", "personal_trail", "trail_segment", "artifact", "encounter", "question", "plan"]);
const EDGE_DISCRIMINANTS = {
  step_of_route: ["order"],
  suggested_next: ["context"]
};
const NO_REDIRECT_KINDS = new Set(["trail_segment", "artifact", "encounter", "question"]);
const NODE_COMMON_KEYS = new Set(["id", "type", "title", "fields", "formerly", "sensitivity"]);
const NODE_PAYLOAD_FIELDS = {
  concept: ["aliases"],
  pattern: ["aliases"],
  zone: ["notes"],
  material_part: ["material"],
  material: ["kind", "url", "status"],
  suggested_route: ["status", "source_plan"],
  direction: ["status", "attractor", "stable_while"],
  question: ["text", "created_at", "source"],
  probe: ["status", "source_plan", "body"],
  artifact: ["kind", "path", "observed_at", "summary", "evidence_strength", "probe"],
  encounter: ["date", "target", "depth", "mode", "context"],
  trail_segment: ["date", "direction", "from", "to", "via", "reason", "resulting_questions"],
  personal_trail: ["direction"],
  plan: []
};
const DATED_NODE_FIELDS = {
  artifact: "observed_at",
  encounter: "date",
  question: "created_at",
  trail_segment: "date"
};
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function hasKeys(value, required) {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function isStringArray(value, itemCheck = () => true) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && itemCheck(item));
}
function isUnique(value) {
  return new Set(value).size === value.length;
}
function prefixType(nodeId) {
  if (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)) {
    return null;
  }
  return ID_PREFIXES[nodeId.slice(0, nodeId.indexOf(":"))] || null;
}
function diagnostic(path, rule) {
  return { path, rule };
}
function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value))
    return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day >= 1 && day <= days[month - 1];
}
function validateOptionalNodeProperty(node, key, path) {
  const value = node[key];
  const ref = (prefix) => typeof value === "string" && value.startsWith(prefix) && NODE_ID_RE.test(value);
  switch (key) {
    case "formerly":
      return isStringArray(value, (item) => NODE_ID_RE.test(item));
    case "sensitivity":
      return SENSITIVITY_CLASSES.includes(value);
    case "aliases":
      return isStringArray(value);
    case "notes":
    case "kind":
    case "status":
    case "attractor":
    case "stable_while":
    case "text":
    case "body":
    case "path":
    case "summary":
    case "reason":
      return typeof value === "string";
    case "material":
      return ref("material:");
    case "url": {
      if (value === "")
        return true;
      const safeUrlPattern = new RegExp("^https:" + "\\/\\/" + "[a-z0-9][!-~]*$");
      return typeof value === "string" && safeUrlPattern.test(value);
    }
    case "source_plan":
      return ref("plan:");
    case "created_at":
    case "observed_at":
    case "date":
      return isCalendarDate(value);
    case "source":
      return isPlainObject(value) && hasOnlyKeys(value, ["artifact", "encounter"]) && Object.keys(value).length >= 1 && (!Object.prototype.hasOwnProperty.call(value, "artifact") || typeof value.artifact === "string" && value.artifact.startsWith("artifact:") && NODE_ID_RE.test(value.artifact)) && (!Object.prototype.hasOwnProperty.call(value, "encounter") || typeof value.encounter === "string" && value.encounter.startsWith("encounter:") && NODE_ID_RE.test(value.encounter));
    case "evidence_strength":
      return EVIDENCE_STRENGTHS.includes(value);
    case "probe":
      return ref("probe:");
    case "target":
      return typeof value === "string" && (value.startsWith("material:") || value.startsWith("part:")) && NODE_ID_RE.test(value);
    case "depth":
      return ENCOUNTER_DEPTHS.includes(value);
    case "mode":
      return ENCOUNTER_MODES.includes(value);
    case "context":
      return isPlainObject(value) && hasOnlyKeys(value, ["question", "artifact"]) && Object.keys(value).length >= 1 && (!Object.prototype.hasOwnProperty.call(value, "question") || typeof value.question === "string" && value.question.startsWith("question:") && NODE_ID_RE.test(value.question)) && (!Object.prototype.hasOwnProperty.call(value, "artifact") || typeof value.artifact === "string" && value.artifact.startsWith("artifact:") && NODE_ID_RE.test(value.artifact));
    case "direction":
      return ref("direction:");
    case "from":
      return true;
    case "to":
      return typeof value === "string" && NODE_ID_RE.test(value);
    case "via":
      return isStringArray(value, (item) => NODE_ID_RE.test(item));
    case "resulting_questions":
      return isStringArray(value, (item) => item.startsWith("question:") && NODE_ID_RE.test(item));
    default:
      return false;
  }
}
function validateNode(node, index) {
  const path = "/nodes/" + index;
  if (!isPlainObject(node))
    return diagnostic(path, "type");
  if (!hasOnlyKeys(node, NODE_KEYS))
    return diagnostic(path, "additionalProperties");
  if (!hasKeys(node, ["id", "type", "title", "fields"]))
    return diagnostic(path, "required");
  if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id))
    return diagnostic(path + "/id", "pattern");
  if (!NODE_TYPES.includes(node.type))
    return diagnostic(path + "/type", "enum");
  if (prefixType(node.id) !== node.type)
    return diagnostic(path + "/id", "typePrefix");
  if (typeof node.title !== "string")
    return diagnostic(path + "/title", "type");
  if (!isStringArray(node.fields, (field) => FIELDS.includes(field)) || !isUnique(node.fields))
    return diagnostic(path + "/fields", "fieldSet");
  if (node.type === "concept" && (node.fields.length !== 1 || node.fields[0] !== "knowledge"))
    return diagnostic(path + "/fields", "registryField");
  if ((node.type === "zone" || node.type === "pattern") && (node.fields.length !== 1 || node.fields[0] !== "body"))
    return diagnostic(path + "/fields", "registryField");
  for (const key of Object.keys(node)) {
    if (!NODE_COMMON_KEYS.has(key) && !NODE_PAYLOAD_FIELDS[node.type].includes(key)) {
      return diagnostic(path + "/" + key, "kindProperty");
    }
  }
  for (const key of NODE_KEYS) {
    if (["id", "type", "title", "fields"].includes(key) || !Object.prototype.hasOwnProperty.call(node, key))
      continue;
    if (!validateOptionalNodeProperty(node, key, path + "/" + key))
      return diagnostic(path + "/" + key, "shape");
  }
  const requiredByType = {
    concept: ["aliases"],
    pattern: ["aliases"],
    zone: ["notes"],
    material_part: ["material"],
    material: ["kind", "url", "status"],
    suggested_route: ["status"],
    direction: ["status", "attractor"],
    question: ["text", "created_at", "source"],
    probe: ["status", "body"],
    artifact: ["kind", "path", "observed_at", "summary", "evidence_strength"],
    encounter: ["date", "target", "depth", "mode"],
    trail_segment: ["date", "direction", "to", "via", "reason"],
    personal_trail: ["direction"],
    plan: []
  };
  if (!hasKeys(node, requiredByType[node.type]))
    return diagnostic(path, "kindRequired");
  if (node.type === "material_part") {
    const parentSlug = node.id.slice("part:".length, node.id.indexOf("/"));
    if (node.material !== "material:" + parentSlug)
      return diagnostic(path + "/material", "partParent");
  }
  if (STATUS_FORBIDDEN.has(node.type) && Object.prototype.hasOwnProperty.call(node, "status"))
    return diagnostic(path + "/status", "forbidden");
  if ((node.type === "material" || node.type === "probe" || node.type === "direction") && !LIFECYCLE_STATUSES.includes(node.status))
    return diagnostic(path + "/status", "enum");
  if (node.type === "material" && !MATERIAL_KINDS.includes(node.kind))
    return diagnostic(path + "/kind", "enum");
  if (node.type === "suggested_route" && !ROUTE_STATUSES.includes(node.status))
    return diagnostic(path + "/status", "enum");
  if (node.type === "trail_segment") {
    const conceptRef = (value) => typeof value === "string" && (value.startsWith("concept:") || value.startsWith("pattern:")) && NODE_ID_RE.test(value);
    if (Object.prototype.hasOwnProperty.call(node, "from") && !(conceptRef(node.from) || Array.isArray(node.from) && node.from.every(conceptRef)))
      return diagnostic(path + "/from", "conceptKindRef");
    if (!conceptRef(node.to))
      return diagnostic(path + "/to", "conceptKindRef");
    if (!node.via.every((item) => item.startsWith("artifact:") || item.startsWith("material:") || item.startsWith("part:")))
      return diagnostic(path + "/via", "trailViaRef");
  }
  return null;
}
function validateEdge(edge, index) {
  const path = "/edges/" + index;
  if (!isPlainObject(edge))
    return diagnostic(path, "type");
  if (!hasOnlyKeys(edge, EDGE_KEYS))
    return diagnostic(path, "additionalProperties");
  if (!hasKeys(edge, ["source", "target", "type", "provenance"]))
    return diagnostic(path, "required");
  if (typeof edge.source !== "string" || !NODE_ID_RE.test(edge.source))
    return diagnostic(path + "/source", "nodeId");
  if (typeof edge.target !== "string" || !NODE_ID_RE.test(edge.target))
    return diagnostic(path + "/target", "nodeId");
  if (edge.source === edge.target)
    return diagnostic(path + "/target", "selfEdge");
  if (!EDGE_TYPES.includes(edge.type))
    return diagnostic(path + "/type", "enum");
  if (!isStringArray(edge.provenance, (item) => NODE_ID_RE.test(item)) || edge.provenance.length === 0)
    return diagnostic(path + "/provenance", "nonEmptyNodeIds");
  for (let item = 1;item < edge.provenance.length; item += 1) {
    if (edge.provenance[item - 1] >= edge.provenance[item]) {
      return diagnostic(path + "/provenance", "canonicalSet");
    }
  }
  if (Object.prototype.hasOwnProperty.call(edge, "sensitivity") && !SENSITIVITY_CLASSES.includes(edge.sensitivity))
    return diagnostic(path + "/sensitivity", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "weight") && !EDGE_WEIGHTS.includes(edge.weight))
    return diagnostic(path + "/weight", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "order") && (!Number.isInteger(edge.order) || edge.order < 1))
    return diagnostic(path + "/order", "positiveInteger");
  if (Object.prototype.hasOwnProperty.call(edge, "context") && (typeof edge.context !== "string" || !NODE_ID_RE.test(edge.context)))
    return diagnostic(path + "/context", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "step") && (typeof edge.step !== "string" || !NODE_ID_RE.test(edge.step)))
    return diagnostic(path + "/step", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "confidence") && !CONFIDENCE_VALUES.includes(edge.confidence))
    return diagnostic(path + "/confidence", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "created_by") && typeof edge.created_by !== "string")
    return diagnostic(path + "/created_by", "type");
  if (Object.prototype.hasOwnProperty.call(edge, "created_at") && !isCalendarDate(edge.created_at))
    return diagnostic(path + "/created_at", "date");
  if (Object.prototype.hasOwnProperty.call(edge, "note") && typeof edge.note !== "string")
    return diagnostic(path + "/note", "type");
  if (Object.prototype.hasOwnProperty.call(edge, "alternative_in")) {
    const conceptKindRef = (item) => (item.startsWith("concept:") || item.startsWith("pattern:")) && NODE_ID_RE.test(item);
    if (!isStringArray(edge.alternative_in, conceptKindRef))
      return diagnostic(path + "/alternative_in", "conceptKindRefs");
    for (let item = 1;item < edge.alternative_in.length; item += 1) {
      if (edge.alternative_in[item - 1] >= edge.alternative_in[item]) {
        return diagnostic(path + "/alternative_in", "canonicalSet");
      }
    }
    if (edge.type !== "alternative_to")
      return diagnostic(path + "/alternative_in", "forbidden");
  }
  const routeRole = (edge.type === "primary_for" || edge.type === "supporting_for") && edge.target.startsWith("suggested-route:");
  for (const meta of ["order", "context", "step"]) {
    if (Object.prototype.hasOwnProperty.call(edge, meta) && !(EDGE_DISCRIMINANTS[edge.type] || []).includes(meta) && !(routeRole && meta === "step")) {
      return diagnostic(path + "/" + meta, "forbiddenDiscriminant");
    }
  }
  if (AUTHORED_WEIGHT_TYPES.has(edge.type) && !Object.prototype.hasOwnProperty.call(edge, "weight"))
    return diagnostic(path + "/weight", "required");
  if (DERIVED_WEIGHT_TYPES.has(edge.type) && Object.prototype.hasOwnProperty.call(edge, "weight"))
    return diagnostic(path + "/weight", "forbidden");
  if (edge.type === "step_of_route" && !Object.prototype.hasOwnProperty.call(edge, "order"))
    return diagnostic(path + "/order", "required");
  if (edge.type === "suggested_next" && (!Object.prototype.hasOwnProperty.call(edge, "context") || !edge.context.startsWith("suggested-route:")))
    return diagnostic(path + "/context", "routeContext");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && Object.prototype.hasOwnProperty.call(edge, "step") && !(edge.step.startsWith("concept:") || edge.step.startsWith("pattern:")))
    return diagnostic(path + "/step", "conceptKindRef");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && edge.target.startsWith("suggested-route:") && !Object.prototype.hasOwnProperty.call(edge, "step"))
    return diagnostic(path + "/step", "required");
  const endpoints = ENDPOINT_RULES[edge.type];
  if (!endpoints[0].includes(prefixType(edge.source)))
    return diagnostic(path + "/source", "endpointType");
  if (!endpoints[1].includes(prefixType(edge.target)))
    return diagnostic(path + "/target", "endpointType");
  return null;
}
const CONCEPT_STATE_KEYS = ["exposure", "confidence", "clarity", "coverage", "freshness", "last_seen", "evidence", "decisions", "sensitivity"];
const MATERIAL_STATE_KEYS = ["depth_reached", "last_seen", "freshness", "evidence", "sensitivity"];
const QUESTION_STATE_KEYS = ["status", "evidence", "decisions", "sensitivity"];
const DECISION_REFERENCE_KEYS = ["dimension", "date", "evidence"];
const CONCEPT_GATED_DEFAULTS = {
  confidence: CONFIDENCE_VALUES[0],
  clarity: CLARITY_VALUES[0],
  coverage: COVERAGE_VALUES[0]
};
const QUESTION_GATED_DEFAULTS = { status: QUESTION_STATUSES[0] };
const ARTIFACT_EXPOSURE_RANK = {
  noticed: 1,
  read: 2,
  summarized: 3,
  explained: 3,
  applied: 4,
  reviewed: 4,
  performed: 4,
  drilled: 4
};
function isEvidenceArray(value, prefixes, minimum = 0) {
  return isStringArray(value, (item) => prefixes.some((prefix) => item.startsWith(prefix + ":")) && NODE_ID_RE.test(item)) && value.length >= minimum && isUnique(value);
}
function validateDecisionReferences(value, dimensions, path) {
  if (!Array.isArray(value))
    return diagnostic(path, "type");
  const identities = [];
  const seenDimensions = new Set;
  for (const reference of value) {
    if (!isPlainObject(reference))
      return diagnostic(path, "itemType");
    if (!hasOnlyKeys(reference, DECISION_REFERENCE_KEYS))
      return diagnostic(path, "additionalProperties");
    if (!hasKeys(reference, DECISION_REFERENCE_KEYS))
      return diagnostic(path, "required");
    if (!dimensions.includes(reference.dimension))
      return diagnostic(path, "dimension");
    if (seenDimensions.has(reference.dimension))
      return diagnostic(path, "dimensionUnique");
    seenDimensions.add(reference.dimension);
    if (!isCalendarDate(reference.date))
      return diagnostic(path, "date");
    if (!isEvidenceArray(reference.evidence, ["artifact", "encounter", "question"], 1))
      return diagnostic(path, "evidence");
    identities.push(JSON.stringify([
      reference.dimension,
      reference.date,
      reference.evidence
    ]));
  }
  if (!isUnique(identities))
    return diagnostic(path, "uniqueItems");
  return null;
}
function validateReviewGates(entry, defaults, path) {
  const decided = new Set(entry.decisions.map((reference) => reference.dimension));
  for (const [dimension, defaultValue] of Object.entries(defaults)) {
    if (entry[dimension] !== defaultValue && !decided.has(dimension)) {
      return diagnostic(path + "/decisions", "reviewGate");
    }
  }
  return null;
}
function validateStatusEvidence(entry, nodesById, path) {
  const reference = entry.decisions.find((item) => item.dimension === "status");
  if (!reference)
    return null;
  const prefixes = entry.status === "stale" ? ["artifact"] : ["artifact", "encounter"];
  if (!isEvidenceArray(reference.evidence, prefixes, 1)) {
    return diagnostic(path + "/decisions", "statusEvidence");
  }
  if (entry.status === "stale") {
    const resolved = reference.evidence.filter((ref) => nodesById.has(ref)).map((ref) => nodesById.get(ref));
    if (resolved.length === reference.evidence.length && !resolved.some((node) => node.type === "artifact" && node.kind === "note")) {
      return diagnostic(path + "/decisions", "staleNoteEvidence");
    }
  }
  return null;
}
function validateStateAsOf(entry, asOf, path) {
  const dates = [];
  if (Object.prototype.hasOwnProperty.call(entry, "last_seen")) {
    dates.push(entry.last_seen);
  }
  for (const reference of Array.isArray(entry.decisions) ? entry.decisions : []) {
    dates.push(reference.date);
  }
  if (dates.length === 0)
    return null;
  if (asOf === null)
    return diagnostic("/generated_at", "stateAsOfRequired");
  if (dates.some((date) => date > asOf))
    return diagnostic(path, "stateAfterAsOf");
  return null;
}
function exposureCeiling(evidence, nodesById) {
  let ceiling = 0;
  const explanations = [];
  const reviews = [];
  for (const ref of evidence) {
    const node = nodesById.get(ref);
    if (!node)
      continue;
    if (node.type === "artifact") {
      if (node.evidence_strength === "explained") {
        explanations.push(node.observed_at);
      } else if (node.evidence_strength === "reviewed") {
        reviews.push(node.observed_at);
      }
      ceiling = Math.max(ceiling, ARTIFACT_EXPOSURE_RANK[node.evidence_strength] ?? 0);
    } else if (node.type === "encounter") {
      ceiling = Math.max(ceiling, node.depth === "skim" ? 1 : 2);
    }
  }
  if (explanations.length > 0 && reviews.length > 0 && reviews.some((reviewedOn) => explanations.some((explainedOn) => reviewedOn >= explainedOn))) {
    ceiling = CONCEPT_EXPOSURES.length - 1;
  }
  return ceiling;
}
function depthCeiling(evidence, nodesById) {
  let ceiling = 0;
  for (const ref of evidence) {
    const node = nodesById.get(ref);
    if (node && node.type === "encounter") {
      ceiling = Math.max(ceiling, ENCOUNTER_DEPTHS.indexOf(node.depth));
    }
  }
  return ceiling;
}
function calendarDay(value) {
  const stamp = new Date(0);
  stamp.setUTCHours(0, 0, 0, 0);
  stamp.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.trunc(stamp.getTime() / 86400000);
}
function freshnessOf(lastSeen, asOf) {
  const age = calendarDay(asOf) - calendarDay(lastSeen);
  if (age <= FRESHNESS_DAYS.fresh)
    return "fresh";
  return age <= FRESHNESS_DAYS.aging ? "aging" : "stale";
}
function validateStateProvenance(entry, node, nodesById, path) {
  if (node.type === "concept") {
    const omitsDecisionEvidence = entry.decisions.some((reference) => reference.evidence.some((evidence) => !entry.evidence.includes(evidence)));
    if (omitsDecisionEvidence) {
      return diagnostic(path + "/evidence", "conceptDecisionEvidence");
    }
    if (Object.prototype.hasOwnProperty.call(entry, "last_seen")) {
      const contactDates = entry.evidence.flatMap((reference) => {
        const evidence = nodesById.get(reference);
        if (evidence?.type === "artifact")
          return [evidence.observed_at];
        if (evidence?.type === "encounter")
          return [evidence.date];
        return [];
      });
      if (!contactDates.includes(entry.last_seen)) {
        return diagnostic(path + "/last_seen", "conceptContactDate");
      }
    }
  } else if (node.type === "material" || node.type === "material_part") {
    const encounterDates = entry.evidence.flatMap((reference) => {
      const evidence = nodesById.get(reference);
      return evidence?.type === "encounter" ? [evidence.date] : [];
    });
    if (encounterDates.length !== entry.evidence.length) {
      return diagnostic(path + "/evidence", "emittedEncounter");
    }
    if (entry.last_seen !== encounterDates.reduce((latest, date) => date > latest ? date : latest)) {
      return diagnostic(path + "/last_seen", "materialLastSeen");
    }
  } else if (node.type === "question") {
    const statusReference = entry.decisions.find((reference) => reference.dimension === "status");
    const statusEvidence = statusReference === undefined ? [] : statusReference.evidence;
    if (entry.evidence.length !== statusEvidence.length || entry.evidence.some((reference, index) => reference !== statusEvidence[index])) {
      return diagnostic(path + "/evidence", "statusEvidenceJoin");
    }
  }
  const provenanceReferences = [
    ...entry.evidence,
    ...Array.isArray(entry.decisions) ? entry.decisions.flatMap((reference) => reference.evidence) : []
  ];
  const sources = [
    node,
    ...provenanceReferences.flatMap((reference) => {
      const evidence = nodesById.get(reference);
      return evidence === undefined ? [] : [evidence];
    })
  ];
  const requiredSensitivity = sources.find((source) => SENSITIVITY_CLASSES.includes(source.sensitivity))?.sensitivity;
  if (requiredSensitivity !== undefined && entry.sensitivity !== requiredSensitivity) {
    return diagnostic(path + "/sensitivity", "provenanceSensitivity");
  }
  return null;
}
function validateStateEntry(entry, node, nodesById, asOf) {
  const path = "/state";
  const nodeType = node.type;
  if (!isPlainObject(entry))
    return diagnostic(path, "entryShape");
  if (nodeType === "concept") {
    if (!hasOnlyKeys(entry, CONCEPT_STATE_KEYS))
      return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["exposure", "confidence", "clarity", "coverage", "evidence", "decisions"]))
      return diagnostic(path, "required");
    if (!CONCEPT_EXPOSURES.includes(entry.exposure))
      return diagnostic(path, "exposure");
    if (!CONFIDENCE_VALUES.includes(entry.confidence))
      return diagnostic(path, "confidence");
    if (!CLARITY_VALUES.includes(entry.clarity))
      return diagnostic(path, "clarity");
    if (!COVERAGE_VALUES.includes(entry.coverage))
      return diagnostic(path, "coverage");
    if (!isEvidenceArray(entry.evidence, ["artifact", "encounter", "question"]))
      return diagnostic(path, "evidence");
    if (CONCEPT_EXPOSURES.indexOf(entry.exposure) > exposureCeiling(entry.evidence, nodesById)) {
      return diagnostic(path + "/evidence", "exposureCeiling");
    }
    const decisionFailure = validateDecisionReferences(entry.decisions, ["confidence", "clarity", "coverage"], path);
    if (decisionFailure)
      return decisionFailure;
    const hasLastSeen = Object.prototype.hasOwnProperty.call(entry, "last_seen");
    const hasFreshness = Object.prototype.hasOwnProperty.call(entry, "freshness");
    if (hasLastSeen !== hasFreshness)
      return diagnostic(path, "freshnessPair");
    const hasContact = entry.exposure !== CONCEPT_EXPOSURES[0];
    if (hasLastSeen !== hasContact)
      return diagnostic(path, "contactDates");
    if (hasLastSeen && !isCalendarDate(entry.last_seen))
      return diagnostic(path, "lastSeen");
    if (hasFreshness && !FRESHNESS_VALUES.includes(entry.freshness))
      return diagnostic(path, "freshness");
    const gateFailure = validateReviewGates(entry, CONCEPT_GATED_DEFAULTS, path);
    if (gateFailure)
      return gateFailure;
  } else if (nodeType === "material" || nodeType === "material_part") {
    if (!hasOnlyKeys(entry, MATERIAL_STATE_KEYS))
      return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["depth_reached", "last_seen", "freshness", "evidence"]))
      return diagnostic(path, "required");
    if (!ENCOUNTER_DEPTHS.includes(entry.depth_reached))
      return diagnostic(path, "depth");
    if (!isCalendarDate(entry.last_seen))
      return diagnostic(path, "lastSeen");
    if (!FRESHNESS_VALUES.includes(entry.freshness))
      return diagnostic(path, "freshness");
    if (!isEvidenceArray(entry.evidence, ["encounter"], 1))
      return diagnostic(path, "evidence");
    if (ENCOUNTER_DEPTHS.indexOf(entry.depth_reached) > depthCeiling(entry.evidence, nodesById)) {
      return diagnostic(path + "/evidence", "depthCeiling");
    }
  } else if (nodeType === "question") {
    if (!hasOnlyKeys(entry, QUESTION_STATE_KEYS))
      return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["status", "evidence", "decisions"]))
      return diagnostic(path, "required");
    if (!QUESTION_STATUSES.includes(entry.status))
      return diagnostic(path, "status");
    if (!isEvidenceArray(entry.evidence, ["artifact", "encounter", "question"]))
      return diagnostic(path, "evidence");
    const decisionFailure = validateDecisionReferences(entry.decisions, ["status"], path);
    if (decisionFailure)
      return decisionFailure;
    const statusEvidenceFailure = validateStatusEvidence(entry, nodesById, path);
    if (statusEvidenceFailure)
      return statusEvidenceFailure;
    const gateFailure = validateReviewGates(entry, QUESTION_GATED_DEFAULTS, path);
    if (gateFailure)
      return gateFailure;
  } else {
    return diagnostic(path, "nodeKind");
  }
  if (Object.prototype.hasOwnProperty.call(entry, "sensitivity") && !SENSITIVITY_CLASSES.includes(entry.sensitivity)) {
    return diagnostic(path, "sensitivity");
  }
  const provenanceFailure = validateStateProvenance(entry, node, nodesById, path);
  if (provenanceFailure)
    return provenanceFailure;
  const asOfFailure = validateStateAsOf(entry, asOf, path);
  if (asOfFailure)
    return asOfFailure;
  if (Object.prototype.hasOwnProperty.call(entry, "freshness") && entry.freshness !== freshnessOf(entry.last_seen, asOf)) {
    return diagnostic(path + "/freshness", "derivedFreshness");
  }
  return null;
}
export function hasDuplicateJsonKeys(text) {
  const escapes = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t"
  };
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      let raw = "";
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") {
          const code = text[index + 1];
          if (code === "u") {
            raw += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            raw += escapes[code] ?? code;
            index += 2;
          }
        } else {
          raw += text[index];
          index += 1;
        }
      }
      index += 1;
      const top = stack[stack.length - 1];
      if (top && top.keys && top.expectKey) {
        if (top.keys.has(raw))
          return true;
        top.keys.add(raw);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === "{")
      stack.push({ keys: new Set, expectKey: true });
    else if (ch === "[")
      stack.push({});
    else if (ch === "}" || ch === "]")
      stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.keys)
        top.expectKey = true;
    }
    index += 1;
  }
  return false;
}
function edgeKey(edge) {
  return [
    edge.type,
    edge.source,
    edge.target,
    edge.context ?? "",
    edge.order ?? 0,
    edge.step ?? ""
  ];
}
function compareEdgeKeys(left, right) {
  for (let index = 0;index < left.length; index += 1) {
    if (left[index] < right[index])
      return -1;
    if (left[index] > right[index])
      return 1;
  }
  return 0;
}
function edgeIdentity(edge) {
  return JSON.stringify(edgeKey(edge));
}
export function validateGraph(value) {
  if (!isPlainObject(value))
    return diagnostic("", "type");
  if (value.format !== "atlas-graph" || value.version !== 1)
    return diagnostic("", "envelope");
  if (!hasOnlyKeys(value, ENVELOPE_KEYS))
    return diagnostic("", "additionalProperties");
  if (!hasKeys(value, ["format", "version", "nodes", "edges", "trails", "state", "influence", "frontier", "projections"]))
    return diagnostic("", "required");
  if (Object.prototype.hasOwnProperty.call(value, "generated_at") && (typeof value.generated_at !== "string" || !GENERATED_AT_RE.test(value.generated_at) || !isCalendarDate(value.generated_at.slice(0, 10)))) {
    return diagnostic("/generated_at", "shape");
  }
  const graphAsOf = Object.prototype.hasOwnProperty.call(value, "generated_at") ? value.generated_at.slice(0, 10) : null;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    return diagnostic("", "arrayShape");
  if (!Array.isArray(value.trails) || value.trails.length !== 0)
    return diagnostic("/trails", "producerClosed");
  if (!isPlainObject(value.state))
    return diagnostic("/state", "type");
  for (const entry of Object.values(value.state)) {
    if (!isPlainObject(entry))
      return diagnostic("/state", "entryShape");
  }
  if (!isPlainObject(value.influence) || Object.keys(value.influence).length !== 0)
    return diagnostic("/influence", "producerClosed");
  if (!Array.isArray(value.frontier) || value.frontier.length !== 0)
    return diagnostic("/frontier", "producerClosed");
  if (!isPlainObject(value.projections) || !Object.values(value.projections).every((item) => typeof item === "string" && SLUG_RE.test(item)))
    return diagnostic("/projections", "slugMap");
  for (const key of Object.keys(value.projections)) {
    if (!key.startsWith("zone:") || !NODE_ID_RE.test(key))
      return diagnostic("/projections", "zoneKey");
  }
  if (Object.prototype.hasOwnProperty.call(value, "withheld"))
    return diagnostic("/withheld", "fullGraphNeverWithholds");
  const nodeIds = new Set;
  const nodesById = new Map;
  for (let index = 0;index < value.nodes.length; index += 1) {
    const failure = validateNode(value.nodes[index], index);
    if (failure)
      return failure;
    const datedField = DATED_NODE_FIELDS[value.nodes[index].type];
    if (datedField !== undefined) {
      if (graphAsOf === null)
        return diagnostic("/generated_at", "nodeAsOfRequired");
      if (value.nodes[index][datedField] > graphAsOf) {
        return diagnostic("/nodes/" + index + "/" + datedField, "nodeAfterAsOf");
      }
    }
    if (nodeIds.has(value.nodes[index].id))
      return diagnostic("/nodes/" + index + "/id", "duplicateId");
    nodeIds.add(value.nodes[index].id);
    nodesById.set(value.nodes[index].id, value.nodes[index]);
  }
  for (const [key, entry] of Object.entries(value.state)) {
    const node = nodesById.get(key);
    if (!node)
      return diagnostic("/state", "danglingKey");
    const failure = validateStateEntry(entry, node, nodesById, graphAsOf);
    if (failure)
      return failure;
  }
  for (const node of value.nodes) {
    if ((node.type === "concept" || node.type === "question") && !Object.prototype.hasOwnProperty.call(value.state, node.id)) {
      return diagnostic("/state", "missingDefault");
    }
  }
  for (let index = 0;index < value.nodes.length; index += 1) {
    if (value.nodes[index].type === "zone" && !Object.prototype.hasOwnProperty.call(value.projections, value.nodes[index].id)) {
      return diagnostic("/projections", "zoneWithoutProjection");
    }
  }
  const retiredSeen = new Set;
  for (let index = 0;index < value.nodes.length; index += 1) {
    const node = value.nodes[index];
    if (!Object.prototype.hasOwnProperty.call(node, "formerly"))
      continue;
    if (NO_REDIRECT_KINDS.has(node.type))
      return diagnostic("/nodes/" + index + "/formerly", "noRedirectMachinery");
    for (const oldId of node.formerly) {
      if (prefixType(oldId) !== node.type)
        return diagnostic("/nodes/" + index + "/formerly", "kindChange");
      if (nodeIds.has(oldId))
        return diagnostic("/nodes/" + index + "/formerly", "livingRedirect");
      if (retiredSeen.has(oldId))
        return diagnostic("/nodes/" + index + "/formerly", "duplicateRedirect");
      retiredSeen.add(oldId);
    }
  }
  const identities = new Set;
  const roleConflicts = new Map;
  let previousEdgeKey = null;
  for (let index = 0;index < value.edges.length; index += 1) {
    const failure = validateEdge(value.edges[index], index);
    if (failure)
      return failure;
    const edge = value.edges[index];
    const currentEdgeKey = edgeKey(edge);
    if (previousEdgeKey !== null && compareEdgeKeys(previousEdgeKey, currentEdgeKey) > 0) {
      return diagnostic("/edges/" + index, "canonicalOrder");
    }
    previousEdgeKey = currentEdgeKey;
    if (!nodeIds.has(edge.source))
      return diagnostic("/edges/" + index + "/source", "danglingEndpoint");
    if (!nodeIds.has(edge.target))
      return diagnostic("/edges/" + index + "/target", "danglingEndpoint");
    if (Object.prototype.hasOwnProperty.call(edge, "context") && !nodeIds.has(edge.context))
      return diagnostic("/edges/" + index + "/context", "danglingRef");
    if (Object.prototype.hasOwnProperty.call(edge, "step") && !nodeIds.has(edge.step))
      return diagnostic("/edges/" + index + "/step", "danglingRef");
    for (const ref of edge.alternative_in || []) {
      if (!nodeIds.has(ref))
        return diagnostic("/edges/" + index + "/alternative_in", "danglingRef");
    }
    for (const ref of edge.provenance) {
      if (!nodeIds.has(ref))
        return diagnostic("/edges/" + index + "/provenance", "danglingRef");
    }
    if ((edge.type === "related_to" || edge.type === "alternative_to") && edge.source > edge.target) {
      return diagnostic("/edges/" + index, "canonicalOrder");
    }
    const identity = edgeIdentity(edge);
    if (identities.has(identity))
      return diagnostic("/edges/" + index, "duplicateIdentity");
    identities.add(identity);
    if (edge.type === "primary_for" || edge.type === "supporting_for") {
      const roleKey = JSON.stringify([edge.source, edge.target, edge.step ?? ""]);
      const previous = roleConflicts.get(roleKey);
      if (previous !== undefined && previous !== edge.type) {
        return diagnostic("/edges/" + index, "roleConflict");
      }
      roleConflicts.set(roleKey, edge.type);
    }
  }
  return null;
}
function copyArray(value) {
  return value.map((item) => isPlainObject(item) ? { ...item } : item);
}
function projectNode(node) {
  const projected = { id: node.id, type: node.type, title: node.title, fields: [...node.fields] };
  if (Object.prototype.hasOwnProperty.call(node, "formerly"))
    projected.formerly = [...node.formerly];
  if (Object.prototype.hasOwnProperty.call(node, "sensitivity"))
    projected.sensitivity = node.sensitivity;
  for (const key of NODE_PAYLOAD_FIELDS[node.type]) {
    if (!Object.prototype.hasOwnProperty.call(node, key))
      continue;
    const value = node[key];
    projected[key] = Array.isArray(value) ? copyArray(value) : isPlainObject(value) ? { ...value } : value;
  }
  return projected;
}
function projectStateEntry(entry, node) {
  const projected = {};
  if (node.type === "concept") {
    projected.exposure = entry.exposure;
    projected.confidence = entry.confidence;
    projected.clarity = entry.clarity;
    projected.coverage = entry.coverage;
    if (Object.prototype.hasOwnProperty.call(entry, "last_seen")) {
      projected.last_seen = entry.last_seen;
      projected.freshness = entry.freshness;
    }
  } else if (node.type === "material" || node.type === "material_part") {
    projected.depth_reached = entry.depth_reached;
    projected.last_seen = entry.last_seen;
    projected.freshness = entry.freshness;
  } else if (node.type === "question") {
    projected.status = entry.status;
  }
  projected.decided = Array.isArray(entry.decisions) ? entry.decisions.map((reference) => reference.dimension) : [];
  return projected;
}
function projectEdge(edge) {
  const projected = { source: edge.source, target: edge.target, type: edge.type, provenance: [...edge.provenance] };
  for (const key of ["sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note"]) {
    if (Object.prototype.hasOwnProperty.call(edge, key))
      projected[key] = edge[key];
  }
  if (Object.prototype.hasOwnProperty.call(edge, "alternative_in"))
    projected.alternative_in = [...edge.alternative_in];
  return projected;
}
export function acceptGraphBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > CEILINGS.graph_file_bytes) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "graphFileBytes") };
  }
  const head = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  if (head.length === 3 && head[0] === 239 && head[1] === 187 && head[2] === 191) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "bom") };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "utf8") };
  }
  if (text.includes("\r")) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "crlf") };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "json") };
  }
  if (hasDuplicateJsonKeys(text)) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "duplicateJsonKey") };
  }
  if (!isPlainObject(value) || value.format !== "atlas-graph" || !Number.isInteger(value.version)) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "envelope") };
  }
  if (value.version !== 1)
    return { kind: "UNSUPPORTED_VERSION", version: value.version };
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "arrays") };
  }
  if (value.nodes.length > CEILINGS.graph_nodes || value.edges.length > CEILINGS.graph_edges) {
    return { kind: "REJECTED", diagnostic: diagnostic("", "graphCounts") };
  }
  const failure = validateGraph(value);
  if (failure)
    return { kind: "REJECTED", diagnostic: failure };
  const nodes = value.nodes.map(projectNode);
  const retired = new Map;
  for (const node of nodes) {
    for (const oldId of node.formerly || []) {
      if (!retired.has(oldId))
        retired.set(oldId, node.id);
    }
  }
  const sourceById = new Map(value.nodes.map((node) => [node.id, node]));
  const state = {};
  for (const [key, entry] of Object.entries(value.state)) {
    state[key] = projectStateEntry(entry, sourceById.get(key));
  }
  return {
    kind: "ACCEPTED",
    graph: {
      format: "atlas-graph",
      version: 1,
      generated_at: value.generated_at,
      nodes,
      edges: value.edges.map(projectEdge),
      trails: [],
      state,
      influence: {},
      frontier: [],
      projections: { ...value.projections }
    },
    retired
  };
}
export function parseFragment(rawFragment) {
  if (typeof rawFragment !== "string" || TEXT_ENCODER.encode(rawFragment).byteLength > CEILINGS.fragment_raw_bytes) {
    return { kind: "BAD_ADDRESS" };
  }
  const known = {};
  const entries = [];
  for (const segment of rawFragment.split("&")) {
    if (segment === "")
      continue;
    const separator = segment.indexOf("=");
    const rawKey = separator < 0 ? segment : segment.slice(0, separator);
    const rawValue = separator < 0 ? "" : segment.slice(separator + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch (_error) {
      return { kind: "BAD_ADDRESS" };
    }
    if (TEXT_ENCODER.encode(value).byteLength > CEILINGS.parameter_decoded_bytes) {
      return { kind: "BAD_ADDRESS" };
    }
    entries.push({ key, value });
    if (!KNOWN_FRAGMENT_KEYS.has(key))
      continue;
    if (Object.prototype.hasOwnProperty.call(known, key))
      return { kind: "BAD_ADDRESS" };
    known[key] = value;
  }
  const mode = Object.prototype.hasOwnProperty.call(known, "mode") ? known.mode : "field";
  let field = known.field;
  if (mode === "field" && !Object.prototype.hasOwnProperty.call(known, "focus") && !Object.prototype.hasOwnProperty.call(known, "field")) {
    field = DEFAULT_FIELD;
  }
  return { kind: "ADDRESS", mode, focus: known.focus, field, entries };
}
