// Atlas viewer input contract. This module is deliberately DOM-free.

// §25.8 viewer acceptance ceilings (Decision Log 2026-07-21): measured-floor
// values — 10k corpus measured 7,294,150 B / 10,000 nodes / 19,479 edges;
// longest legitimate fragment 74 B raw, longest parameter value 40 B decoded.
export const CEILINGS = {
  "graph_file_bytes": 67108864,
  "graph_nodes": 131072,
  "graph_edges": 262144,
  "fragment_raw_bytes": 1024,
  "parameter_decoded_bytes": 512
};

// Canonical JSON blocks below transcribe the closed atlas-graph schema sets.
export const ENVELOPE_KEYS = ["format", "version", "generated_at", "nodes", "edges", "trails", "state", "influence", "frontier", "projections", "withheld"];
export const NODE_KEYS = ["id", "type", "title", "fields", "formerly", "sensitivity", "aliases", "notes", "material", "kind", "url", "status", "source_plan", "attractor", "text", "created_at", "source", "body", "path", "observed_at", "summary", "evidence_strength", "probe", "date", "target", "depth", "mode", "context", "direction", "from", "to", "via", "reason", "resulting_questions"];
export const EDGE_KEYS = ["source", "target", "type", "provenance", "sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note"];
export const NODE_TYPES = ["plan", "concept", "material", "material_part", "direction", "suggested_route", "personal_trail", "trail_segment", "artifact", "encounter", "question", "probe", "zone", "pattern"];
export const EDGE_TYPES = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "explains", "demonstrates", "critiques", "mentions", "loads", "has_part", "overall_concept", "supports", "part_of_direction", "step_of_route", "suggested_next", "visited", "moved_to", "via", "pulled_by", "produced_artifact", "updates_state", "influences", "probed_by", "primary_for", "supporting_for"];
export const AUTHORED_ROLES = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "explains", "demonstrates", "critiques", "mentions", "loads"];
export const FIELDS = ["knowledge", "body"];
export const ID_PREFIXES = {"concept": "concept", "material": "material", "part": "material_part", "direction": "direction", "suggested-route": "suggested_route", "trail-segment": "trail_segment", "personal-trail": "personal_trail", "artifact": "artifact", "encounter": "encounter", "question": "question", "probe": "probe", "plan": "plan", "zone": "zone", "pattern": "pattern"};
export const MATERIAL_KINDS = ["article", "docs", "paper", "book", "repo", "video", "course", "spec", "tutorial", "internal"];
export const EVIDENCE_STRENGTHS = ["noticed", "read", "summarized", "applied", "explained", "reviewed", "performed", "drilled"];
export const ENCOUNTER_DEPTHS = ["skim", "read", "summarized", "applied", "taught"];
export const ENCOUNTER_MODES = ["plan-driven", "question-driven", "artifact-driven", "background"];
export const SENSITIVITY_CLASSES = ["medical"];
export const EDGE_WEIGHTS = ["low", "medium", "high", "unassessed"];
export const CONFIDENCE_VALUES = ["unknown", "low", "medium", "high"];
export const LIFECYCLE_STATUSES = ["active", "archived"];
export const ROUTE_STATUSES = ["available", "hidden", "partially_followed", "ignored", "archived"];
export const ENDPOINT_RULES = {"related_to": [["concept", "pattern"], ["concept", "pattern"]], "prerequisite_of": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "extends": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "implements": [["material_part"], ["concept", "pattern"]], "contradicts": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "explains": [["material_part"], ["concept", "pattern"]], "demonstrates": [["material_part"], ["concept", "pattern"]], "critiques": [["material_part"], ["concept", "pattern"]], "mentions": [["material_part"], ["concept", "pattern"]], "loads": [["pattern"], ["zone"]], "supports": [["material", "material_part"], ["material", "material_part"]], "has_part": [["material"], ["material_part"]], "overall_concept": [["material"], ["concept", "pattern"]], "part_of_direction": [["concept", "pattern"], ["direction"]], "step_of_route": [["concept", "pattern"], ["suggested_route"]], "suggested_next": [["concept", "pattern"], ["concept", "pattern"]], "probed_by": [["concept", "pattern", "zone"], ["probe"]], "pulled_by": [["concept", "pattern", "zone"], ["question"]], "visited": [["encounter"], ["material", "material_part"]], "influences": [["artifact"], ["concept", "pattern", "zone"]], "updates_state": [["artifact"], ["concept", "pattern", "zone"]], "moved_to": [["concept", "pattern"], ["concept", "pattern"]], "via": [["trail_segment"], ["material", "material_part"]], "produced_artifact": [["trail_segment"], ["artifact"]], "primary_for": [["material", "material_part"], ["suggested_route", "question", "trail_segment"]], "supporting_for": [["material", "material_part"], ["suggested_route", "question", "trail_segment"]]};

