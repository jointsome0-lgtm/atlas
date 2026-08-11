// Atlas viewer input contract. This module is deliberately DOM-free.

type KeysOfUnion<Shape> = Shape extends unknown ? keyof Shape : never;
type Absent<Shape, Vocabulary extends string> = Shape & {
  [Key in Exclude<Vocabulary, keyof Shape>]?: undefined;
};

export type NodeId = string;
export type CalendarDate = string;
export type GeneratedAt = string;
export type Slug = string;
export type SafeExternalUrl = string;

export type NodeType =
  | "plan" | "concept" | "material" | "material_part" | "direction"
  | "suggested_route" | "personal_trail" | "trail_segment" | "artifact"
  | "encounter" | "question" | "probe" | "zone" | "pattern";
export type EdgeType =
  | "related_to" | "prerequisite_of" | "extends" | "implements"
  | "contradicts" | "alternative_to" | "explains" | "demonstrates"
  | "critiques" | "mentions" | "loads" | "has_part" | "overall_concept"
  | "supports" | "part_of_direction" | "step_of_route" | "suggested_next"
  | "visited" | "moved_to" | "via" | "pulled_by" | "produced_artifact"
  | "updates_state" | "influences" | "probed_by" | "primary_for"
  | "supporting_for";
export type AuthoredRole = Extract<
  EdgeType,
  | "related_to" | "prerequisite_of" | "extends" | "implements"
  | "contradicts" | "alternative_to" | "explains" | "demonstrates"
  | "critiques" | "mentions" | "loads"
>;
export type Field = "knowledge" | "body";
export type IdPrefix =
  | "concept" | "material" | "part" | "direction" | "suggested-route"
  | "trail-segment" | "personal-trail" | "artifact" | "encounter"
  | "question" | "probe" | "plan" | "zone" | "pattern";
export type MaterialKind =
  | "article" | "docs" | "paper" | "book" | "repo" | "video" | "course"
  | "spec" | "tutorial" | "internal";
export type EvidenceStrength =
  | "noticed" | "read" | "summarized" | "applied" | "explained" | "reviewed"
  | "performed" | "drilled";
export type EncounterDepth =
  "skim" | "read" | "summarized" | "applied" | "taught";
export type EncounterMode =
  "plan-driven" | "question-driven" | "artifact-driven" | "background";
export type SensitivityClass = "medical";
export type EdgeWeight = "low" | "medium" | "high" | "unassessed";
export type ConfidenceValue = "unknown" | "low" | "medium" | "high";
export type ConceptExposure =
  "unseen" | "touched" | "read" | "summarized" | "applied" | "taught";
export type ClarityValue = "vague" | "rough" | "stable" | "disputed";
export type CoverageValue = "none" | "partial" | "broad";
export type FreshnessValue = "fresh" | "aging" | "stale";
export type QuestionStatus = "open" | "clarified" | "resolved" | "stale";
export type LifecycleStatus = "active" | "archived";
export type RouteStatus =
  "available" | "hidden" | "partially_followed" | "ignored" | "archived";
export type ViewerMode =
  | "field" | "material" | "route" | "trail" | "influence" | "state"
  | "frontier" | "question";

export type Ceilings = {
  graph_file_bytes: number;
  graph_nodes: number;
  graph_edges: number;
  fragment_raw_bytes: number;
  parameter_decoded_bytes: number;
};
export type FreshnessBoundaries = {fresh: number; aging: number};
export type EndpointRule = readonly [readonly NodeType[], readonly NodeType[]];
export type Diagnostic = {path: string; rule: string};

export type NodeCommon = {
  id: NodeId;
  type: NodeType;
  title: string;
  fields: readonly Field[];
  formerly?: readonly NodeId[];
  sensitivity?: SensitivityClass;
};
export type QuestionSource = {artifact?: NodeId; encounter?: NodeId};
export type EncounterContext = {question?: NodeId; artifact?: NodeId};
export type PlanNode = NodeCommon & {type: "plan"};
export type ConceptNode = NodeCommon & {
  type: "concept";
  aliases: readonly string[];
};
export type PatternNode = NodeCommon & {
  type: "pattern";
  aliases: readonly string[];
};
export type ZoneNode = NodeCommon & {type: "zone"; notes: string};
export type MaterialNode = NodeCommon & {
  type: "material";
  kind: MaterialKind;
  url: SafeExternalUrl;
  status: LifecycleStatus;
};
export type MaterialPartNode = NodeCommon & {
  type: "material_part";
  material: NodeId;
};
export type DirectionNode = NodeCommon & {
  type: "direction";
  status: LifecycleStatus;
  attractor: string;
  stable_while?: string;
};
export type SuggestedRouteNode = NodeCommon & {
  type: "suggested_route";
  status: RouteStatus;
  source_plan?: NodeId;
};
export type QuestionNode = NodeCommon & {
  type: "question";
  text: string;
  created_at: CalendarDate;
  source: QuestionSource;
};
export type ProbeNode = NodeCommon & {
  type: "probe";
  status: LifecycleStatus;
  body: string;
  source_plan?: NodeId;
};
export type ArtifactNode = NodeCommon & {
  type: "artifact";
  kind: string;
  path: string;
  observed_at: CalendarDate;
  summary: string;
  evidence_strength: EvidenceStrength;
  probe?: NodeId;
};
export type EncounterNode = NodeCommon & {
  type: "encounter";
  date: CalendarDate;
  target: NodeId;
  depth: EncounterDepth;
  mode: EncounterMode;
  context?: EncounterContext;
};
export type TrailSegmentNode = NodeCommon & {
  type: "trail_segment";
  date: CalendarDate;
  direction: NodeId;
  from?: NodeId | readonly NodeId[];
  to: NodeId;
  via: readonly NodeId[];
  reason: string;
  resulting_questions?: readonly NodeId[];
};
export type PersonalTrailNode = NodeCommon & {
  type: "personal_trail";
  direction: NodeId;
};
export type AtlasNode =
  | PlanNode | ConceptNode | PatternNode | ZoneNode | MaterialNode
  | MaterialPartNode | DirectionNode | SuggestedRouteNode | QuestionNode
  | ProbeNode | ArtifactNode | EncounterNode | TrailSegmentNode
  | PersonalTrailNode;
export type NodeProperty = KeysOfUnion<AtlasNode>;
export type NodePayloadProperty = Exclude<NodeProperty, keyof NodeCommon>;
export type DatedNodeProperty =
  Extract<NodePayloadProperty, "created_at" | "observed_at" | "date">;
export type NodeIndex = ReadonlyMap<NodeId, AtlasNode>;

export type AtlasEdge = {
  source: NodeId;
  target: NodeId;
  type: EdgeType;
  provenance: readonly NodeId[];
  sensitivity?: SensitivityClass;
  weight?: EdgeWeight;
  order?: number;
  context?: NodeId;
  step?: NodeId;
  confidence?: ConfidenceValue;
  created_by?: string;
  created_at?: CalendarDate;
  note?: string;
  alternative_in?: readonly NodeId[];
};
export type EdgeProperty = keyof AtlasEdge;
export type EdgeIdentity =
  readonly [EdgeType, NodeId, NodeId, string, number, string];

export type ConceptDecisionDimension = "confidence" | "clarity" | "coverage";
export type QuestionDecisionDimension = "status";
export type DecisionDimension =
  ConceptDecisionDimension | QuestionDecisionDimension;
export type DecisionReference<Dimension extends DecisionDimension> = {
  dimension: Dimension;
  date: CalendarDate;
  evidence: readonly NodeId[];
};
export type ConceptStateEntry = {
  exposure: ConceptExposure;
  confidence: ConfidenceValue;
  clarity: ClarityValue;
  coverage: CoverageValue;
  freshness?: FreshnessValue;
  last_seen?: CalendarDate;
  evidence: readonly NodeId[];
  decisions: readonly DecisionReference<ConceptDecisionDimension>[];
  sensitivity?: SensitivityClass;
};
export type MaterialStateEntry = {
  depth_reached: EncounterDepth;
  last_seen: CalendarDate;
  freshness: FreshnessValue;
  evidence: readonly NodeId[];
  sensitivity?: SensitivityClass;
};
export type QuestionStateEntry = {
  status: QuestionStatus;
  evidence: readonly NodeId[];
  decisions: readonly DecisionReference<QuestionDecisionDimension>[];
  sensitivity?: SensitivityClass;
};
export type StateEntryProperty =
  | keyof ConceptStateEntry
  | keyof MaterialStateEntry
  | keyof QuestionStateEntry;
