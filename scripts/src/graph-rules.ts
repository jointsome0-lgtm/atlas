// What an emitted graph must be beyond what its schema can say (§10, §11,
// §20, §20.3, §32.6, §34.4).
//
// The schema closes each node, edge and state entry on its own. Everything
// here is a join across them: an endpoint that resolves, an edge the payload
// actually records, a route whose step orders run 1..n, a redacted graph that
// is the whole-value redaction of its full sibling. None of it re-folds — it
// reads the emission and asks whether a real build could have produced it.
//
// Order matters. The diagnostics come out in the sequence the rules run, and
// that sequence is what a consumer reading a failing build sees, so the port
// keeps the oracle's order rather than a tidier one.

import { AUTHORED_ROLES, ID_PREFIXES, SYMMETRIC_EDGE_TYPES } from "./domain.ts";
import {
  ZONE_ID_RE,
  graphFieldErrors,
  reviewGateErrors,
  sameJson,
  show,
  stateCitesWithheldId,
  stateEntryHasDatedInput,
} from "./checks.ts";
import { isCalendarDate } from "./schema.ts";
import { compareCodePoint, sortedByCodePoint } from "./ordering.ts";

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDict = (value: unknown): Dict => (isDict(value) ? value : {});
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * A value interpolated into a diagnostic as itself.
 *
 * A string is its own identity and goes in bare, exactly as the oracle
 * interpolates it. Anything else has no identity to name, and absence is
 * spelled `null` here where CPython spells `None` — neither spelling is a
 * contract, and the port does not carry the other language's word for nothing.
 */
const named = (value: unknown): string =>
  typeof value === "string" ? value : show(value ?? null);

/**
 * §10.3: provenance is the direct derivation basis, so per edge kind it must
 * name the owning record — the authored species' authoring endpoint (§9.3
 * concept_edges on the source, §9.14 supported_by on the receiving target), a
 * derived species' deriving payload node (§10.2/§10.4 ownership).
 */
const PROVENANCE_SOURCE_OWNED: ReadonlySet<string> = new Set([
  ...[...AUTHORED_ROLES].filter((role) => !SYMMETRIC_EDGE_TYPES.has(role)),
  "overall_concept",
  "has_part",
  "visited",
  "influences",
  "updates_state",
  "via",
  "produced_artifact",
]);

const PROVENANCE_TARGET_OWNED: ReadonlySet<string> = new Set([
  "supports",
  "probed_by",
  "part_of_direction",
  "step_of_route",
  "pulled_by",
]);
// primary_for/supporting_for ownership is contextual (§11.1–§11.3): authored
// on a route target, derived from journal records on question and trail
// targets — checked against the payload-backing sets below.

/** §20 step 9: the fold shape each node kind's state entry must carry. */
const STATE_SHAPES: ReadonlyMap<string, string> = new Map([
  ["concept", "exposure"],
  ["material", "depth_reached"],
  ["material_part", "depth_reached"],
  ["question", "status"],
]);

/** §20.1: the payload field each dated node kind carries. */
const DATED_NODE_FIELDS: ReadonlyMap<string, string> = new Map([
  ["artifact", "observed_at"],
  ["encounter", "date"],
  ["question", "created_at"],
  ["trail_segment", "date"],
]);

/** A tuple used as a set member or map key, spelled so two equal tuples agree. */
const tupleKey = (...parts: readonly unknown[]): string => JSON.stringify(parts);

/**
 * §20.3: the canonical identity order of the edge array — type, source,
 * target, then the meta discriminants.
 *
 * Compared element by element like the oracle's tuple, with strings by code
 * point rather than by a locale's collation: the persisted order is a
 * byte-identical-rebuild promise (§20.1) and must not move with a locale.
 */
type EdgeKey = readonly [string, string, string, string, number, string];

function edgeKeyOf(edge: Dict): EdgeKey {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const order = edge["order"];
  // A JSON boolean is an `int` to Python and would sort as 0 or 1 there; here
  // it is not a number and falls to the same 0. The schema refuses it either
  // way, so the two agree on every graph that gets this far.
  return [
    text(edge["type"]),
    text(edge["source"]),
    text(edge["target"]),
    text(edge["context"]),
    typeof order === "number" ? order : 0,
    text(edge["step"]),
  ];
}

function compareEdgeKeys(left: EdgeKey, right: EdgeKey): number {
  for (const index of [0, 1, 2, 3] as const) {
    const order = compareCodePoint(left[index], right[index]);
    if (order !== 0) return order;
  }
  if (left[4] !== right[4]) return left[4] < right[4] ? -1 : 1;
  return compareCodePoint(left[5], right[5]);
}

/** Every (source, target) pair carried by edges of one type. */
function pairsOfType(edges: readonly unknown[], type: string): Set<string> {
  const pairs = new Set<string>();
  for (const entry of edges) {
    if (!isDict(entry) || entry["type"] !== type) continue;
    const source = asString(entry["source"]);
    const target = asString(entry["target"]);
    if (source !== null && target !== null) pairs.add(tupleKey(source, target));
  }
  return pairs;
}