export const MODES = ["field", "material", "route", "trail", "influence", "state", "frontier", "question"];
export const DEFAULT_FIELD = FIELDS[0];
export const RENDER_NODE_LINK_CEILING = 2400;

const TEXT_ENCODER = new TextEncoder();
const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SLUG_RE = new RegExp("^" + SLUG_SOURCE + "$");
const NODE_ID_RE = new RegExp("^(?:(?:plan|concept|material|direction|suggested-route|personal-trail|trail-segment|artifact|encounter|question|probe|zone|pattern):" + SLUG_SOURCE + "|part:" + SLUG_SOURCE + "/" + SLUG_SOURCE + ")$");
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const GENERATED_AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;
const KNOWN_FRAGMENT_KEYS = new Set(["mode", "focus", "field"]);
const AUTHORED_WEIGHT_TYPES = new Set([...AUTHORED_ROLES, "supports"]);
const DERIVED_WEIGHT_TYPES = new Set(EDGE_TYPES.filter((type) => !AUTHORED_WEIGHT_TYPES.has(type)));
const STATUS_FORBIDDEN = new Set(["concept", "pattern", "zone", "material_part", "personal_trail", "trail_segment", "artifact", "encounter", "question", "plan"]);

const NODE_PAYLOAD_FIELDS = {
  "concept": ["aliases"],
  "pattern": ["aliases"],
  "zone": ["notes"],
  "material_part": ["material"],
  "material": ["kind", "url", "status"],
  "suggested_route": ["status", "source_plan"],
  "direction": ["status", "attractor"],
  "question": ["text", "created_at", "source"],
  "probe": ["status", "source_plan", "body"],
  "artifact": ["kind", "path", "observed_at", "summary", "evidence_strength", "probe"],
  "encounter": ["date", "target", "depth", "mode", "context"],
  "trail_segment": ["date", "direction", "from", "to", "via", "reason", "resulting_questions"],
  "personal_trail": ["direction"],
  "plan": []
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
  return {path, rule};
}

function validateOptionalNodeProperty(node, key, path) {
  const value = node[key];
  const ref = (prefix) => typeof value === "string" && value.startsWith(prefix) && NODE_ID_RE.test(value);
  switch (key) {
    case "formerly": return isStringArray(value, (item) => NODE_ID_RE.test(item));
    case "sensitivity": return SENSITIVITY_CLASSES.includes(value);
    case "aliases": return isStringArray(value);
    case "notes": case "kind": case "status": case "attractor": case "text":
    case "body": case "path": case "summary": case "reason": return typeof value === "string";
    case "material": return ref("material:");
    case "url": {
      if (value === "") return true;
      const safeUrlPattern = new RegExp("^https:" + "\\/\\/" + "[a-z0-9][!-~]*$");
      return typeof value === "string" && safeUrlPattern.test(value);
    }
    case "source_plan": return ref("plan:");
    case "created_at": case "observed_at": case "date": return typeof value === "string" && DATE_RE.test(value);
    case "source":
      return isPlainObject(value) && hasOnlyKeys(value, ["artifact", "encounter"]) && Object.keys(value).length >= 1
        && (!Object.prototype.hasOwnProperty.call(value, "artifact") || (typeof value.artifact === "string" && value.artifact.startsWith("artifact:") && NODE_ID_RE.test(value.artifact)))
        && (!Object.prototype.hasOwnProperty.call(value, "encounter") || (typeof value.encounter === "string" && value.encounter.startsWith("encounter:") && NODE_ID_RE.test(value.encounter)));
    case "evidence_strength": return EVIDENCE_STRENGTHS.includes(value);
    case "probe": return ref("probe:");
    case "target": return typeof value === "string" && (value.startsWith("material:") || value.startsWith("part:")) && NODE_ID_RE.test(value);
    case "depth": return ENCOUNTER_DEPTHS.includes(value);
    case "mode": return ENCOUNTER_MODES.includes(value);
    case "context":
      return isPlainObject(value) && hasOnlyKeys(value, ["question", "artifact"]) && Object.keys(value).length >= 1
        && (!Object.prototype.hasOwnProperty.call(value, "question") || (typeof value.question === "string" && value.question.startsWith("question:") && NODE_ID_RE.test(value.question)))
        && (!Object.prototype.hasOwnProperty.call(value, "artifact") || (typeof value.artifact === "string" && value.artifact.startsWith("artifact:") && NODE_ID_RE.test(value.artifact)));
    case "direction": return ref("direction:");
    case "from": return true;
    case "to": return typeof value === "string" && NODE_ID_RE.test(value);
    case "via": return isStringArray(value, (item) => NODE_ID_RE.test(item));
    case "resulting_questions": return isStringArray(value, (item) => item.startsWith("question:") && NODE_ID_RE.test(item));
    default:
      return false;
  }
}