export type StateEntry =
  | Absent<ConceptStateEntry, StateEntryProperty>
  | Absent<MaterialStateEntry, StateEntryProperty>
  | Absent<QuestionStateEntry, StateEntryProperty>;

export type ConceptStateProjection = {
  exposure: ConceptExposure;
  confidence: ConfidenceValue;
  clarity: ClarityValue;
  coverage: CoverageValue;
  last_seen?: CalendarDate;
  freshness?: FreshnessValue;
  decided: readonly DecisionDimension[];
};
export type MaterialStateProjection = {
  depth_reached: EncounterDepth;
  last_seen: CalendarDate;
  freshness: FreshnessValue;
  decided: readonly DecisionDimension[];
};
export type QuestionStateProjection = {
  status: QuestionStatus;
  decided: readonly DecisionDimension[];
};
export type StateProjectionProperty =
  | keyof ConceptStateProjection
  | keyof MaterialStateProjection
  | keyof QuestionStateProjection;
export type StateProjection =
  | Absent<ConceptStateProjection, StateProjectionProperty>
  | Absent<MaterialStateProjection, StateProjectionProperty>
  | Absent<QuestionStateProjection, StateProjectionProperty>;

export type WithheldCounts = {
  nodes: number;
  edges: number;
  trails: number;
  state: number;
  influence: number;
  frontier: number;
  projections: number;
};
export type AtlasGraph = {
  format: "atlas-graph";
  version: 1;
  generated_at?: GeneratedAt;
  nodes: readonly AtlasNode[];
  edges: readonly AtlasEdge[];
  trails: readonly [];
  state: Record<NodeId, StateEntry>;
  influence: Record<string, never>;
  frontier: readonly [];
  projections: Record<NodeId, Slug>;
  withheld?: WithheldCounts;
};
export type EnvelopeProperty = keyof AtlasGraph;
export type ProjectedGraph = {
  format: "atlas-graph";
  version: 1;
  generated_at: GeneratedAt | undefined;
  nodes: readonly AtlasNode[];
  edges: readonly AtlasEdge[];
  trails: readonly [];
  state: Record<NodeId, StateProjection>;
  influence: Record<string, never>;
  frontier: readonly [];
  projections: Record<NodeId, Slug>;
};

export type AcceptedGraph = {
  kind: "ACCEPTED";
  graph: ProjectedGraph;
  retired: ReadonlyMap<NodeId, NodeId>;
};
export type RejectedGraph = {kind: "REJECTED"; diagnostic: Diagnostic};
export type UnsupportedGraphVersion = {
  kind: "UNSUPPORTED_VERSION";
  version: number;
};
export type GraphAcceptance =
  AcceptedGraph | RejectedGraph | UnsupportedGraphVersion;

export type FragmentEntry = {key: string; value: string};
export type ParsedAddress = {
  kind: "ADDRESS";
  mode: string;
  focus: string | undefined;
  field: string | undefined;
  entries: FragmentEntry[];
};
export type BadAddress = {kind: "BAD_ADDRESS"};
export type FragmentAddress = ParsedAddress | BadAddress;

type ReviewGated = {
  decisions: readonly DecisionReference<DecisionDimension>[];
  confidence?: ConfidenceValue;
  clarity?: ClarityValue;
  coverage?: CoverageValue;
  status?: QuestionStatus;
};
type GatedDefaults = Omit<ReviewGated, "decisions">;
type JsonScanFrame = {keys?: Set<string>; expectKey?: boolean};
type NodeProjectionDraft = {
  id: NodeId;
  type: NodeType;
  title: string;
  fields: readonly Field[];
} & Partial<Record<NodePayloadProperty | "formerly" | "sensitivity", unknown>>;
type EdgeProjectionDraft = {
  source: NodeId;
  target: NodeId;
  type: EdgeType;
  provenance: readonly NodeId[];
} & Partial<
  Record<Exclude<EdgeProperty, "source" | "target" | "type" | "provenance">,
  unknown>
>;
type StateProjectionDraft = {
  exposure?: ConceptExposure;
  confidence?: ConfidenceValue;
  clarity?: ClarityValue;
  coverage?: CoverageValue;
  depth_reached?: EncounterDepth;
  status?: QuestionStatus;
  last_seen?: CalendarDate;
  freshness?: FreshnessValue;
  decided?: readonly DecisionDimension[];
};

// §25.8 viewer acceptance ceilings (Decision Log 2026-07-21): measured-floor
// values — 10k corpus measured 7,294,150 B / 10,000 nodes / 19,479 edges;
// longest legitimate fragment 74 B raw, longest parameter value 40 B decoded.
export const CEILINGS: Ceilings = {
  "graph_file_bytes": 67108864,
  "graph_nodes": 131072,
  "graph_edges": 262144,
  "fragment_raw_bytes": 1024,
  "parameter_decoded_bytes": 512
};

// §14.7 owns these boundaries; this transcribes them, as the §20 fold does
// (build_atlas_graph.py FRESHNESS_DAYS). The viewer holds its own copy because
// it has no config channel to receive one (§16.5) and needs them only to refuse
// a class the derivation does not produce — never to draw one (#108). Tuning is
// a version bump in canon, so a disagreement here is a defect: the parity test
// checks both transcriptions against the § itself.
export const FRESHNESS_DAYS: FreshnessBoundaries = {
  "fresh": 30,
  "aging": 90
};