/**
 * Check one emitted graph beyond its schema.
 *
 * `fullGraph` is the full sibling of a redacted emission and is null for the
 * full graph itself: §32.6's whole-value redaction is only checkable against
 * the graph it redacts.
 */
export function emittedGraphErrors(
  instance: Dict,
  path: unknown,
  filename: string,
  fullGraph: Dict | null,
): string[] {
  const errors: string[] = graphFieldErrors(instance, path);
  const nodes = asList(instance["nodes"]);
  const edges = asList(instance["edges"]);

  // §10: edge endpoints are node ids consumers resolve inside the same file —
  // a dangling endpoint never leaves the build.
  const nodeIds = new Set<string>();
  const nodeTypes = new Map<string, string>();
  const nodesById = new Map<string, Dict>();
  const zoneIds = new Set<string>();
  for (const entry of nodes) {
    if (!isDict(entry)) continue;
    const nodeId = asString(entry["id"]);
    if (nodeId === null) continue; // the schema already reported the type
    if (nodeIds.has(nodeId)) {
      errors.push(`${path}: duplicate node id ${nodeId} (§10.1)`);
    }
    nodeIds.add(nodeId);
    // §14.5 evidence resolution reads the emitted record.
    if (!nodesById.has(nodeId)) nodesById.set(nodeId, entry);
    const type = asString(entry["type"]);
    if (type !== null) nodeTypes.set(nodeId, type);
    if (entry["type"] === "zone") zoneIds.add(nodeId);
    // §10.1/§10.4: a part id carries its owning material's slug, and the
    // embedded material is that parent.
    const parent = asString(entry["material"]);
    if (
      entry["type"] === "material_part" &&
      parent !== null &&
      nodeId.startsWith("part:") &&
      nodeId.includes("/")
    ) {
      const slug = nodeId.slice("part:".length).split("/", 1)[0] as string;
      if (parent !== `material:${slug}`) {
        errors.push(
          `${path}: node ${nodeId} embeds material ${parent} — the id's ` +
            `owner is material:${slug} (§10.1/§10.4)`,
        );
      }
    }
  }

  // §20.1: generated_at stamps the as-of the fold measured against — the
  // anchor §14.7 freshness is derived from. An unparsable stamp is already an
  // error above; it yields no as-of rather than a half-checked one.
  const generatedAt = asString(instance["generated_at"]);
  const graphAsOf =
    generatedAt !== null && isCalendarDate(generatedAt)
      ? generatedAt.slice(0, 10)
      : null;

  // The position is the index in the whole array, so the enumeration runs
  // before the filter: a diagnostic naming nodes[3] means the fourth entry of
  // the file, not the fourth dated one.
  const datedNodes: Array<[number, Dict, string]> = [];
  nodes.forEach((entry, position) => {
    if (!isDict(entry)) return;
    const type = asString(entry["type"]);
    if (type === null) return;
    const field = DATED_NODE_FIELDS.get(type);
    if (field !== undefined) datedNodes.push([position, entry, field]);
  });

  if (graphAsOf === null && datedNodes.some(([, node, field]) => field in node)) {
    errors.push(
      `${path}: /nodes carries dated entries with no valid generated_at ` +
        "as-of (§20.1)",
    );
  } else if (graphAsOf !== null) {
    for (const [position, node, field] of datedNodes) {
      const nodeDate = asString(node[field]);
      if (
        nodeDate !== null &&
        isCalendarDate(nodeDate) &&
        compareCodePoint(nodeDate, graphAsOf) > 0
      ) {
        errors.push(`${path}: nodes[${position}] is dated after the graph as-of (§20.1)`);
      }
    }
  }

  const state = asDict(instance["state"]);
  // Any dated state implies a dated fold, and §20.1 gives that fold an as-of
  // stamp. Without one, freshness and every future-date bound go unchecked and
  // arbitrary values become contract-valid — so dated state without it is
  // rejected.
  if (
    graphAsOf === null &&
    Object.values(state).some((entry) => stateEntryHasDatedInput(entry))
  ) {
    errors.push(
      `${path}: /state carries dated entries with no valid generated_at ` +
        "as-of (§20.1)",
    );
  }

  let position = 0;
  for (const [stateId, stateEntry] of Object.entries(state)) {
    position += 1;
    if (!nodeIds.has(stateId)) {
      errors.push(
        `${path}: /state property #${position} is not keyed by an emitted ` +
          "node id (§20 step 9)",
      );
      continue;
    }
    const nodeType = nodeTypes.get(stateId) ?? null;
    const shape = nodeType === null ? undefined : STATE_SHAPES.get(nodeType);
    if (shape === undefined) {
      errors.push(
        `${path}: /state property #${position} targets a node kind outside ` +
          "the step-9 slice",
      );
    } else if (isDict(stateEntry) && !(shape in stateEntry)) {
      errors.push(
        `${path}: /state property #${position} does not carry the ` +
          `${nodeType} fold shape (§20 step 9)`,
      );
    }
    if (isDict(stateEntry)) {
      errors.push(
        ...reviewGateErrors(
          stateEntry,
          path,
          position,
          graphAsOf,
          nodesById,
          stateId,
          nodeType,
        ),
      );
    }
  }

  // §14.6/§9.8 make every gated value review-gated, and §20 step 9 makes the
  // fold total over the kinds that carry a default: a concept is at worst
  // `unseen`/no-knowledge and a question is at worst `open`. Material state
  // stays sparse — contact is what creates it. Without this, `state: {}`
  // satisfies the schema and a producer or hand-written fixture can erase
  // "no evidence yet" vs "never folded".
  //
  // §32.6 is the one licensed gap: the redacted variant keeps a public node
  // whose fold rested on classed evidence and drops the value whole. The full
  // sibling proves exactly which values the builder was licensed to omit; a
  // positional withheld-count budget could otherwise be spent on an unrelated
  // public default, or inflated outright.
  const redacted = filename.endsWith(".redacted.json");
  const licensedMissing = new Set<string>();
  if (redacted && fullGraph !== null) {
    const fullState = asDict(fullGraph["state"]);
    const fullNodeIds = new Set<string>();
    for (const node of asList(fullGraph["nodes"])) {
      if (!isDict(node)) continue;
      const id = asString(node["id"]);
      if (id !== null) fullNodeIds.add(id);
    }
    const withheldIds = new Set(
      [...fullNodeIds].filter((id) => !nodeIds.has(id)),
    );
    const expectedState: Dict = {};
    for (const [id, entry] of Object.entries(fullState)) {
      if (withheldIds.has(id)) continue;
      if (isDict(entry) && "sensitivity" in entry) continue;
      if (stateCitesWithheldId(entry, withheldIds)) continue;
      expectedState[id] = entry;
    }
    for (const id of Object.keys(fullState)) {
      if (!(id in expectedState) && nodeIds.has(id)) licensedMissing.add(id);
    }
    if (!sameJson(state, expectedState)) {
      errors.push(
        `${path}: /state is not the whole-value §32.6 redaction of the full ` +
          "sibling graph",
      );
    }
    const withheldState = asDict(instance["withheld"])["state"];
    const expectedCount =
      Object.keys(fullState).length - Object.keys(expectedState).length;
    // The oracle's `isinstance(x, int) and not isinstance(x, bool)` is the
    // number test here: a JSON boolean is not a JavaScript number, so the
    // hand-written bool exclusion has nothing to do. The integer test is
    // redundant with the reader, which never yields a non-integer number
    // (§25.7) — it stays so the rule does not rest on a guarantee made three
    // modules away. A `2.0` spelling is the recorded int/float divergence
    // (#132): it reads as 2 here and stays a float there, where the schema
    // refuses it before this rule is reached.
    if (
      typeof withheldState === "number" &&
      Number.isInteger(withheldState) &&
      withheldState !== expectedCount
    ) {
      errors.push(
        `${path}: /withheld/state does not match the full sibling graph ` +
          "(§20/§32.6)",
      );
    }
  }

  const stateKeys = new Set(Object.keys(state));
  const missing = [...nodeTypes.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .filter(
      ([id, type]) =>
        (type === "concept" || type === "question") && !stateKeys.has(id),
    )
    .map(([id]) => id);
  for (const stateId of missing) {
    if (licensedMissing.has(stateId)) continue;
    errors.push(
      `${path}: ${stateId} carries no /state entry — the step-9 fold is ` +
        "total over concepts and questions (§20 step 9)",
    );
  }

  errors.push(...edgeReferenceErrors(edges, path, nodeIds));
  const routes = routeStructure(edges, path, errors);
  errors.push(...edgeCanonicalErrors(edges, path, routes));
  errors.push(...payloadErrors(nodes, edges, path, nodeIds, routes.stepOrders));

  // §10/§32.1: projections are the curated zone → figure_region mapping; the
  // schema subset cannot constrain map keys, so the zone-id shape of each key
  // is checked here (values are the schema's figure_region slug pattern).
  const projections = asDict(instance["projections"]);
  for (const key of Object.keys(projections)) {
    if (!ZONE_ID_RE.test(key)) {
      errors.push(`${path}: projections key ${show(key)} is not a zone id (§10/§32.1)`);
    }
  }
  // §20 step 12: every emitted zone carries its curated figure_region — a zone
  // the silhouette cannot place never leaves the build.
  for (const zoneId of sortedByCodePoint(
    [...zoneIds].filter((id) => !(id in projections)),
  )) {
    errors.push(
      `${path}: zone ${zoneId} has no projections entry (§20 step 12, §32.1)`,
    );
  }

  if (redacted && !("withheld" in instance)) {
    errors.push(`${path}: the redacted graph must carry withheld (§20)`);
  }
  if (redacted) {
    // §32.6/§24.3: everything the union marks is OMITTED from the agent-facing
    // variant — a surviving classed entry means the gate would certify classed
    // content into agent context.
    for (const section of ["nodes", "edges", "state"] as const) {
      const entries =
        section === "state"
          ? Object.values(asDict(instance[section]))
          : asList(instance[section]);
      entries.forEach((entry, index) => {
        if (isDict(entry) && "sensitivity" in entry) {
          errors.push(
            `${path}: ${section}[${index}] still carries sensitivity in the ` +
              "redacted graph (§32.6)",
          );
        }
      });
    }
  }
  if (!redacted && "withheld" in instance) {
    errors.push(`${path}: the full graph never carries withheld (§20)`);
  }
  return errors;
}

/** Endpoints, self-edges, and every id an edge references (§10, §10.3). */
function edgeReferenceErrors(
  edges: readonly unknown[],
  path: unknown,
  nodeIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  edges.forEach((entry, index) => {
    if (!isDict(entry)) return;
    for (const endpoint of ["source", "target"] as const) {
      const ref = asString(entry[endpoint]);
      if (ref !== null && !nodeIds.has(ref)) {
        errors.push(
          `${path}: edges[${index}].${endpoint} ${ref} is not an emitted ` +
            "node id (§10)",
        );
      }
    }
    // §10.2 (#102): no edge type applies to itself, so both endpoints
    // resolving to one node is a rejection — the viewer would otherwise carry
    // a claim it draws as a zero-length line, i.e. as nothing (§27.8). The
    // schema cannot compare sibling properties; this is its arm.
    const source = asString(entry["source"]);
    if (source !== null && entry["source"] === entry["target"]) {
      errors.push(
        `${path}: edges[${index}] ${named(entry["type"])} ${source} applies ` +
          "to itself — endpoints must be two distinct nodes (§10.2)",
      );
    }
    // §10.3: provenance is the complete derivation basis — authoring node ids
    // and deriving record/route ids, all emitted as nodes of the same build.
    for (const ref of asList(entry["provenance"])) {
      if (typeof ref === "string" && !nodeIds.has(ref)) {
        errors.push(
          `${path}: edges[${index}].provenance ${ref} is not an emitted ` +
            "node id (§10.3)",
        );
      }
    }
    // §10.3: context and step are identity discriminants — node ids consumers
    // resolve like endpoints.
    for (const key of ["context", "step"] as const) {
      const ref = asString(entry[key]);
      if (ref !== null && !nodeIds.has(ref)) {
        errors.push(
          `${path}: edges[${index}].${key} ${ref} is not an emitted node id ` +
            "(§10.3)",
        );
      }
    }
    // §10.3 (#94): alternative_in is an optional canonical set of concept-kind
    // refs. It is annotation, not an identity discriminant, but every ref
    // still resolves in the same graph consumed by the viewer.
    const alternativeIn = asList(entry["alternative_in"]);
    const alternativeRefs = alternativeIn.filter(
      (ref): ref is string => typeof ref === "string",
    );
    if (
      alternativeRefs.length === alternativeIn.length &&
      !sameJson(alternativeRefs, sortedByCodePoint([...new Set(alternativeRefs)]))
    ) {
      errors.push(
        `${path}: edges[${index}].alternative_in is not a sorted unique set ` +
          "(§10.3/§20.3)",
      );
    }
    for (const ref of alternativeRefs) {
      if (!nodeIds.has(ref)) {
        errors.push(
          `${path}: edges[${index}].alternative_in ${ref} is not an emitted ` +
            "node id (§10.3)",
        );
      }
    }
    // §10.3: provenance is the derivation basis, not just any resolvable ids —
    // it must name the record that authored or derived the edge, or
    // redaction/audit consumers trust the wrong record (§32.6 reads this list).
    const type = asString(entry["type"]); // the schema already reported a non-string
    const provenance = new Set(
      asList(entry["provenance"]).filter(
        (ref): ref is string => typeof ref === "string",
      ),
    );
    let owner: unknown = null;
    let ownerRole: string | null = null;
    if (type !== null && PROVENANCE_SOURCE_OWNED.has(type)) {
      owner = entry["source"];
      ownerRole = "authoring source";
    } else if (type !== null && PROVENANCE_TARGET_OWNED.has(type)) {
      owner = entry["target"];
      ownerRole = "owning target";
    } else if (type === "suggested_next") {
      owner = entry["context"];
      ownerRole = "deriving route";
    }
    if (typeof owner === "string" && provenance.size > 0 && !provenance.has(owner)) {
      errors.push(
        `${path}: edges[${index}] ${named(type)} provenance must include ` +
          `the ${ownerRole} ${owner} (§10.3)`,
      );
    } else if (
      type !== null &&
      SYMMETRIC_EDGE_TYPES.has(type) &&
      provenance.size > 0 &&
      !provenance.has(entry["source"] as string) &&
      !provenance.has(entry["target"] as string)
    ) {
      errors.push(
        `${path}: edges[${index}] ${named(type)} provenance must include an ` +
          "authoring endpoint (§10.3)",
      );
    }
    // moved_to's owning segment is not an endpoint: its provenance is checked
    // against the segments recording the pair, in the payload-backing pass.
  });
  return errors;
}

interface RouteStructure {
  /** (route, step) pairs a step_of_route edge records. */
  readonly routeSteps: ReadonlySet<string>;
  /** route id -> order -> the step at that order. */
  readonly stepOrders: ReadonlyMap<string, ReadonlyMap<number, string>>;
}

/**
 * §9.4/§10.2/§10.3: a route's step positions and the suggested_next edges its
 * consecutive steps derive.
 */
function routeStructure(
  edges: readonly unknown[],
  path: unknown,
  errors: string[],
): RouteStructure {
  const routeSteps = new Set<string>();
  for (const entry of edges) {
    if (!isDict(entry) || entry["type"] !== "step_of_route") continue;
    const target = asString(entry["target"]);
    const source = asString(entry["source"]);
    if (target !== null && source !== null) routeSteps.add(tupleKey(target, source));
  }

  // §10.2: suggested_next derives from consecutive steps of one route — the
  // context route must hold source at some order k and target at k+1.
  const stepOrders = new Map<string, Map<number, string>>();
  for (const entry of edges) {
    if (!isDict(entry) || entry["type"] !== "step_of_route") continue;
    const target = asString(entry["target"]);
    const source = asString(entry["source"]);
    const order = entry["order"];
    if (target === null || source === null) continue;
    if (typeof order !== "number" || !Number.isInteger(order)) continue;
    let orders = stepOrders.get(target);
    if (orders === undefined) {
      orders = new Map();
      stepOrders.set(target, orders);
    }
    if (orders.has(order)) {
      // §9.4/§10.3: order positions define the route path — a duplicate makes
      // it ambiguous.
      errors.push(
        `${path}: duplicate step order ${order} on ${target} (§9.4/§10.3)`,
      );
      continue;
    }
    orders.set(order, source);
  }

  // §10.2: consecutive steps derive suggested_next — every adjacent (k, k+1)
  // pair of a route must have its edge.
  const suggestedPairs = new Set<string>();
  for (const entry of edges) {
    if (!isDict(entry) || entry["type"] !== "suggested_next") continue;
    const context = asString(entry["context"]);
    const source = asString(entry["source"]);
    const target = asString(entry["target"]);
    if (context !== null && source !== null && target !== null) {
      suggestedPairs.add(tupleKey(context, source, target));
    }
  }

  for (const route of sortedByCodePoint([...stepOrders.keys()])) {
    const orders = stepOrders.get(route) as Map<number, string>;
    const positions = [...orders.keys()].sort((left, right) => left - right);
    // §9.4: steps is an ordered array — the builder emits contiguous orders
    // 1..n, so a gapped or shifted set has lost part of the route.
    if (!positions.every((value, index) => value === index + 1)) {
      errors.push(
        `${path}: route ${route} step orders ${show(positions)} are not ` +
          "contiguous from 1 (§9.4)",
      );
    }
    for (const at of positions) {
      const follower = orders.get(at + 1);
      if (
        follower !== undefined &&
        !suggestedPairs.has(tupleKey(route, orders.get(at) as string, follower))
      ) {
        errors.push(
          `${path}: route ${route} steps at orders ${at}/${at + 1} have no ` +
            "suggested_next edge (§10.2)",
        );
      }
    }
  }
  return { routeSteps, stepOrders };
}

/** §20.3: canonical array order, one edge per identity, per-type meta. */
function edgeCanonicalErrors(
  edges: readonly unknown[],
  path: unknown,
  routes: RouteStructure,
): string[] {
  const errors: string[] = [];
  // §20.3 determinism: the edge array emits in canonical identity order —
  // type, source, target, then the meta discriminant; a shuffled array breaks
  // the §20.1 byte-identical promise.
  const keys = edges.filter(isDict).map(edgeKeyOf);
  if (!keys.every((key, index) => index === 0 || compareEdgeKeys(keys[index - 1] as EdgeKey, key) <= 0)) {
    errors.push(`${path}: edges are not in canonical identity order (§20.3)`);
  }

  const roleEdges = new Map<string, string>();
  const identities = new Set<string>();
  edges.forEach((entry, index) => {
    if (!isDict(entry)) return;
    const type = asString(entry["type"]);
    const source = asString(entry["source"]);
    const target = asString(entry["target"]);
    if (type !== null && source !== null && target !== null) {
      // §10.2/§20.3: the meta discriminants are per-type — order on
      // step_of_route, context on suggested_next, step on route-context roles;
      // anywhere else they would mint fake identities for one edge.
      let allowedMeta: ReadonlySet<string> =
        type === "step_of_route"
          ? new Set(["order"])
          : type === "suggested_next"
            ? new Set(["context"])
            : new Set();
      if (
        (type === "primary_for" || type === "supporting_for") &&
        target.startsWith("suggested-route:")
      ) {
        allowedMeta = new Set(["step"]);
      }
      for (const key of ["order", "context", "step"] as const) {
        if (key in entry && !allowedMeta.has(key)) {
          errors.push(
            `${path}: edges[${index}] ${type} carries ${key} — not this ` +
              "type's §10.2 meta discriminant (§20.3)",
          );
        }
      }
      // §20.3: related_to and alternative_to are symmetric — persisted edges
      // carry canonical sorted endpoints, and identity uses the sorted pair so
      // a reversed duplicate cannot sit beside the canonical spelling.
      let left = source;
      let right = target;
      if (SYMMETRIC_EDGE_TYPES.has(type) && compareCodePoint(right, left) < 0) {
        errors.push(
          `${path}: edges[${index}] ${type} endpoints ${source} -> ${target} ` +
            "are not sorted (§20.3)",
        );
        [left, right] = [right, left];
      }
      const discriminant = (key: string): unknown => {
        const value = entry[key];
        return typeof value === "string" || typeof value === "number" ? value : null;
      };
      const identity = tupleKey(
        type,
        left,
        right,
        discriminant("context"),
        discriminant("order"),
        discriminant("step"),
      );
      if (identities.has(identity)) {
        errors.push(
          `${path}: edges[${index}] duplicates edge identity ${type} ` +
            `${source} -> ${target} (§20.3)`,
        );
      }
      identities.add(identity);
    }

    const context = asString(entry["context"]);
    if (entry["type"] === "suggested_next" && context !== null) {
      const orders = routes.stepOrders.get(context) ?? new Map<number, string>();
      const consecutive = [...orders.keys()].some(
        (at) =>
          orders.get(at) === entry["source"] && orders.get(at + 1) === entry["target"],
      );
      if (!consecutive) {
        errors.push(
          `${path}: edges[${index}] suggested_next ${named(entry["source"])} -> ` +
            `${named(entry["target"])} is not consecutive steps of ${context} ` +
            "(§10.2)",
        );
      }
    }

    const step = asString(entry["step"]);
    const isRole = entry["type"] === "primary_for" || entry["type"] === "supporting_for";
    if (
      isRole &&
      step !== null &&
      target !== null &&
      !routes.routeSteps.has(tupleKey(target, step))
    ) {
      errors.push(
        `${path}: edges[${index}].step ${step} is not a step of ` +
          `${named(entry["target"])} (§9.4)`,
      );
    }
    // §9.4/§20.3: per (route, step, material) the two role sets stay disjoint
    // in the persisted graph too.
    if (isRole && source !== null && target !== null) {
      const roleKey = tupleKey(target, step, source);
      const previous = roleEdges.get(roleKey);
      if (previous !== undefined && previous !== entry["type"]) {
        errors.push(
          `${path}: ${source} is both primary and supporting for ${target} ` +
            `step ${named(entry["step"])} (§9.4/§20.3)`,
        );
      }
      roleEdges.set(roleKey, entry["type"] as string);
    }
  });
  return errors;
}

/**
 * §10.2/§10.4/§11: the payload and the typed edges cannot fork.
 *
 * The forward direction — a payload record whose derived edge is missing — and
 * the reverse — an edge no payload records — are both errors, which together
 * make the two sides one statement (§31.8).
 */
function payloadErrors(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  path: unknown,
  nodeIds: ReadonlySet<string>,
  stepOrders: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string[] {
  const errors: string[] = [];
  const visitedPairs = pairsOfType(edges, "visited");
  const hasPartPairs = pairsOfType(edges, "has_part");
  const movedPairs = pairsOfType(edges, "moved_to");
  const viaPairs = pairsOfType(edges, "via");
  const producedPairs = pairsOfType(edges, "produced_artifact");

  // §34.4 at the boundary: formerly is per-kind, never a living id, and one
  // retired id has one survivor.
  const formerlySurvivors = new Map<string, string>();
  const payloadVisits = new Set<string>();
  const payloadParts = new Set<string>();
  // pair -> the segment ids recording it: moved_to's owning segment is not an
  // endpoint, so its §10.3 provenance is checked against this map.
  const payloadMovements = new Map<string, Set<string>>();
  const payloadVia = new Set<string>();
  const payloadProduced = new Set<string>();
  // encounter id -> (target, depth, context.question, context.artifact): the
  // §11.2–§11.3 role folds recompute from these rows.
  const encounterRows = new Map<
    string,
    readonly [string, unknown, unknown, unknown]
  >();

  for (const node of nodes) {
    if (!isDict(node)) continue;
    const nid = asString(node["id"]);
    if (nid === null) continue;
    const target = asString(node["target"]);
    if (node["type"] === "encounter" && target !== null) {
      payloadVisits.add(tupleKey(nid, target));
      const context = asDict(node["context"]);
      encounterRows.set(nid, [
        target,
        node["depth"],
        context["question"],
        context["artifact"],
      ]);
      if (nodeIds.has(target) && !visitedPairs.has(tupleKey(nid, target))) {
        errors.push(
          `${path}: encounter ${nid} target ${target} has no visited edge ` +
            "(§10.2/§10.4)",
        );
      }
    }
    const material = asString(node["material"]);
    if (node["type"] === "material_part" && material !== null) {
      payloadParts.add(tupleKey(material, nid));
      if (nodeIds.has(material) && !hasPartPairs.has(tupleKey(material, nid))) {
        errors.push(
          `${path}: part ${nid} has no has_part edge from ${material} ` +
            "(§10.2/§10.4)",
        );
      }
    }
    if (node["type"] === "trail_segment") {
      const origin = node["from"];
      const origins = Array.isArray(origin) ? origin : [origin];
      const destination = node["to"];
      for (const ref of origins) {
        if (typeof ref !== "string" || typeof destination !== "string") continue;
        const pair = tupleKey(ref, destination);
        let recording = payloadMovements.get(pair);
        if (recording === undefined) {
          recording = new Set();
          payloadMovements.set(pair, recording);
        }
        recording.add(nid);
        if (
          nodeIds.has(ref) &&
          nodeIds.has(destination) &&
          !movedPairs.has(pair)
        ) {
          errors.push(
            `${path}: segment ${nid} movement ${ref} -> ${destination} has ` +
              "no moved_to edge (§10.2/§9.9)",
          );
        }
      }
      for (const ref of asList(node["via"])) {
        if (typeof ref !== "string") continue;
        // §10.2: material(part) via items derive via edges; artifact items
        // derive produced_artifact.
        if (ref.startsWith("artifact:")) payloadProduced.add(tupleKey(nid, ref));
        else payloadVia.add(tupleKey(nid, ref));
        if (!nodeIds.has(ref)) continue;
        if (ref.startsWith("artifact:")) {
          if (!producedPairs.has(tupleKey(nid, ref))) {
            errors.push(
              `${path}: segment ${nid} artifact ${ref} has no ` +
                "produced_artifact edge (§10.2/§9.9)",
            );
          }
        } else if (!viaPairs.has(tupleKey(nid, ref))) {
          errors.push(
            `${path}: segment ${nid} via ${ref} has no via edge (§10.2/§9.9)`,
          );
        }
      }
    }
    for (const oldId of asList(node["formerly"])) {
      if (typeof oldId !== "string") continue;
      const prefix = oldId.split(":", 1)[0] as string;
      if ((ID_PREFIXES.get(prefix) ?? null) !== (node["type"] ?? null)) {
        errors.push(`${path}: formerly ${oldId} on ${nid} changes kind (§34.4)`);
      }
      if (nodeIds.has(oldId)) {
        errors.push(
          `${path}: formerly ${oldId} on ${nid} is still a living id (§34.4)`,
        );
      }
      const survivor = formerlySurvivors.get(oldId);
      if (survivor !== undefined) {
        errors.push(
          `${path}: retired id ${oldId} redirects to both ${survivor} and ` +
            `${nid} (§34.4)`,
        );
      } else {
        formerlySurvivors.set(oldId, nid);
      }
    }
  }

  // §10.2/§10.4 reverse direction: reject a derived typed edge no payload
  // records — with the forward checks above, the payload and the typed edges
  // can never fork (§31.8).
  const backing: ReadonlyArray<
    readonly [string, ReadonlySet<string> | ReadonlyMap<string, unknown>, string]
  > = [
    ["visited", payloadVisits, "encounter target"],
    ["has_part", payloadParts, "embedded part parent"],
    ["moved_to", payloadMovements, "trail segment movement"],
    ["via", payloadVia, "trail segment via item"],
    ["produced_artifact", payloadProduced, "trail segment via item"],
  ];

  edges.forEach((entry, index) => {
    if (!isDict(entry)) return;
    const source = asString(entry["source"]);
    const target = asString(entry["target"]);
    if (source === null || target === null) return;
    const pair = tupleKey(source, target);
    for (const [type, recorded, noun] of backing) {
      if (entry["type"] === type && !recorded.has(pair)) {
        errors.push(
          `${path}: edges[${index}] ${type} ${source} -> ${target} is not ` +
            `backed by a ${noun} (§10.2/§10.4)`,
        );
      }
    }
    if (entry["type"] === "primary_for" || entry["type"] === "supporting_for") {
      const role = entry["type"];
      const provenance = new Set(
        asList(entry["provenance"]).filter(
          (ref): ref is string => typeof ref === "string",
        ),
      );
      if (target.startsWith("suggested-route:")) {
        // §11.1: route roles are authored on the route.
        if (provenance.size > 0 && !provenance.has(target)) {
          errors.push(
            `${path}: edges[${index}] ${role} provenance must include the ` +
              `authoring route ${target} (§10.3/§11.1)`,
          );
        }
      } else if (target.startsWith("question:")) {
        // §11.2: derived from encounters citing the question — deep use
        // (applied|taught) folds primary, else supporting.
        const citing = new Set(
          [...encounterRows.entries()]
            .filter(([, row]) => row[0] === source && row[2] === target)
            .map(([id]) => id),
        );
        if (citing.size === 0) {
          errors.push(
            `${path}: edges[${index}] ${role} ${source} -> ${target} is not ` +
              "backed by an encounter citing the question (§11.2)",
          );
          return;
        }
        const deep = [...citing].some((id) => {
          const depth = encounterRows.get(id)?.[1];
          return depth === "applied" || depth === "taught";
        });
        const expected = deep ? "primary_for" : "supporting_for";
        if (role !== expected) {
          errors.push(
            `${path}: edges[${index}] ${role} ${source} -> ${target} — the ` +
              `citing encounters fold ${expected} (§11.2)`,
          );
        }
        if (provenance.size > 0 && ![...provenance].some((ref) => citing.has(ref))) {
          errors.push(
            `${path}: edges[${index}] ${role} provenance names no deriving ` +
              "encounter (§10.3/§11.2)",
          );
        }
      } else if (target.startsWith("trail-segment:")) {
        // §11.3: via materials fold primary; the target of an encounter citing
        // one of the segment's via artifacts, not itself in via, supporting.
        if (role === "primary_for") {
          if (!payloadVia.has(tupleKey(target, source))) {
            errors.push(
              `${path}: edges[${index}] primary_for ${source} -> ${target} ` +
                "is not backed by the segment's via (§11.3)",
            );
          } else if (provenance.size > 0 && !provenance.has(target)) {
            errors.push(
              `${path}: edges[${index}] primary_for provenance must include ` +
                `the recording segment ${target} (§10.3/§11.3)`,
            );
          }
        } else {
          if (payloadVia.has(tupleKey(target, source))) {
            errors.push(
              `${path}: edges[${index}] supporting_for ${source} -> ` +
                `${target} — a via material folds primary (§11.3)`,
            );
            return;
          }
          const citing = new Set(
            [...encounterRows.entries()]
              .filter(
                ([, row]) =>
                  row[0] === source &&
                  row[3] !== null &&
                  row[3] !== undefined &&
                  payloadProduced.has(tupleKey(target, row[3])),
              )
              .map(([id]) => id),
          );
          if (citing.size === 0) {
            errors.push(
              `${path}: edges[${index}] supporting_for ${source} -> ` +
                `${target} is not backed by an encounter citing a via ` +
                "artifact (§11.3)",
            );
          } else if (
            provenance.size > 0 &&
            !(provenance.has(target) && [...provenance].some((ref) => citing.has(ref)))
          ) {
            errors.push(
              `${path}: edges[${index}] supporting_for provenance must list ` +
                "the segment and a deriving encounter (§10.3/§11.3)",
            );
          }
        }
      }
    }
    if (entry["type"] === "moved_to" && payloadMovements.has(pair)) {
      // §10.3: the derivation basis is the recording row — naming another
      // segment misattributes the movement.
      const provenance = new Set(
        asList(entry["provenance"]).filter(
          (ref): ref is string => typeof ref === "string",
        ),
      );
      const recording = payloadMovements.get(pair) as Set<string>;
      if (provenance.size > 0 && ![...provenance].some((ref) => recording.has(ref))) {
        errors.push(
          `${path}: edges[${index}] moved_to provenance names no segment ` +
            `recording ${source} -> ${target} (§9.9/§10.3)`,
        );
      }
    }
    // The same pair, checked a second way: the canonical pass asks whether
    // *some* consecutive positions hold these two, this one asks it of the
    // adjacent-pair set built from the route's own orders. They differ when a
    // route's orders are not contiguous, and both diagnostics are the oracle's.
    const context = asString(entry["context"]);
    if (entry["type"] === "suggested_next" && context !== null) {
      const orders = stepOrders.get(context) ?? new Map<number, string>();
      const adjacent = new Set(
        [...orders.keys()]
          .filter((at) => orders.has(at + 1))
          .map((at) => tupleKey(orders.get(at), orders.get(at + 1))),
      );
      if (!adjacent.has(pair)) {
        errors.push(
          `${path}: edges[${index}] suggested_next ${source} -> ${target} is ` +
            `not a consecutive step pair of ${context} (§10.2)`,
        );
      }
    }
  });
  return errors;
}