function validateNode(node, index) {
  const path = "/nodes/" + index;
  if (!isPlainObject(node)) return diagnostic(path, "type");
  if (!hasOnlyKeys(node, NODE_KEYS)) return diagnostic(path, "additionalProperties");
  if (!hasKeys(node, ["id", "type", "title", "fields"])) return diagnostic(path, "required");
  if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id)) return diagnostic(path + "/id", "pattern");
  if (!NODE_TYPES.includes(node.type)) return diagnostic(path + "/type", "enum");
  if (prefixType(node.id) !== node.type) return diagnostic(path + "/id", "typePrefix");
  if (typeof node.title !== "string") return diagnostic(path + "/title", "type");
  if (!isStringArray(node.fields, (field) => FIELDS.includes(field)) || !isUnique(node.fields)) return diagnostic(path + "/fields", "fieldSet");
  if (node.type === "concept" && (node.fields.length !== 1 || node.fields[0] !== "knowledge")) return diagnostic(path + "/fields", "registryField");
  if ((node.type === "zone" || node.type === "pattern") && (node.fields.length !== 1 || node.fields[0] !== "body")) return diagnostic(path + "/fields", "registryField");

  for (const key of NODE_KEYS) {
    if (["id", "type", "title", "fields"].includes(key) || !Object.prototype.hasOwnProperty.call(node, key)) continue;
    if (!validateOptionalNodeProperty(node, key, path + "/" + key)) return diagnostic(path + "/" + key, "shape");
  }

  const requiredByType = {
    "concept": ["aliases"], "pattern": ["aliases"], "zone": ["notes"],
    "material_part": ["material"], "material": ["kind", "url", "status"],
    "suggested_route": ["status"], "direction": ["status", "attractor"],
    "question": ["text", "created_at", "source"], "probe": ["status", "body"],
    "artifact": ["kind", "path", "observed_at", "summary", "evidence_strength"],
    "encounter": ["date", "target", "depth", "mode"],
    "trail_segment": ["date", "direction", "to", "via", "reason"],
    "personal_trail": ["direction"], "plan": []
  };
  if (!hasKeys(node, requiredByType[node.type])) return diagnostic(path, "kindRequired");
  if (STATUS_FORBIDDEN.has(node.type) && Object.prototype.hasOwnProperty.call(node, "status")) return diagnostic(path + "/status", "forbidden");
  if ((node.type === "material" || node.type === "probe" || node.type === "direction") && !LIFECYCLE_STATUSES.includes(node.status)) return diagnostic(path + "/status", "enum");
  if (node.type === "material" && !MATERIAL_KINDS.includes(node.kind)) return diagnostic(path + "/kind", "enum");
  if (node.type === "suggested_route" && !ROUTE_STATUSES.includes(node.status)) return diagnostic(path + "/status", "enum");
  if (node.type === "trail_segment") {
    const conceptRef = (value) => typeof value === "string" && (value.startsWith("concept:") || value.startsWith("pattern:")) && NODE_ID_RE.test(value);
    if (Object.prototype.hasOwnProperty.call(node, "from") && !(conceptRef(node.from) || (Array.isArray(node.from) && node.from.every(conceptRef)))) return diagnostic(path + "/from", "conceptKindRef");
    if (!conceptRef(node.to)) return diagnostic(path + "/to", "conceptKindRef");
    if (!node.via.every((item) => item.startsWith("artifact:") || item.startsWith("material:") || item.startsWith("part:"))) return diagnostic(path + "/via", "trailViaRef");
  }
  return null;
}