// Canonical JSON blocks below transcribe the closed atlas-graph schema sets.
export const ENVELOPE_KEYS: readonly EnvelopeProperty[] = ["format", "version", "generated_at", "nodes", "edges", "trails", "state", "influence", "frontier", "projections", "withheld"];
export const NODE_KEYS: readonly NodeProperty[] = ["id", "type", "title", "fields", "formerly", "sensitivity", "aliases", "notes", "material", "kind", "url", "status", "source_plan", "attractor", "stable_while", "text", "created_at", "source", "body", "path", "observed_at", "summary", "evidence_strength", "probe", "date", "target", "depth", "mode", "context", "direction", "from", "to", "via", "reason", "resulting_questions"];
export const EDGE_KEYS: readonly EdgeProperty[] = ["source", "target", "type", "provenance", "sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note", "alternative_in"];
export const NODE_TYPES: readonly NodeType[] = ["plan", "concept", "material", "material_part", "direction", "suggested_route", "personal_trail", "trail_segment", "artifact", "encounter", "question", "probe", "zone", "pattern"];
export const EDGE_TYPES: readonly EdgeType[] = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "alternative_to", "explains", "demonstrates", "critiques", "mentions", "loads", "has_part", "overall_concept", "supports", "part_of_direction", "step_of_route", "suggested_next", "visited", "moved_to", "via", "pulled_by", "produced_artifact", "updates_state", "influences", "probed_by", "primary_for", "supporting_for"];
export const AUTHORED_ROLES: readonly AuthoredRole[] = ["related_to", "prerequisite_of", "extends", "implements", "contradicts", "alternative_to", "explains", "demonstrates", "critiques", "mentions", "loads"];
export const FIELDS: readonly Field[] = ["knowledge", "body"];
export const ID_PREFIXES: Record<IdPrefix, NodeType> = {"concept": "concept", "material": "material", "part": "material_part", "direction": "direction", "suggested-route": "suggested_route", "trail-segment": "trail_segment", "personal-trail": "personal_trail", "artifact": "artifact", "encounter": "encounter", "question": "question", "probe": "probe", "plan": "plan", "zone": "zone", "pattern": "pattern"};
export const MATERIAL_KINDS: readonly MaterialKind[] = ["article", "docs", "paper", "book", "repo", "video", "course", "spec", "tutorial", "internal"];
export const EVIDENCE_STRENGTHS: readonly EvidenceStrength[] = ["noticed", "read", "summarized", "applied", "explained", "reviewed", "performed", "drilled"];
export const ENCOUNTER_DEPTHS: readonly EncounterDepth[] = ["skim", "read", "summarized", "applied", "taught"];
export const ENCOUNTER_MODES: readonly EncounterMode[] = ["plan-driven", "question-driven", "artifact-driven", "background"];
export const SENSITIVITY_CLASSES: readonly SensitivityClass[] = ["medical"];
export const EDGE_WEIGHTS: readonly EdgeWeight[] = ["low", "medium", "high", "unassessed"];
export const CONFIDENCE_VALUES: readonly ConfidenceValue[] = ["unknown", "low", "medium", "high"];
export const CONCEPT_EXPOSURES: readonly ConceptExposure[] = ["unseen", "touched", "read", "summarized", "applied", "taught"];
export const CLARITY_VALUES: readonly ClarityValue[] = ["vague", "rough", "stable", "disputed"];
export const COVERAGE_VALUES: readonly CoverageValue[] = ["none", "partial", "broad"];
export const FRESHNESS_VALUES: readonly FreshnessValue[] = ["fresh", "aging", "stale"];
export const QUESTION_STATUSES: readonly QuestionStatus[] = ["open", "clarified", "resolved", "stale"];
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = ["active", "archived"];
export const ROUTE_STATUSES: readonly RouteStatus[] = ["available", "hidden", "partially_followed", "ignored", "archived"];
export const ENDPOINT_RULES: Record<EdgeType, EndpointRule> = {"related_to": [["concept", "pattern"], ["concept", "pattern"]], "prerequisite_of": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "extends": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "implements": [["material_part"], ["concept", "pattern"]], "contradicts": [["concept", "material_part", "pattern"], ["concept", "pattern"]], "alternative_to": [["concept", "pattern"], ["concept", "pattern"]], "explains": [["material_part"], ["concept", "pattern"]], "demonstrates": [["material_part"], ["concept", "pattern"]], "critiques": [["material_part"], ["concept", "pattern"]], "mentions": [["material_part"], ["concept", "pattern"]], "loads": [["pattern"], ["zone"]], "supports": [["material", "material_part"], ["material", "material_part"]], "has_part": [["material"], ["material_part"]], "overall_concept": [["material"], ["concept", "pattern"]], "part_of_direction": [["concept", "pattern"], ["direction"]], "step_of_route": [["concept", "pattern"], ["suggested_route"]], "suggested_next": [["concept", "pattern"], ["concept", "pattern"]], "probed_by": [["concept", "pattern", "zone"], ["probe"]], "pulled_by": [["concept", "pattern", "zone"], ["question"]], "visited": [["encounter"], ["material", "material_part"]], "influences": [["artifact"], ["concept", "pattern", "zone"]], "updates_state": [["artifact"], ["concept", "pattern", "zone"]], "moved_to": [["concept", "pattern"], ["concept", "pattern"]], "via": [["trail_segment"], ["material", "material_part"]], "produced_artifact": [["trail_segment"], ["artifact"]], "primary_for": [["material", "material_part"], ["suggested_route", "question", "trail_segment"]], "supporting_for": [["material", "material_part"], ["suggested_route", "question", "trail_segment"]]};

export const MODES: readonly ViewerMode[] = ["field", "material", "route", "trail", "influence", "state", "frontier", "question"];
export const DEFAULT_FIELD = FIELDS[0];
export const RENDER_NODE_LINK_CEILING: number = 2400;

const TEXT_ENCODER = new TextEncoder();
const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SLUG_RE = new RegExp("^" + SLUG_SOURCE + "$");
const NODE_ID_RE = new RegExp("^(?:(?:plan|concept|material|direction|suggested-route|personal-trail|trail-segment|artifact|encounter|question|probe|zone|pattern):" + SLUG_SOURCE + "|part:" + SLUG_SOURCE + "/" + SLUG_SOURCE + ")$");
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const GENERATED_AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;
const KNOWN_FRAGMENT_KEYS: ReadonlySet<string> = new Set(["mode", "focus", "field"]);
const AUTHORED_WEIGHT_TYPES: ReadonlySet<EdgeType> = new Set([...AUTHORED_ROLES, "supports"]);
const DERIVED_WEIGHT_TYPES: ReadonlySet<EdgeType> = new Set(EDGE_TYPES.filter((type) => !AUTHORED_WEIGHT_TYPES.has(type)));
const STATUS_FORBIDDEN: ReadonlySet<NodeType> = new Set(["concept", "pattern", "zone", "material_part", "personal_trail", "trail_segment", "artifact", "encounter", "question", "plan"]);
const EDGE_DISCRIMINANTS: Partial<Record<EdgeType, readonly EdgeProperty[]>> = {
  "step_of_route": ["order"],
  "suggested_next": ["context"]
};
// §34.4: journal record ids get no redirect machinery — hand-editing the
// row is the owner's mechanism, so formerly never appears on these kinds.
const NO_REDIRECT_KINDS: ReadonlySet<NodeType> = new Set(["trail_segment", "artifact", "encounter", "question"]);
const NODE_COMMON_KEYS: ReadonlySet<NodeProperty> = new Set(["id", "type", "title", "fields", "formerly", "sensitivity"]);

const NODE_PAYLOAD_FIELDS: Record<NodeType, readonly NodePayloadProperty[]> = {
  "concept": ["aliases"],
  "pattern": ["aliases"],
  "zone": ["notes"],
  "material_part": ["material"],
  "material": ["kind", "url", "status"],
  "suggested_route": ["status", "source_plan"],
  "direction": ["status", "attractor", "stable_while"],
  "question": ["text", "created_at", "source"],
  "probe": ["status", "source_plan", "body"],
  "artifact": ["kind", "path", "observed_at", "summary", "evidence_strength", "probe"],
  "encounter": ["date", "target", "depth", "mode", "context"],
  "trail_segment": ["date", "direction", "from", "to", "via", "reason", "resulting_questions"],
  "personal_trail": ["direction"],
  "plan": []
};
const DATED_NODE_FIELDS: Partial<Record<NodeType, DatedNodeProperty>> = {
  "artifact": "observed_at",
  "encounter": "date",
  "question": "created_at",
  "trail_segment": "date",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasKeys(value: object, required: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isStringArray(value: unknown, itemCheck: (item: string) => boolean = () => true): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && itemCheck(item));
}

function isUnique(value: readonly unknown[]): boolean {
  return new Set(value).size === value.length;
}

function prefixType(nodeId: unknown): NodeType | null {
  if (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)) {
    return null;
  }
  return ID_PREFIXES[nodeId.slice(0, nodeId.indexOf(":")) as IdPrefix] || null;
}

function diagnostic(path: string, rule: string): Diagnostic {
  return {path, rule};
}

function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function validateOptionalNodeProperty(node: Record<string, unknown>, key: NodeProperty, path: string): boolean {
  const value = node[key];
  const ref = (prefix: string) => typeof value === "string" && value.startsWith(prefix) && NODE_ID_RE.test(value);
  switch (key) {
    case "formerly": return isStringArray(value, (item) => NODE_ID_RE.test(item));
    case "sensitivity": return SENSITIVITY_CLASSES.includes(value as SensitivityClass);
    case "aliases": return isStringArray(value);
    case "notes": case "kind": case "status": case "attractor": case "stable_while": case "text":
    case "body": case "path": case "summary": case "reason": return typeof value === "string";
    case "material": return ref("material:");
    case "url": {
      if (value === "") return true;
      const safeUrlPattern = new RegExp("^https:" + "\\/\\/" + "[a-z0-9][!-~]*$");
      return typeof value === "string" && safeUrlPattern.test(value);
    }
    case "source_plan": return ref("plan:");
    case "created_at": case "observed_at": case "date": return isCalendarDate(value);
    case "source":
      return isPlainObject(value) && hasOnlyKeys(value, ["artifact", "encounter"]) && Object.keys(value).length >= 1
        && (!Object.prototype.hasOwnProperty.call(value, "artifact") || (typeof value.artifact === "string" && value.artifact.startsWith("artifact:") && NODE_ID_RE.test(value.artifact)))
        && (!Object.prototype.hasOwnProperty.call(value, "encounter") || (typeof value.encounter === "string" && value.encounter.startsWith("encounter:") && NODE_ID_RE.test(value.encounter)));
    case "evidence_strength": return EVIDENCE_STRENGTHS.includes(value as EvidenceStrength);
    case "probe": return ref("probe:");
    case "target": return typeof value === "string" && (value.startsWith("material:") || value.startsWith("part:")) && NODE_ID_RE.test(value);
    case "depth": return ENCOUNTER_DEPTHS.includes(value as EncounterDepth);
    case "mode": return ENCOUNTER_MODES.includes(value as EncounterMode);
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

function validateNode(node: unknown, index: number): Diagnostic | null {
  const path = "/nodes/" + index;
  if (!isPlainObject(node)) return diagnostic(path, "type");
  if (!hasOnlyKeys(node, NODE_KEYS)) return diagnostic(path, "additionalProperties");
  if (!hasKeys(node, ["id", "type", "title", "fields"])) return diagnostic(path, "required");
  if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id)) return diagnostic(path + "/id", "pattern");
  if (!NODE_TYPES.includes(node.type as NodeType)) return diagnostic(path + "/type", "enum");
  if (prefixType(node.id) !== node.type) return diagnostic(path + "/id", "typePrefix");
  if (typeof node.title !== "string") return diagnostic(path + "/title", "type");
  if (!isStringArray(node.fields, (field) => FIELDS.includes(field as Field)) || !isUnique(node.fields)) return diagnostic(path + "/fields", "fieldSet");
  if (node.type === "concept" && (node.fields.length !== 1 || node.fields[0] !== "knowledge")) return diagnostic(path + "/fields", "registryField");
  if ((node.type === "zone" || node.type === "pattern") && (node.fields.length !== 1 || node.fields[0] !== "body")) return diagnostic(path + "/fields", "registryField");

  // §10.4 is a closed per-kind emission table. A globally known payload key
  // on the wrong kind is malformed input, not an unknown forward-compatible
  // field: projectNode would otherwise drop it and render only part of a node.
  for (const key of Object.keys(node) as NodeProperty[]) {
    if (!NODE_COMMON_KEYS.has(key) && !NODE_PAYLOAD_FIELDS[node.type as NodeType].includes(key as NodePayloadProperty)) {
      return diagnostic(path + "/" + key, "kindProperty");
    }
  }

  for (const key of NODE_KEYS) {
    if (["id", "type", "title", "fields"].includes(key) || !Object.prototype.hasOwnProperty.call(node, key)) continue;
    if (!validateOptionalNodeProperty(node, key, path + "/" + key)) return diagnostic(path + "/" + key, "shape");
  }

  const requiredByType: Record<NodeType, readonly NodePayloadProperty[]> = {
    "concept": ["aliases"], "pattern": ["aliases"], "zone": ["notes"],
    "material_part": ["material"], "material": ["kind", "url", "status"],
    "suggested_route": ["status"], "direction": ["status", "attractor"],
    "question": ["text", "created_at", "source"], "probe": ["status", "body"],
    "artifact": ["kind", "path", "observed_at", "summary", "evidence_strength"],
    "encounter": ["date", "target", "depth", "mode"],
    "trail_segment": ["date", "direction", "to", "via", "reason"],
    "personal_trail": ["direction"], "plan": []
  };
  if (!hasKeys(node, requiredByType[node.type as NodeType])) return diagnostic(path, "kindRequired");
  // §10.1/§10.4: a part id embeds its owning material slug; the payload's
  // material reference must name that same parent, as validate_atlas enforces.
  if (node.type === "material_part") {
    const parentSlug = node.id.slice("part:".length, node.id.indexOf("/"));
    if (node.material !== "material:" + parentSlug) return diagnostic(path + "/material", "partParent");
  }
  if (STATUS_FORBIDDEN.has(node.type as NodeType) && Object.prototype.hasOwnProperty.call(node, "status")) return diagnostic(path + "/status", "forbidden");
  if ((node.type === "material" || node.type === "probe" || node.type === "direction") && !LIFECYCLE_STATUSES.includes(node.status as LifecycleStatus)) return diagnostic(path + "/status", "enum");
  if (node.type === "material" && !MATERIAL_KINDS.includes(node.kind as MaterialKind)) return diagnostic(path + "/kind", "enum");
  if (node.type === "suggested_route" && !ROUTE_STATUSES.includes(node.status as RouteStatus)) return diagnostic(path + "/status", "enum");
  if (node.type === "trail_segment") {
    const conceptRef = (value: unknown) => typeof value === "string" && (value.startsWith("concept:") || value.startsWith("pattern:")) && NODE_ID_RE.test(value);
    if (Object.prototype.hasOwnProperty.call(node, "from") && !(conceptRef(node.from) || (Array.isArray(node.from) && node.from.every(conceptRef)))) return diagnostic(path + "/from", "conceptKindRef");
    if (!conceptRef(node.to)) return diagnostic(path + "/to", "conceptKindRef");
    if (!(node.via as readonly NodeId[]).every((item) => item.startsWith("artifact:") || item.startsWith("material:") || item.startsWith("part:"))) return diagnostic(path + "/via", "trailViaRef");
  }
  return null;
}

function validateEdge(edge: unknown, index: number): Diagnostic | null {
  const path = "/edges/" + index;
  if (!isPlainObject(edge)) return diagnostic(path, "type");
  if (!hasOnlyKeys(edge, EDGE_KEYS)) return diagnostic(path, "additionalProperties");
  if (!hasKeys(edge, ["source", "target", "type", "provenance"])) return diagnostic(path, "required");
  if (typeof edge.source !== "string" || !NODE_ID_RE.test(edge.source)) return diagnostic(path + "/source", "nodeId");
  if (typeof edge.target !== "string" || !NODE_ID_RE.test(edge.target)) return diagnostic(path + "/target", "nodeId");
  // §10.2 (#102): endpoints are two distinct nodes — no type applies to
  // itself. A self-edge has no drawable geometry, so accepting one would
  // leave the file carrying a claim the picture never shows (§27.8).
  if (edge.source === edge.target) return diagnostic(path + "/target", "selfEdge");
  if (!EDGE_TYPES.includes(edge.type as EdgeType)) return diagnostic(path + "/type", "enum");
  if (!isStringArray(edge.provenance, (item) => NODE_ID_RE.test(item)) || edge.provenance.length === 0) return diagnostic(path + "/provenance", "nonEmptyNodeIds");
  // §10.3/§20.3: provenance is a canonical set — dedup unions it, then the
  // builder emits it sorted. A non-increasing pair is duplicate or shuffled.
  for (let item = 1; item < edge.provenance.length; item += 1) {
    if (edge.provenance[item - 1] >= edge.provenance[item]) {
      return diagnostic(path + "/provenance", "canonicalSet");
    }
  }
  if (Object.prototype.hasOwnProperty.call(edge, "sensitivity") && !SENSITIVITY_CLASSES.includes(edge.sensitivity as SensitivityClass)) return diagnostic(path + "/sensitivity", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "weight") && !EDGE_WEIGHTS.includes(edge.weight as EdgeWeight)) return diagnostic(path + "/weight", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "order") && (!Number.isInteger(edge.order) || (edge.order as number) < 1)) return diagnostic(path + "/order", "positiveInteger");
  if (Object.prototype.hasOwnProperty.call(edge, "context") && (typeof edge.context !== "string" || !NODE_ID_RE.test(edge.context))) return diagnostic(path + "/context", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "step") && (typeof edge.step !== "string" || !NODE_ID_RE.test(edge.step))) return diagnostic(path + "/step", "nodeId");
  if (Object.prototype.hasOwnProperty.call(edge, "confidence") && !CONFIDENCE_VALUES.includes(edge.confidence as ConfidenceValue)) return diagnostic(path + "/confidence", "enum");
  if (Object.prototype.hasOwnProperty.call(edge, "created_by") && typeof edge.created_by !== "string") return diagnostic(path + "/created_by", "type");
  if (Object.prototype.hasOwnProperty.call(edge, "created_at") && !isCalendarDate(edge.created_at)) return diagnostic(path + "/created_at", "date");
  if (Object.prototype.hasOwnProperty.call(edge, "note") && typeof edge.note !== "string") return diagnostic(path + "/note", "type");
  if (Object.prototype.hasOwnProperty.call(edge, "alternative_in")) {
    const conceptKindRef = (item: string) => (item.startsWith("concept:") || item.startsWith("pattern:")) && NODE_ID_RE.test(item);
    if (!isStringArray(edge.alternative_in, conceptKindRef)) return diagnostic(path + "/alternative_in", "conceptKindRefs");
    for (let item = 1; item < edge.alternative_in.length; item += 1) {
      if (edge.alternative_in[item - 1] >= edge.alternative_in[item]) {
        return diagnostic(path + "/alternative_in", "canonicalSet");
      }
    }
    if (edge.type !== "alternative_to") return diagnostic(path + "/alternative_in", "forbidden");
  }
  // §10.2/§10.3: the meta discriminants belong to their matrix rows only —
  // order on step_of_route, context on suggested_next, step on the
  // route-context role edges. Anywhere else they could mint duplicate
  // identities past the §20.3 dedup, so a stray one rejects the file.
  const routeRole = (edge.type === "primary_for" || edge.type === "supporting_for")
    && edge.target.startsWith("suggested-route:");
  for (const meta of ["order", "context", "step"] as const) {
    if (Object.prototype.hasOwnProperty.call(edge, meta)
        && !(EDGE_DISCRIMINANTS[edge.type as EdgeType] || []).includes(meta)
        && !(routeRole && meta === "step")) {
      return diagnostic(path + "/" + meta, "forbiddenDiscriminant");
    }
  }
  if (AUTHORED_WEIGHT_TYPES.has(edge.type as EdgeType) && !Object.prototype.hasOwnProperty.call(edge, "weight")) return diagnostic(path + "/weight", "required");
  if (DERIVED_WEIGHT_TYPES.has(edge.type as EdgeType) && Object.prototype.hasOwnProperty.call(edge, "weight")) return diagnostic(path + "/weight", "forbidden");
  if (edge.type === "step_of_route" && !Object.prototype.hasOwnProperty.call(edge, "order")) return diagnostic(path + "/order", "required");
  if (edge.type === "suggested_next" && (!Object.prototype.hasOwnProperty.call(edge, "context") || !(edge.context as NodeId).startsWith("suggested-route:"))) return diagnostic(path + "/context", "routeContext");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && Object.prototype.hasOwnProperty.call(edge, "step") && !((edge.step as NodeId).startsWith("concept:") || (edge.step as NodeId).startsWith("pattern:"))) return diagnostic(path + "/step", "conceptKindRef");
  if ((edge.type === "primary_for" || edge.type === "supporting_for") && edge.target.startsWith("suggested-route:") && !Object.prototype.hasOwnProperty.call(edge, "step")) return diagnostic(path + "/step", "required");
  const endpoints = ENDPOINT_RULES[edge.type as EdgeType];
  if (!endpoints[0].includes(prefixType(edge.source)!)) return diagnostic(path + "/source", "endpointType");
  if (!endpoints[1].includes(prefixType(edge.target)!)) return diagnostic(path + "/target", "endpointType");
  return null;
}