function validateEdge(edge, index) {
  const path = "/edges/" + index;
  if (!isPlainObject(edge)) return diagnostic(path, "type");
  if (!hasOnlyKeys(edge, EDGE_KEYS)) return diagnostic(path, "additionalProperties");
  if (!hasKeys(edge, ["source", "target", "type", "provenance"])) return diagnostic(path, "required");
  if (typeof edge.source !== "string" || !NODE_ID_RE.test(edge.source)) return diagnostic(path + "/source", "nodeId");
  if (typeof edge.target !== "string" || !NODE_ID_RE.test(edge.target)) return diagnostic(path + "/target", "nodeId");
  if (!EDGE_TYPES.includes(edge.type)) return diagnostic(path + "/type", "enum");
  if (!isStringArray(edge.provenance, (item) => NODE_ID_RE.test(item)) || edge.provenance.length === 0) return diagnostic(path + "/provenance", "nonEmptyNodeIds");
  if (Object.prototype.hasOwnProperty.call(edge, "sensitivity") && !SENSITIVITY_CLASSES.includes(edge.sensitivity)) return diagnostic(path + "/sensitivity", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "weight") && !EDGE_WEIGHTS.includes(edge.weight)) return diagnostic(path + "/weight", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "order") && (!Number.isInteger(edge.order) || edge.order < 1)) return diagnostic(path + "/order", "positiveInteger");
  if (Object.prototype.hasOwnProperty.call(edge, "context") && (typeof edge.context !== "string" || !NODE_ID_RE.test(edge.context))) return diagnostic(path + "/context", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "step") && (typeof edge.step !== "string" || !NODE_ID_RE.test(edge.step))) return diagnostic(path + "/step", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "confidence") && !CONFIDENCE_VALUES.includes(edge.confidence)) return diagnostic(path + "/confidence", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "created_by") && typeof edge.created_by !== "string") return diagnostic(path + "/created_by", "type");
  if (Object.prototype.hasOwnProperty.call(edge, "created_at") && (typeof edge.created_at !== "string" || !DATE_RE.test(edge.created_at))) return diagnostic(path + "/created_at", "date");
  if (Object.prototype.hasOwnProperty.call(edge, "note") && typeof edge.note !== "string") return diagnostic(path + "/note", "type");
  if (AUTHORED_WEIGHT_TYPES.has(edge.type) && !Object.prototype.hasOwnProperty.call(edge, "weight")) return diagnostic(path + "/weight", "required");
  if (DERIVED_WEIGHT_TYPES.has(edge.type) && Object.prototype.hasOwnProperty.call(edge, "weight")) return diagnostic(path + "/weight", "forbidden");
  if (edge.type === "step_of_route" && !Object.prototype.hasOwnProperty.call(edge, "order")) return diagnostic(path + "/order", "required");
  if (edge.type === "suggested_next" && (!Object.prototype.hasOwnProperty.call(edge, "context") || !edge.context.startsWith("suggested-route:"))) return diagnostic(path + "/context", "routeContext");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && Object.prototype.hasOwnProperty.call(edge, "step") && !(edge.step.startsWith("concept:") || edge.step.startsWith("pattern:"))) return diagnostic(path + "/step", "conceptKindRef");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && edge.target.startsWith("suggested-route:") && !Object.prototype.hasOwnProperty.call(edge, "step")) return diagnostic(path + "/step", "required");
  const endpoints = ENDPOINT_RULES[edge.type];
  if (!endpoints[0].includes(prefixType(edge.source))) return diagnostic(path + "/source", "endpointType");
  if (!endpoints[1].includes(prefixType(edge.target))) return diagnostic(path + "/target", "endpointType");
  return null;
}

function validateWithheld(value) {
  const keys = ["nodes", "edges", "trails", "state", "influence", "frontier", "projections"];
  return isPlainObject(value) && hasOnlyKeys(value, keys) && hasKeys(value, keys)
    && keys.every((key) => Number.isInteger(value[key]) && value[key] >= 0);
}

// §16.5 fail-closed parity with the other Atlas readers (§25.7): native
// JSON.parse keeps the last of duplicate keys, so an ambiguous file could
// pass validation after silently overwriting a field. Scan the raw text for
// duplicate keys within one object before parsing; the builder never emits
// them, so any hit is a malformed file.
export function hasDuplicateJsonKeys(text) {
  const escapes = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
    "n": "\n", "r": "\r", "t": "\t"};
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
      index += 1; // past the closing quote
      const top = stack[stack.length - 1];
      if (top && top.keys && top.expectKey) {
        if (top.keys.has(raw)) return true;
        top.keys.add(raw);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === "{") stack.push({keys: new Set(), expectKey: true});
    else if (ch === "[") stack.push({});
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.keys) top.expectKey = true;
    }
    index += 1;
  }
  return false;
}