const CONCEPT_STATE_KEYS: readonly (keyof ConceptStateEntry)[] = ["exposure", "confidence", "clarity", "coverage", "freshness", "last_seen", "evidence", "decisions", "sensitivity"];
const MATERIAL_STATE_KEYS: readonly (keyof MaterialStateEntry)[] = ["depth_reached", "last_seen", "freshness", "evidence", "sensitivity"];
const QUESTION_STATE_KEYS: readonly (keyof QuestionStateEntry)[] = ["status", "evidence", "decisions", "sensitivity"];
const DECISION_REFERENCE_KEYS: readonly (keyof DecisionReference<DecisionDimension>)[] = ["dimension", "date", "evidence"];
const CONCEPT_GATED_DEFAULTS: GatedDefaults = {
  "confidence": CONFIDENCE_VALUES[0],
  "clarity": CLARITY_VALUES[0],
  "coverage": COVERAGE_VALUES[0],
};
const QUESTION_GATED_DEFAULTS: GatedDefaults = {"status": QUESTION_STATUSES[0]};
// §14.5 upper bound only: the producer fold additionally weighs link kind
// and same-day journal position that the emitted state does not repeat.
const ARTIFACT_EXPOSURE_RANK: Record<EvidenceStrength, number> = {
  "noticed": 1,
  "read": 2,
  "summarized": 3,
  "explained": 3,
  "applied": 4,
  "reviewed": 4,
  "performed": 4,
  "drilled": 4,
};

function isEvidenceArray(value: unknown, prefixes: readonly string[], minimum: number = 0): value is NodeId[] {
  return isStringArray(
    value,
    (item) => prefixes.some((prefix) => item.startsWith(prefix + ":"))
      && NODE_ID_RE.test(item),
  ) && value.length >= minimum && isUnique(value);
}

function validateDecisionReferences(value: unknown, dimensions: readonly DecisionDimension[], path: string): Diagnostic | null {
  if (!Array.isArray(value)) return diagnostic(path, "type");
  const identities: string[] = [];
  const seenDimensions: Set<DecisionDimension> = new Set();
  for (const reference of value) {
    if (!isPlainObject(reference)) return diagnostic(path, "itemType");
    if (!hasOnlyKeys(reference, DECISION_REFERENCE_KEYS)) return diagnostic(path, "additionalProperties");
    if (!hasKeys(reference, DECISION_REFERENCE_KEYS)) return diagnostic(path, "required");
    if (!dimensions.includes(reference.dimension as DecisionDimension)) return diagnostic(path, "dimension");
    if (seenDimensions.has(reference.dimension as DecisionDimension)) return diagnostic(path, "dimensionUnique");
    seenDimensions.add(reference.dimension as DecisionDimension);
    if (!isCalendarDate(reference.date)) return diagnostic(path, "date");
    if (!isEvidenceArray(reference.evidence, ["artifact", "encounter", "question"], 1)) return diagnostic(path, "evidence");
    identities.push(JSON.stringify([
      reference.dimension, reference.date, reference.evidence,
    ]));
  }
  if (!isUnique(identities)) return diagnostic(path, "uniqueItems");
  return null;
}

function validateReviewGates(entry: ReviewGated, defaults: GatedDefaults, path: string): Diagnostic | null {
  const decided = new Set(entry.decisions.map((reference) => reference.dimension));
  for (const [dimension, defaultValue] of Object.entries(defaults)) {
    if (entry[dimension as keyof GatedDefaults] !== defaultValue && !decided.has(dimension as DecisionDimension)) {
      return diagnostic(path + "/decisions", "reviewGate");
    }
  }
  return null;
}

function validateStatusEvidence(entry: QuestionStateEntry, nodesById: NodeIndex, path: string): Diagnostic | null {
  const reference = entry.decisions.find((item) => item.dimension === "status");
  if (!reference) return null;
  const prefixes = entry.status === "stale"
    ? ["artifact"] : ["artifact", "encounter"];
  if (!isEvidenceArray(reference.evidence, prefixes, 1)) {
    return diagnostic(path + "/decisions", "statusEvidence");
  }
  if (entry.status === "stale") {
    const resolved = reference.evidence
      .filter((ref) => nodesById.has(ref))
      .map((ref) => nodesById.get(ref)!);
    if (resolved.length === reference.evidence.length
        && !resolved.some((node) => node.type === "artifact" && node.kind === "note")) {
      return diagnostic(path + "/decisions", "staleNoteEvidence");
    }
  }
  return null;
}

function validateStateAsOf(entry: StateEntry, asOf: CalendarDate | null, path: string): Diagnostic | null {
  const dates: CalendarDate[] = [];
  if (Object.prototype.hasOwnProperty.call(entry, "last_seen")) {
    dates.push(entry.last_seen!);
  }
  for (const reference of Array.isArray(entry.decisions) ? entry.decisions : []) {
    dates.push(reference.date);
  }
  if (dates.length === 0) return null;
  if (asOf === null) return diagnostic("/generated_at", "stateAsOfRequired");
  if (dates.some((date) => date > asOf)) return diagnostic(path, "stateAfterAsOf");
  return null;
}

function exposureCeiling(evidence: readonly NodeId[], nodesById: NodeIndex): number {
  let ceiling = 0;
  const explanations: CalendarDate[] = [];
  const reviews: CalendarDate[] = [];
  for (const ref of evidence) {
    const node = nodesById.get(ref);
    if (!node) continue;
    if (node.type === "artifact") {
      if (node.evidence_strength === "explained") {
        explanations.push(node.observed_at);
      } else if (node.evidence_strength === "reviewed") {
        reviews.push(node.observed_at);
      }
      ceiling = Math.max(
        ceiling, ARTIFACT_EXPOSURE_RANK[node.evidence_strength] ?? 0,
      );
    } else if (node.type === "encounter") {
      ceiling = Math.max(ceiling, node.depth === "skim" ? 1 : 2);
    }
  }
  // Dates prove cross-day order; same-day journal position is intentionally
  // absent from this upper bound and therefore remains admissible.
  if (explanations.length > 0 && reviews.length > 0
      && reviews.some(
        (reviewedOn) => explanations.some(
          (explainedOn) => reviewedOn >= explainedOn,
        ),
      )) {
    ceiling = CONCEPT_EXPOSURES.length - 1;
  }
  return ceiling;
}

function depthCeiling(evidence: readonly NodeId[], nodesById: NodeIndex): number {
  let ceiling = 0;
  for (const ref of evidence) {
    const node = nodesById.get(ref);
    if (node && node.type === "encounter") {
      ceiling = Math.max(ceiling, ENCOUNTER_DEPTHS.indexOf(node.depth));
    }
  }
  return ceiling;
}

function calendarDay(value: CalendarDate): number {
  const stamp = new Date(0);
  stamp.setUTCHours(0, 0, 0, 0);
  stamp.setUTCFullYear(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
  return Math.trunc(stamp.getTime() / 86400000);
}

function freshnessOf(lastSeen: CalendarDate, asOf: CalendarDate): FreshnessValue {
  const age = calendarDay(asOf) - calendarDay(lastSeen);
  if (age <= FRESHNESS_DAYS.fresh) return "fresh";
  return age <= FRESHNESS_DAYS.aging ? "aging" : "stale";
}

function validateStateProvenance(entry: StateEntry, node: AtlasNode, nodesById: NodeIndex, path: string): Diagnostic | null {
  if (node.type === "concept") {
    const omitsDecisionEvidence = entry.decisions!.some(
      (reference) => reference.evidence.some(
        (evidence) => !entry.evidence.includes(evidence),
      ),
    );
    if (omitsDecisionEvidence) {
      return diagnostic(path + "/evidence", "conceptDecisionEvidence");
    }
    if (Object.prototype.hasOwnProperty.call(entry, "last_seen")) {
      const contactDates = entry.evidence.flatMap((reference) => {
        const evidence = nodesById.get(reference);
        if (evidence?.type === "artifact") return [evidence.observed_at];
        if (evidence?.type === "encounter") return [evidence.date];
        return [];
      });
      if (!contactDates.includes(entry.last_seen!)) {
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
    if (entry.last_seen !== encounterDates.reduce(
      (latest, date) => date > latest ? date : latest,
    )) {
      return diagnostic(path + "/last_seen", "materialLastSeen");
    }
  } else if (node.type === "question") {
    const statusReference = entry.decisions!.find(
      (reference) => reference.dimension === "status",
    );
    const statusEvidence = statusReference === undefined
      ? [] : statusReference.evidence;
    if (entry.evidence.length !== statusEvidence.length
        || entry.evidence.some(
          (reference, index) => reference !== statusEvidence[index],
        )) {
      return diagnostic(path + "/evidence", "statusEvidenceJoin");
    }
  }

  const provenanceReferences = [
    ...entry.evidence,
    ...(Array.isArray(entry.decisions)
      ? entry.decisions.flatMap((reference) => reference.evidence)
      : []),
  ];
  const sources = [
    node,
    ...provenanceReferences.flatMap((reference) => {
      const evidence = nodesById.get(reference);
      return evidence === undefined ? [] : [evidence];
    }),
  ];
  const requiredSensitivity = sources.find(
    (source) => SENSITIVITY_CLASSES.includes(source.sensitivity!),
  )?.sensitivity;
  if (requiredSensitivity !== undefined
      && entry.sensitivity !== requiredSensitivity) {
    return diagnostic(path + "/sensitivity", "provenanceSensitivity");
  }
  return null;
}

function validateStateEntry(entry: unknown, node: AtlasNode, nodesById: NodeIndex, asOf: CalendarDate | null): Diagnostic | null {
  const path = "/state";
  const nodeType = node.type;
  if (!isPlainObject(entry)) return diagnostic(path, "entryShape");
  if (nodeType === "concept") {
    if (!hasOnlyKeys(entry, CONCEPT_STATE_KEYS)) return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["exposure", "confidence", "clarity", "coverage", "evidence", "decisions"])) return diagnostic(path, "required");
    if (!CONCEPT_EXPOSURES.includes(entry.exposure as ConceptExposure)) return diagnostic(path, "exposure");
    if (!CONFIDENCE_VALUES.includes(entry.confidence as ConfidenceValue)) return diagnostic(path, "confidence");
    if (!CLARITY_VALUES.includes(entry.clarity as ClarityValue)) return diagnostic(path, "clarity");
    if (!COVERAGE_VALUES.includes(entry.coverage as CoverageValue)) return diagnostic(path, "coverage");
    if (!isEvidenceArray(entry.evidence, ["artifact", "encounter", "question"])) return diagnostic(path, "evidence");
    if (CONCEPT_EXPOSURES.indexOf(entry.exposure as ConceptExposure)
        > exposureCeiling(entry.evidence, nodesById)) {
      return diagnostic(path + "/evidence", "exposureCeiling");
    }
    const decisionFailure = validateDecisionReferences(
      entry.decisions, ["confidence", "clarity", "coverage"], path,
    );
    if (decisionFailure) return decisionFailure;
    const hasLastSeen = Object.prototype.hasOwnProperty.call(entry, "last_seen");
    const hasFreshness = Object.prototype.hasOwnProperty.call(entry, "freshness");
    if (hasLastSeen !== hasFreshness) return diagnostic(path, "freshnessPair");
    const hasContact = entry.exposure !== CONCEPT_EXPOSURES[0];
    if (hasLastSeen !== hasContact) return diagnostic(path, "contactDates");
    if (hasLastSeen && !isCalendarDate(entry.last_seen)) return diagnostic(path, "lastSeen");
    if (hasFreshness && !FRESHNESS_VALUES.includes(entry.freshness as FreshnessValue)) return diagnostic(path, "freshness");
    const gateFailure = validateReviewGates(entry as ReviewGated, CONCEPT_GATED_DEFAULTS, path);
    if (gateFailure) return gateFailure;
  } else if (nodeType === "material" || nodeType === "material_part") {
    if (!hasOnlyKeys(entry, MATERIAL_STATE_KEYS)) return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["depth_reached", "last_seen", "freshness", "evidence"])) return diagnostic(path, "required");
    if (!ENCOUNTER_DEPTHS.includes(entry.depth_reached as EncounterDepth)) return diagnostic(path, "depth");
    if (!isCalendarDate(entry.last_seen)) return diagnostic(path, "lastSeen");
    if (!FRESHNESS_VALUES.includes(entry.freshness as FreshnessValue)) return diagnostic(path, "freshness");
    if (!isEvidenceArray(entry.evidence, ["encounter"], 1)) return diagnostic(path, "evidence");
    if (ENCOUNTER_DEPTHS.indexOf(entry.depth_reached as EncounterDepth)
        > depthCeiling(entry.evidence, nodesById)) {
      return diagnostic(path + "/evidence", "depthCeiling");
    }
  } else if (nodeType === "question") {
    if (!hasOnlyKeys(entry, QUESTION_STATE_KEYS)) return diagnostic(path, "additionalProperties");
    if (!hasKeys(entry, ["status", "evidence", "decisions"])) return diagnostic(path, "required");
    if (!QUESTION_STATUSES.includes(entry.status as QuestionStatus)) return diagnostic(path, "status");
    if (!isEvidenceArray(entry.evidence, ["artifact", "encounter", "question"])) return diagnostic(path, "evidence");
    const decisionFailure = validateDecisionReferences(entry.decisions, ["status"], path);
    if (decisionFailure) return decisionFailure;
    const statusEvidenceFailure = validateStatusEvidence(entry as QuestionStateEntry, nodesById, path);
    if (statusEvidenceFailure) return statusEvidenceFailure;
    const gateFailure = validateReviewGates(entry as ReviewGated, QUESTION_GATED_DEFAULTS, path);
    if (gateFailure) return gateFailure;
  } else {
    return diagnostic(path, "nodeKind");
  }
  if (Object.prototype.hasOwnProperty.call(entry, "sensitivity")
      && !SENSITIVITY_CLASSES.includes(entry.sensitivity as SensitivityClass)) {
    return diagnostic(path, "sensitivity");
  }
  const provenanceFailure = validateStateProvenance(
    entry as StateEntry, node, nodesById, path,
  );
  if (provenanceFailure) return provenanceFailure;
  const asOfFailure = validateStateAsOf(entry as StateEntry, asOf, path);
  if (asOfFailure) return asOfFailure;
  // §14.7 (#105): an emitted class is input, not proof that the producer
  // classified anything — every entry carrying one is recomputed against the
  // fold's as-of, materials included. validateStateAsOf has already refused a
  // dated entry with no as-of, so asOf is a date here. Exact, not approximate:
  // the boundaries are shared canon rather than per-instance config (#108), so
  // a graph the derivation disagrees with is a defect on one side or the other
  // and there is nothing weaker left worth checking.
  if (Object.prototype.hasOwnProperty.call(entry, "freshness")
      && entry.freshness !== freshnessOf(entry.last_seen as CalendarDate, asOf!)) {
    return diagnostic(path + "/freshness", "derivedFreshness");
  }
  return null;
}