function edgeIdentity(edge) {
  return JSON.stringify([edge.type, edge.source, edge.target,
    edge.context ?? "", edge.order ?? 0, edge.step ?? ""]);
}

export function validateGraph(value) {
  if (!isPlainObject(value)) return diagnostic("", "type");
  if (value.format !== "atlas-graph" || value.version !== 1) return diagnostic("", "envelope");
  if (!hasOnlyKeys(value, ENVELOPE_KEYS)) return diagnostic("", "additionalProperties");
  if (!hasKeys(value, ["format", "version", "nodes", "edges", "trails", "state", "influence", "frontier", "projections"])) return diagnostic("", "required");
  if (Object.prototype.hasOwnProperty.call(value, "generated_at") && (typeof value.generated_at !== "string" || !GENERATED_AT_RE.test(value.generated_at))) return diagnostic("/generated_at", "shape");
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return diagnostic("", "arrayShape");
  if (!Array.isArray(value.trails) || value.trails.length !== 0) return diagnostic("/trails", "producerClosed");
  if (!isPlainObject(value.state) || Object.keys(value.state).length !== 0) return diagnostic("/state", "producerClosed");
  if (!isPlainObject(value.influence) || Object.keys(value.influence).length !== 0) return diagnostic("/influence", "producerClosed");
  if (!Array.isArray(value.frontier) || value.frontier.length !== 0) return diagnostic("/frontier", "producerClosed");
  if (!isPlainObject(value.projections) || !Object.values(value.projections).every((item) => typeof item === "string" && SLUG_RE.test(item))) return diagnostic("/projections", "slugMap");
  if (Object.prototype.hasOwnProperty.call(value, "withheld") && !validateWithheld(value.withheld)) return diagnostic("/withheld", "shape");
  const nodeIds = new Set();
  for (let index = 0; index < value.nodes.length; index += 1) {
    const failure = validateNode(value.nodes[index], index);
    if (failure) return failure;
    // One id, one node (§10.1): the builder errors on duplicates, so a
    // repeated id is a malformed file — focus and details must never
    // resolve ambiguously (§16.5).
    if (nodeIds.has(value.nodes[index].id)) return diagnostic("/nodes/" + index + "/id", "duplicateId");
    nodeIds.add(value.nodes[index].id);
  }
  // §34.4 over the whole file: a formerly entry that is itself a living id,
  // or one retired id redirecting to two survivors, is unrepresentable in a
  // builder emission — reject rather than resolve focus= wrong.
  const retiredSeen = new Set();
  for (let index = 0; index < value.nodes.length; index += 1) {
    for (const oldId of value.nodes[index].formerly || []) {
      if (nodeIds.has(oldId)) return diagnostic("/nodes/" + index + "/formerly", "livingRedirect");
      if (retiredSeen.has(oldId)) return diagnostic("/nodes/" + index + "/formerly", "duplicateRedirect");
      retiredSeen.add(oldId);
    }
  }
  const identities = new Set();
  for (let index = 0; index < value.edges.length; index += 1) {
    const failure = validateEdge(value.edges[index], index);
    if (failure) return failure;
    const edge = value.edges[index];
    // The builder never emits an edge resting on an absent node: endpoints
    // are filtered (§20 step 11), provenance is the direct derivation basis
    // (§10.3), context/step are identity discriminants naming live nodes —
    // any dangling ref is a malformed file, a generic rejection, never a
    // silently thinner render (§16.5 no-partial-render).
    if (!nodeIds.has(edge.source)) return diagnostic("/edges/" + index + "/source", "danglingEndpoint");
    if (!nodeIds.has(edge.target)) return diagnostic("/edges/" + index + "/target", "danglingEndpoint");
    if (Object.prototype.hasOwnProperty.call(edge, "context") && !nodeIds.has(edge.context)) return diagnostic("/edges/" + index + "/context", "danglingRef");
    if (Object.prototype.hasOwnProperty.call(edge, "step") && !nodeIds.has(edge.step)) return diagnostic("/edges/" + index + "/step", "danglingRef");
    for (const ref of edge.provenance) {
      if (!nodeIds.has(ref)) return diagnostic("/edges/" + index + "/provenance", "danglingRef");
    }
    // §20.3: one identity emits one edge — duplicates are malformed.
    const identity = edgeIdentity(edge);
    if (identities.has(identity)) return diagnostic("/edges/" + index, "duplicateIdentity");
    identities.add(identity);
  }
  return null;
}