// §16.5 fail-closed parity with the other Atlas readers (§25.7): native
// JSON.parse keeps the last of duplicate keys, so an ambiguous file could
// pass validation after silently overwriting a field. Scan the raw text for
// duplicate keys within one object before parsing; the builder never emits
// them, so any hit is a malformed file.
export function hasDuplicateJsonKeys(text: string): boolean {
  const escapes: Record<string, string> = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
    "n": "\n", "r": "\r", "t": "\t"};
  const stack: JsonScanFrame[] = [];
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

function edgeKey(edge: AtlasEdge): EdgeIdentity {
  return [edge.type, edge.source, edge.target,
    edge.context ?? "", edge.order ?? 0, edge.step ?? ""];
}

function compareEdgeKeys(left: EdgeIdentity, right: EdgeIdentity): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function edgeIdentity(edge: AtlasEdge): string {
  return JSON.stringify(edgeKey(edge));
}

export function validateGraph(value: unknown): Diagnostic | null {
  if (!isPlainObject(value)) return diagnostic("", "type");
  if (value.format !== "atlas-graph" || value.version !== 1) return diagnostic("", "envelope");
  if (!hasOnlyKeys(value, ENVELOPE_KEYS)) return diagnostic("", "additionalProperties");
  if (!hasKeys(value, ["format", "version", "nodes", "edges", "trails", "state", "influence", "frontier", "projections"])) return diagnostic("", "required");
  if (Object.prototype.hasOwnProperty.call(value, "generated_at")
      && (typeof value.generated_at !== "string"
          || !GENERATED_AT_RE.test(value.generated_at)
          || !isCalendarDate(value.generated_at.slice(0, 10)))) {
    return diagnostic("/generated_at", "shape");
  }
  const graphAsOf: CalendarDate | null = Object.prototype.hasOwnProperty.call(value, "generated_at")
    ? (value.generated_at as GeneratedAt).slice(0, 10) : null;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return diagnostic("", "arrayShape");
  if (!Array.isArray(value.trails) || value.trails.length !== 0) return diagnostic("/trails", "producerClosed");
  // §20 step 9 is implemented, so state is no longer producer-closed: the
  // plates render it (§16.2), and §16.5 requires the whole untrusted graph
  // to pass its closed input contract before any of it is drawn.
  if (!isPlainObject(value.state)) return diagnostic("/state", "type");
  for (const entry of Object.values(value.state)) {
    if (!isPlainObject(entry)) return diagnostic("/state", "entryShape");
  }
  if (!isPlainObject(value.influence) || Object.keys(value.influence).length !== 0) return diagnostic("/influence", "producerClosed");
  if (!Array.isArray(value.frontier) || value.frontier.length !== 0) return diagnostic("/frontier", "producerClosed");
  if (!isPlainObject(value.projections) || !Object.values(value.projections).every((item) => typeof item === "string" && SLUG_RE.test(item))) return diagnostic("/projections", "slugMap");
  // §20 step 12/§32.1: projections is the curated zone → figure_region map —
  // a key that is not a zone id cannot be audited against any node.
  for (const key of Object.keys(value.projections)) {
    if (!key.startsWith("zone:") || !NODE_ID_RE.test(key)) return diagnostic("/projections", "zoneKey");
  }
  // §20: the full graph never carries withheld — that key marks the redacted
  // variant, which lives beside the full graph, never at the viewer's single
  // input path. A withheld-bearing file here is a partial graph presented as
  // complete: reject, never render.
  if (Object.prototype.hasOwnProperty.call(value, "withheld")) return diagnostic("/withheld", "fullGraphNeverWithholds");
  const nodeIds: Set<NodeId> = new Set();
  const nodesById: Map<NodeId, AtlasNode> = new Map();
  for (let index = 0; index < value.nodes.length; index += 1) {
    const failure = validateNode(value.nodes[index], index);
    if (failure) return failure;
    const datedField = DATED_NODE_FIELDS[(value.nodes[index] as AtlasNode).type];
    if (datedField !== undefined) {
      if (graphAsOf === null) return diagnostic("/generated_at", "nodeAsOfRequired");
      if ((value.nodes[index] as Record<DatedNodeProperty, CalendarDate>)[datedField] > graphAsOf) {
        return diagnostic("/nodes/" + index + "/" + datedField, "nodeAfterAsOf");
      }
    }
    // One id, one node (§10.1): the builder errors on duplicates, so a
    // repeated id is a malformed file — focus and details must never
    // resolve ambiguously (§16.5).
    if (nodeIds.has((value.nodes[index] as AtlasNode).id)) return diagnostic("/nodes/" + index + "/id", "duplicateId");
    nodeIds.add((value.nodes[index] as AtlasNode).id);
    nodesById.set((value.nodes[index] as AtlasNode).id, value.nodes[index]);
  }
  // §20 step 9: state is keyed by the living node whose derived value it
  // carries. Validate the closed value shape against that node kind: this is
  // the minimal non-rendering join the later state view will rely on.
  for (const [key, entry] of Object.entries(value.state)) {
    const node = nodesById.get(key);
    if (!node) return diagnostic("/state", "danglingKey");
    const failure = validateStateEntry(entry, node, nodesById, graphAsOf);
    if (failure) return failure;
  }
  // §14.6/§9.8/§20 step 9: the full fold is total over the two kinds with
  // no-knowledge defaults. This viewer path rejects withheld-bearing files,
  // so every concept/question node must carry its default-or-moved entry.
  for (const node of value.nodes as AtlasNode[]) {
    if ((node.type === "concept" || node.type === "question")
        && !Object.prototype.hasOwnProperty.call(value.state, node.id)) {
      return diagnostic("/state", "missingDefault");
    }
  }
  // §20 step 12/§32.1: every emitted zone carries its curated figure_region —
  // a zone the silhouette cannot place never leaves the build, so a missing
  // entry is a malformed file, rejected whole (§16.5).
  for (let index = 0; index < value.nodes.length; index += 1) {
    if ((value.nodes[index] as AtlasNode).type === "zone" && !Object.prototype.hasOwnProperty.call(value.projections, (value.nodes[index] as AtlasNode).id)) {
      return diagnostic("/projections", "zoneWithoutProjection");
    }
  }
  // §34.4 over the whole file: a formerly entry that is itself a living id,
  // or one retired id redirecting to two survivors, is unrepresentable in a
  // builder emission — reject rather than resolve focus= wrong.
  const retiredSeen: Set<NodeId> = new Set();
  for (let index = 0; index < value.nodes.length; index += 1) {
    const node: AtlasNode = value.nodes[index];
    if (!Object.prototype.hasOwnProperty.call(node, "formerly")) continue;
    if (NO_REDIRECT_KINDS.has(node.type)) return diagnostic("/nodes/" + index + "/formerly", "noRedirectMachinery");
    for (const oldId of node.formerly!) {
      // §34.4: identity continuation is per-kind — a redirect never
      // changes kind, is never a living id, and never forks 1→n.
      if (prefixType(oldId) !== node.type) return diagnostic("/nodes/" + index + "/formerly", "kindChange");
      if (nodeIds.has(oldId)) return diagnostic("/nodes/" + index + "/formerly", "livingRedirect");
      if (retiredSeen.has(oldId)) return diagnostic("/nodes/" + index + "/formerly", "duplicateRedirect");
      retiredSeen.add(oldId);
    }
  }
  const identities: Set<string> = new Set();
  const roleConflicts: Map<string, EdgeType> = new Map();
  let previousEdgeKey: EdgeIdentity | null = null;
  for (let index = 0; index < value.edges.length; index += 1) {
    const failure = validateEdge(value.edges[index], index);
    if (failure) return failure;
    const edge: AtlasEdge = value.edges[index];
    // §20.3: the builder emits the edge array in canonical identity order;
    // accepting a shuffle would make layout and detail ordering input-driven.
    const currentEdgeKey = edgeKey(edge);
    if (previousEdgeKey !== null && compareEdgeKeys(previousEdgeKey, currentEdgeKey) > 0) {
      return diagnostic("/edges/" + index, "canonicalOrder");
    }
    previousEdgeKey = currentEdgeKey;
    // The builder never emits an edge resting on an absent node: endpoints
    // are filtered (§20 step 11), provenance is the direct derivation basis
    // (§10.3), context/step are identity discriminants naming live nodes —
    // any dangling ref is a malformed file, a generic rejection, never a
    // silently thinner render (§16.5 no-partial-render).
    if (!nodeIds.has(edge.source)) return diagnostic("/edges/" + index + "/source", "danglingEndpoint");
    if (!nodeIds.has(edge.target)) return diagnostic("/edges/" + index + "/target", "danglingEndpoint");
    if (Object.prototype.hasOwnProperty.call(edge, "context") && !nodeIds.has(edge.context!)) return diagnostic("/edges/" + index + "/context", "danglingRef");
    if (Object.prototype.hasOwnProperty.call(edge, "step") && !nodeIds.has(edge.step!)) return diagnostic("/edges/" + index + "/step", "danglingRef");
    for (const ref of edge.alternative_in || []) {
      if (!nodeIds.has(ref)) return diagnostic("/edges/" + index + "/alternative_in", "danglingRef");
    }
    for (const ref of edge.provenance) {
      if (!nodeIds.has(ref)) return diagnostic("/edges/" + index + "/provenance", "danglingRef");
    }
    // §20.3: related_to and alternative_to are canonicalized — endpoints
    // sort before anything else sees the edge.
    if ((edge.type === "related_to" || edge.type === "alternative_to") && edge.source > edge.target) {
      return diagnostic("/edges/" + index, "canonicalOrder");
    }
    // §20.3: one identity emits one edge — duplicates are malformed.
    const identity = edgeIdentity(edge);
    if (identities.has(identity)) return diagnostic("/edges/" + index, "duplicateIdentity");
    identities.add(identity);
    // §9.4/§20.3: per (material, context, step) the primary and supporting
    // role sets are disjoint — a same-key pair across the two types is the
    // role conflict the builder errors on.
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

function copyArray(value: readonly unknown[]): unknown[] {
  return value.map((item) => isPlainObject(item) ? {...item} : item);
}

function projectNode(node: AtlasNode): AtlasNode {
  const projected: NodeProjectionDraft = {id: node.id, type: node.type, title: node.title, fields: [...node.fields]};
  if (Object.prototype.hasOwnProperty.call(node, "formerly")) projected.formerly = [...node.formerly!];
  if (Object.prototype.hasOwnProperty.call(node, "sensitivity")) projected.sensitivity = node.sensitivity;
  for (const key of NODE_PAYLOAD_FIELDS[node.type]) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const value = (node as Partial<Record<NodePayloadProperty, unknown>>)[key];
    projected[key] = Array.isArray(value) ? copyArray(value) : (isPlainObject(value) ? {...value} : value);
  }
  return projected as AtlasNode;
}

// §16.2 State block: the renderer draws per-node state, so the projection
// carries it — the dimension values, the contact pair, and which gated
// dimensions a confirmed decision moved, because A2 renders the undecided
// ones as an open slot, never as their fold-default value on the scale.
function projectStateEntry(entry: StateEntry, node: AtlasNode): StateProjection {
  const projected: StateProjectionDraft = {};
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
    // §14.7 (#105): the class the §20 fold emitted, exactly as for a concept.
    // The viewer never reclassifies for the render — it holds no thresholds,
    // and a field that tunes them would otherwise move the concept boundaries
    // and the material boundaries apart in one picture.
    projected.freshness = entry.freshness;
  } else if (node.type === "question") {
    projected.status = entry.status;
  }
  projected.decided = Array.isArray(entry.decisions)
    ? entry.decisions.map((reference) => reference.dimension)
    : [];
  // §29/#107 boundary: state-entry sensitivity stays validation-only during
  // the freeze. The §14 knowledge-state values remain visible as #98 requires;
  // withholding a whole tainted entry is #38 redaction policy, still deferred.
  return projected as StateProjection;
}

function projectEdge(edge: AtlasEdge): AtlasEdge {
  const projected: EdgeProjectionDraft = {source: edge.source, target: edge.target, type: edge.type, provenance: [...edge.provenance]};
  for (const key of ["sensitivity", "weight", "order", "context", "step", "confidence", "created_by", "created_at", "note"] as const) {
    if (Object.prototype.hasOwnProperty.call(edge, key)) projected[key] = edge[key];
  }
  if (Object.prototype.hasOwnProperty.call(edge, "alternative_in")) projected.alternative_in = [...edge.alternative_in!];
  return projected as AtlasEdge;
}

export function acceptGraphBuffer(buffer: unknown): GraphAcceptance {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > CEILINGS.graph_file_bytes) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "graphFileBytes")};
  }
  // §25.8 text canon, reader parity: Atlas-authored persisted text is strict
  // UTF-8 without BOM, LF only — TextDecoder would silently strip a BOM and
  // JSON.parse accepts \r, so both are checked on the raw bytes/text.
  const head = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  if (head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "bom")};
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {fatal: true}).decode(buffer);
  } catch (_error) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "utf8")};
  }
  if (text.includes("\r")) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "crlf")};
  }
  let value: unknown;
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
  if (value.version !== 1) return {kind: "UNSUPPORTED_VERSION", version: value.version as number};
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "arrays")};
  }
  if (value.nodes.length > CEILINGS.graph_nodes || value.edges.length > CEILINGS.graph_edges) {
    return {kind: "REJECTED", diagnostic: diagnostic("", "graphCounts")};
  }
  const failure = validateGraph(value);
  if (failure) return {kind: "REJECTED", diagnostic: failure};
  const nodes = (value.nodes as AtlasNode[]).map(projectNode);
  const retired: Map<NodeId, NodeId> = new Map();
  for (const node of nodes) {
    for (const oldId of node.formerly || []) {
      if (!retired.has(oldId)) retired.set(oldId, node.id);
    }
  }
  const sourceById: Map<NodeId, AtlasNode> = new Map((value.nodes as AtlasNode[]).map((node) => [node.id, node]));
  const state: Record<NodeId, StateProjection> = {};
  for (const [key, entry] of Object.entries(value.state as Record<NodeId, StateEntry>)) {
    state[key] = projectStateEntry(entry, sourceById.get(key)!);
  }
  return {
    kind: "ACCEPTED",
    graph: {
      format: "atlas-graph", version: 1,
      generated_at: value.generated_at as GeneratedAt | undefined,
      nodes,
      edges: (value.edges as AtlasEdge[]).map(projectEdge),
      trails: [], state, influence: {}, frontier: [],
      projections: {...value.projections as Record<NodeId, Slug>}
    },
    retired
  };
}

export function parseFragment(rawFragment: unknown): FragmentAddress {
  if (typeof rawFragment !== "string" || TEXT_ENCODER.encode(rawFragment).byteLength > CEILINGS.fragment_raw_bytes) {
    return {kind: "BAD_ADDRESS"};
  }
  const known: Record<string, string> = {};
  const entries: FragmentEntry[] = [];
  for (const segment of rawFragment.split("&")) {
    if (segment === "") continue;
    const separator = segment.indexOf("=");
    const rawKey = separator < 0 ? segment : segment.slice(0, separator);
    const rawValue = separator < 0 ? "" : segment.slice(separator + 1);
    let key: string;
    let value: string;
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