function copyArray(value) {
  return value.map((item) => isPlainObject(item) ? {...item} : item);
}

function projectNode(node) {
  const projected = {id: node.id, type: node.type, title: node.title, fields: [...node.fields]};
  if (Object.prototype.hasOwnProperty.call(node, "formerly")) projected.formerly = [...node.formerly];
  if (Object.prototype.hasOwnProperty.call(node, "sensitivity")) projected.sensitivity = node.sensitivity;
  for (const key of NODE_PAYLOAD_FIELDS[node.type]) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const value = node[key];
    projected[key] = Array.isArray(value) ? copyArray(value) : (isPlainObject(value) ? {...value} : value);
  }
  return projected;
}

function projectEdge(edge) {
  const projected = {source: edge.source, target: edge.target, type: edge.type, provenance: [...edge.provenance]};
  for (const key of ["sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note"]) {
    if (Object.prototype.hasOwnProperty.call(edge, key)) projected[key] = edge[key];
  }
  return projected;
}

export function acceptGraphBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > CEILINGS.graph_file_bytes) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "graphFileBytes")};
  }
  let text;
  try {
    text = new TextDecoder("utf-8", {fatal: true}).decode(buffer);
  } catch (_error) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "utf8")};
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "json")};
  }
  if (hasDuplicateJsonKeys(text)) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "duplicateJsonKey")};
  }
  if (!isPlainObject(value) || value.format !== "atlas-graph" || !Number.isInteger(value.version)) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "envelope")};
  }
  if (value.version !== 1) return {kind: "UNSUPPORTED_VERSION", version: value.version};
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "arrays")};
  }
  if (value.nodes.length > CEILINGS.graph_nodes || value.edges.length > CEILINGS.graph_edges) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "graphCounts")};
  }
  const failure = validateGraph(value);
  if (failure) return {kind: "REJECTED", diagnostic: failure};
  const nodes = value.nodes.map(projectNode);
  const retired = new Map();
  for (const node of nodes) {
    for (const oldId of node.formerly || []) {
      if (!retired.has(oldId)) retired.set(oldId, node.id);
    }
  }
  return {
    kind: "ACCEPTED",
    graph: {
      format: "atlas-graph", version: 1,
      generated_at: value.generated_at,
      nodes,
      edges: value.edges.map(projectEdge),
      trails: [], state: {}, influence: {}, frontier: [],
      projections: {...value.projections},
      withheld: value.withheld ? {...value.withheld} : undefined
    },
    retired
  };
}

export function parseFragment(rawFragment) {
  if (typeof rawFragment !== "string" || TEXT_ENCODER.encode(rawFragment).byteLength > CEILINGS.fragment_raw_bytes) {
    return {kind: "BAD_ADDRESS"};
  }
  const known = {};
  const entries = [];
  for (const segment of rawFragment.split("&")) {
    if (segment === "") continue;
    const separator = segment.indexOf("=");
    const rawKey = separator < 0 ? segment : segment.slice(0, separator);
    const rawValue = separator < 0 ? "" : segment.slice(separator + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch (_error) {
      return {kind: "BAD_ADDRESS"};
    }
    if (TEXT_ENCODER.encode(value).byteLength > CEILINGS.parameter_decoded_bytes) {
      return {kind: "BAD_ADDRESS"};
    }
    entries.push({key, value});
    // §16.4 forward compatibility: an unknown key of any shape is ignored;
    // only its decoded-value ceiling above bounds the work it can cost.
    if (!KNOWN_FRAGMENT_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(known, key)) return {kind: "BAD_ADDRESS"};
    known[key] = value;
  }
  const mode = Object.prototype.hasOwnProperty.call(known, "mode") ? known.mode : "field";
  let field = known.field;
  if (mode === "field" && !Object.prototype.hasOwnProperty.call(known, "focus") && !Object.prototype.hasOwnProperty.call(known, "field")) {
    field = DEFAULT_FIELD;
  }
  return {kind: "ADDRESS", mode, focus: known.focus, field, entries};
}
