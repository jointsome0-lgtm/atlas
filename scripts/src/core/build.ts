// §20: the graph builder — curated files and journals in, one graph out.
//
// The shape of this module is the shape of the function it replaces: one
// long build with a great deal of shared state and a set of small closures
// over it. That is not an accident of the original and it is not improved
// here. The passes are ordered — §34.4 redirects resolve before §20.3
// normalizes, normalization before dedup, dedup before the endpoint matrix,
// the matrix before §10.4 fields, and every dated journal must be read
// before the fold anchor is known — and each pass reads state the ones
// before it wrote. Splitting them into modules would mean handing that
// state across a boundary, which is a rewrite wearing a port's clothes.
//
// What is worth knowing before reading it:
//
//   - Two error registers. `errors` fails the build; `warnings` do not, and
//     the difference is §5.2 and §34.2 — deletion is the owner's right, so a
//     reference that broke because a record was deleted is a warning while
//     the same shape authored in living curation is an error. `_lenient`
//     rides on an edge to say which side of that line it was born on.
//   - Key order is output. The graph is a persisted format (§25.7) and is
//     compared byte for byte, so where a key lands in a node or an edge is
//     as much of the port as its value. Python dicts keep insertion order
//     and so do JavaScript objects; every `extra` here is built in the
//     order the oracle builds it, and reassigning an existing key leaves it
//     where it was on both sides.
//   - Strings sort by code point, never by UTF-16 code unit — see
//     `sortedByCodePoint`, which is the only sort used on ids here.
//
// Ported from build in scripts/build_atlas_graph.py.

import {
  ARTIFACT_EXPOSURE_RANK,
  AUTHORED_ROLES,
  CONCEPT_DEFAULTS,
  CONCEPT_EXPOSURE,
  CONCEPT_KIND,
  DECISION_OUTCOMES,
  DECISION_TARGET_PREFIXES,
  DECISION_VALUES,
  DEEP_USE_DEPTHS,
  DEFERRED_DECISION_TARGET_KINDS,
  DEFERRED_DIMENSIONS,
  EDGE_TYPES,
  EDGE_WEIGHTS,
  ENCOUNTER_DEPTHS,
  ENCOUNTER_MODES,
  ENDPOINT_RULES,
  EVIDENCE_PREFIXES,
  EVIDENCE_STRENGTHS,
  FOLDED_DECISION_TARGETS,
  FORBIDDEN_ROUTE_STATUSES,
  INTAKE_KEY_RE,
  JOURNAL_ROW_KEYS,
  LIFECYCLE_STATUSES,
  MATERIAL_DEPTH,
  MATERIAL_KINDS,
  NODE_ID_RE,
  NODE_TYPES,
  PART_ID_RE,
  PROPOSERS,
  QUESTION_DEFAULT_STATUS,
  REGION_PREFIXES,
  REGISTRY_FIELDS,
  ROUTE_STATUSES,
  SENSITIVITY_CLASSES,
  STALE_EVIDENCE_KIND,
  STALE_EVIDENCE_PREFIXES,
  STATUS_EVIDENCE_PREFIXES,
  SYMMETRIC_EDGE_TYPES,
  foldOrderKey,
  freshnessOf,
  idType,
} from "./domain.ts";
import { JsonDisciplineError, parseStrict } from "../boundary/canonical-json.ts";
import { JOURNAL_ROW_BYTES } from "../boundary/instance.ts";
import { ReaderError, ReasonCode, AtlasReader } from "../boundary/reader.ts";
import type { ScannedFile } from "../boundary/reader.ts";
import { frontmatterBody, parseFrontmatter } from "../boundary/frontmatter.ts";
import { builderJournalLines } from "../boundary/journal.ts";
import { compareCodePoint, sortedByCodePoint } from "../boundary/ordering.ts";
import { splitPath } from "../boundary/paths.ts";
import { show } from "./checks.ts";
import { CalendarError, parseDate } from "../boundary/calendar.ts";
import { realpathSync } from "node:fs";

/**
 * A value inside a diagnostic, spelled the way the rest of this port spells
 * one — see `show`. Python's plain f-string interpolation is `str()` and not
 * `repr()`, and the two differ only for a string: `{x}` is the text itself
 * where `{x!r}` puts quotes around it.
 */
const asText = (value: unknown): string =>
  typeof value === "string" ? value : show(value);

/** Whether a YYYY-MM-DD string names a day that exists, as the oracle asks. */
function isRealDate(text: string): boolean {
  try {
    parseDate(text);
    return true;
  } catch (error) {
    if (error instanceof CalendarError) return false;
    throw error;
  }
}

type Dict = Record<string, unknown>;

/**
 * Where an edge came from, when that is a document rather than a row.
 *
 * The oracle tells the two apart by type — a `Path` for a curated document, a
 * plain string for `<file>:<line>` — and only the first has the repository
 * root stripped off it before it becomes an edge's `_origin`. Collapsing both
 * to a string here would collapse that difference with them, so the one that
 * is a path says so.
 */
interface DocumentPath {
  readonly doc: string;
}

/**
 * The repository root, as the oracle computes it: this module's own file,
 * with symlinks resolved, two directories up.
 *
 * Stripping it keeps a build's edge diagnostics free of wherever the checkout
 * happens to live. The test below is the lexical prefix one `Path.relative_to`
 * runs and deliberately not a normalizing one: a path that reaches the
 * instance through a symlink does not match, and is spelled in full instead —
 * on both sides, for the same reason.
 */
const REPO_ROOT = realpathSync(`${import.meta.dir}/../../..`);

/** `PurePosixPath.anchor` for an absolute path: `//` only when exactly two. */
const anchorOf = (path: string): string =>
  /^\/\/(?!\/)/.test(path) ? "//" : "/";

export function relativeToRoot(path: string): string {
  if (!path.startsWith("/")) return path;
  // `PurePosixPath.parts` leads with the anchor, and `//x` anchors at `//`
  // while `/x` anchors at `/`. Two paths with different anchors are never
  // relative to one another, however much of the rest they share.
  if (anchorOf(path) !== anchorOf(REPO_ROOT)) return path;
  const rootParts = REPO_ROOT.split("/").filter((part) => part !== "");
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < rootParts.length) return path;
  for (let index = 0; index < rootParts.length; index += 1) {
    if (parts[index] !== rootParts[index]) return path;
  }
  const rest = parts.slice(rootParts.length);
  return rest.length === 0 ? "." : rest.join("/");
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** §10.4 kinds a user may delete, so a ref to a missing one only warns. */
const DELETABLE: ReadonlySet<string> = new Set([
  "trail_segment",
  "artifact",
  "encounter",
]);

/** The curated directories, and the node type each one's files declare. */
const CURATED: ReadonlyArray<readonly [string, string]> = [
  ["concepts", "concept"],
  ["zones", "zone"],
  ["patterns", "pattern"],
  ["materials", "material"],
  ["directions", "direction"],
  ["suggested-routes", "suggested_route"],
  ["trails", "trail_segment"],
  ["probes", "probe"],
];

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A payload with its absent fields dropped, in the order they were written.
 *
 * `{k: v for k, v in extra.items() if v is not None}` — and the order is the
 * point as much as the filtering, because these land in the emitted node.
 */
function present(payload: Dict): Dict | null {
  const kept: Dict = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/** `max(filter(None, values), default=None)` over dates. */
function laterOf(...values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    // `filter(None, …)` drops the empty string as well as the absent one,
    // which matters: a date that failed its shape check is still a string.
    if (typeof value !== "string" || value === "") continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/** Every `.md` document in one curated directory, with its body and path. */
export function loadDir(
  reader: AtlasReader,
  curatedPrefix: string,
  subdir: string,
): Array<{ meta: unknown; body: string; path: string; file: ScannedFile }> {
  const directory = curatedPrefix === "" ? subdir : `${curatedPrefix}/${subdir}`;
  const documents: Array<{
    meta: unknown;
    body: string;
    path: string;
    file: ScannedFile;
  }> = [];
  for (const source of reader.scan(directory, { suffix: ".md" })) {
    const path = source.path;
    if (source.name.startsWith("_")) continue;
    const data = source.readBytes();
    documents.push({
      meta: parseFrontmatter(data, path),
      body: frontmatterBody(data),
      path,
      file: source,
    });
  }
  return documents;
}

/** What one build produced, and what it has to say about it. */
export interface BuildResult {
  readonly graph: Dict;
  readonly errors: string[];
  readonly warnings: string[];
}

export function build(curated: string, asOf: string | null = null): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // The instance root is the parent when the argument names the curated
  // directory itself, and the argument otherwise — so both `…/instance` and
  // `…/instance/atlas` mean the same instance and read through one root.
  const { name: leaf, parent } = splitPath(curated);

  let reader: AtlasReader | null = null;
  let curatedPrefix = "";
  try {
    reader = new AtlasReader(leaf === "atlas" ? parent : curated);
    curatedPrefix = leaf === "atlas" ? "atlas" : "";
    if (leaf === "atlas" && !reader.isDirectory(curatedPrefix)) {
      throw new ReaderError(ReasonCode.InvalidRoot);
    }
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    reader = null;
    curatedPrefix = "";
    errors.push(error.message);
  }

  const nodes = new Map<string, Dict>();
  let edges: Dict[] = [];
  const projections = new Map<string, string>();
  const fieldRefs = new Map<string, unknown[]>();
  const segments: Array<{
    id: string;
    origins: string[];
    via: string[];
    path: string;
  }> = [];
  const artifactTouches = new Map<string, Set<string>>();
  const artifactPositions = new Map<string, number>();
  const questionRecords = new Map<string, { source: Dict; pulls: string[] }>();
  const encounterRecords: Array<{
    id: string;
    target: unknown;
    depth: unknown;
    question: unknown;
    artifact: unknown;
    origin: string;
  }> = [];
  const decisionRecords: Array<{
    position: number;
    origin: string;
    row: Dict;
    date: string;
  }> = [];
  // §20.1 decisions survive citations to evidence outside an explicit cut.
  // Keep only the §32.6 class metadata from every dated evidence row so that
  // an omitted node cannot also erase the folded value's taint.
  const evidenceSensitivity = new Map<string, string>();
  const activityDates: string[] = [];
  let skippedDatedInputs = 0;

  // §20.1: the default as-of is the max activity date across journal rows
  // and trail segments; malformed dates never anchor a graph.
  const noteActivity = (value: unknown): void => {
    if (typeof value === "string" && DATE_SHAPE.test(value)) {
      activityDates.push(value);
    }
  };

  // §20.1: an explicit as-of is an inclusive upper bound over every dated
  // input; a skipped input contributes no nodes or derived edges.
  const skipAfterAsOf = (value: string | null): boolean => {
    if (asOf !== null && value !== null && value > asOf) {
      skippedDatedInputs += 1;
      return true;
    }
    return false;
  };

  // §10.4 string payloads fail closed: a container value or a value outside
  // the field's vocabulary is a build ERROR, never an invalid payload in the
  // emitted node.
  const strField = (
    value: unknown,
    origin: string,
    field: string,
    vocabulary?: ReadonlySet<string>,
  ): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      errors.push(`${origin}: ${field} ${show(value)} is not a string`);
      return null;
    }
    if (vocabulary !== undefined && !vocabulary.has(value)) {
      errors.push(
        `${origin}: ${field} ${show(value)} outside the vocabulary ` +
          `${show(sortedByCodePoint([...vocabulary]))}`,
      );
      return null;
    }
    return value;
  };

  // Curated string lists fail closed (§25.8): a scalar value or a non-string
  // item is a build error, never char iteration or an unhashable ref
  // downstream.
  const idList = (
    value: unknown,
    origin: string,
    field: string,
    noun = "id",
  ): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      errors.push(`${origin}: ${field} must be a list of ${noun}s`);
      return [];
    }
    const result: string[] = [];
    for (const item of value) {
      if (typeof item === "string") result.push(item);
      else if (noun !== "id") {
        errors.push(`${origin}: ${field} item ${show(item)} is not a ${noun}`);
      } else {
        errors.push(`${origin}: ${field} item ${show(item)} is not an id`);
      }
    }
    return result;
  };

  // §25.8: a payload ref embeds only in its contract kind and full §10.1
  // shape — a wrong-kind or bare-prefix ref fails the build here, never as a
  // graph the boundary rejects after exit 0.
  const kindedRef = (
    value: unknown,
    origin: string,
    field: string,
    prefixes: ReadonlySet<string>,
    cite: string,
  ): string | null => {
    const text = strField(value, origin, field);
    if (text === null) return null;
    const prefix = text.split(":", 1)[0] as string;
    const shape = prefix === "part" ? PART_ID_RE : NODE_ID_RE;
    if (!prefixes.has(prefix) || !shape.test(text)) {
      errors.push(
        `${origin}: ${field} ${show(text)} is not a ` +
          `${sortedByCodePoint([...prefixes]).join("/")} id (${cite})`,
      );
      return null;
    }
    return text;
  };

  // §9/§10: dated payloads are YYYY-MM-DD — a malformed date fails the build
  // closed instead of emitting a schema-invalid graph or silently dropping
  // the row from the §20.1 as-of universe.
  const dateField = (
    value: unknown,
    origin: string,
    field: string,
  ): string | null => {
    const text = strField(value, origin, field);
    if (text === null) return null;
    if (!DATE_SHAPE.test(text) || !isRealDate(text)) {
      errors.push(
        `${origin}: ${field} is not a valid YYYY-MM-DD date (§9/§10)`,
      );
      return null;
    }
    return text;
  };

  const addNode = (
    nodeId: unknown,
    nodeType: string,
    title: unknown,
    source: string,
    extra?: Dict | null,
  ): void => {
    if (nodeId === undefined || nodeId === null) {
      errors.push(`${source}: record without id`);
      return;
    }
    if (typeof nodeId !== "string") {
      errors.push(`${source}: id ${show(nodeId)} is not a string (§10.1)`);
      return;
    }
    let text = title;
    if (typeof text !== "string") {
      errors.push(
        `${source}: title ${show(title)} on ${nodeId} is not a string`,
      );
      text = "";
    }
    if (nodes.has(nodeId)) {
      errors.push(`${source}: duplicate id ${nodeId}`);
      return;
    }
    if (!NODE_TYPES.has(nodeType)) {
      errors.push(`${source}: node type ${show(nodeType)} outside §10.1 closed set`);
      return;
    }
    if (idType(nodeId) !== nodeType) {
      errors.push(
        `${source}: id ${show(nodeId)} prefix does not match type ` +
          `${show(nodeType)} (§10.1)`,
      );
    }
    const shape = nodeType === "material_part" ? PART_ID_RE : NODE_ID_RE;
    if (!shape.test(nodeId)) {
      errors.push(
        `${source}: id ${show(nodeId)} is not the canonical §10.1 shape ` +
          `(${
            nodeType === "material_part"
              ? "part:material-slug/part-slug"
              : "prefix:kebab-case-slug"
          })`,
      );
    }
    const node: Dict = { id: nodeId, type: nodeType, title: text, _origin: source };
    if (extra) Object.assign(node, extra);
    nodes.set(nodeId, node);
  };

  const addEdge = (
    sourceId: unknown,
    targetId: unknown,
    edgeType: string,
    origin: string | DocumentPath,
    provenance: readonly string[],
    options: { lenient?: boolean; meta?: Dict } = {},
  ): void => {
    // The diagnostic below spells the origin as it arrived; only `_origin`
    // gets the root stripped. That is the oracle's split, not a tidier one.
    const spelled = typeof origin === "string" ? origin : origin.doc;
    // Endpoints must be id strings before any membership or prefix check
    // hashes them — malformed curated refs fail closed (§25.8).
    if (typeof sourceId !== "string" || typeof targetId !== "string") {
      errors.push(
        `${spelled}: ${edgeType} endpoint ${show(sourceId)} -> ` +
          `${show(targetId)} is not an id (§10.2)`,
      );
      return;
    }
    // §10.3: provenance is required on every edge — the direct derivation
    // basis, sorted; the authored species always carry the §14.9 fold value,
    // unassessed when nothing was authored.
    const edge: Dict = {
      source: sourceId,
      target: targetId,
      type: edgeType,
      provenance: sortedByCodePoint(provenance),
    };
    for (const [key, value] of Object.entries(options.meta ?? {})) {
      if (value !== null && value !== undefined) edge[key] = value;
    }
    if (
      (AUTHORED_ROLES.has(edgeType) || edgeType === "supports") &&
      !("weight" in edge)
    ) {
      edge["weight"] = "unassessed";
    }
    if (options.lenient === true) {
      // §20 step 11 origin rule: a journal- or segment-derived edge
      // downgrades broken refs and off-matrix kinds to warnings — deletion
      // is the owner's right (§5.2, §34.2).
      edge["_lenient"] = true;
    }
    edge["_origin"] =
      typeof origin === "string" ? origin : relativeToRoot(origin.doc);
    edges.push(edge);
  };

  // One authored-edge species (§9.1/§9.3/§32.1): concepts, material parts,
  // and body patterns alike; weight is the §14.9 closed scale.
  const addConceptEdges = (
    ownerId: string,
    ownerKind: string,
    entries: unknown,
    path: string,
  ): string[] => {
    const targets: string[] = [];
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
      errors.push(
        `${path}: concept_edges on ${ownerId} must be a list of edge ` +
          `mappings (§9.3)`,
      );
      return targets;
    }
    const list = Array.isArray(entries) ? entries : [];
    list.forEach((ce, index) => {
      if (!isDict(ce)) {
        errors.push(
          `${path}: concept_edges item ${show(ce)} on ${ownerId} is not an ` +
            `edge mapping (§9.3)`,
        );
        return;
      }
      const weight = ce["weight"];
      if (
        weight !== undefined &&
        weight !== null &&
        (typeof weight !== "string" || !EDGE_WEIGHTS.has(weight))
      ) {
        errors.push(
          `${path}: weight ${show(weight)} on ${ownerId} -> ` +
            `${asText(ce["to"])} outside the §14.9 scale`,
        );
        return;
      }
      const role = ce["role"];
      if (typeof role !== "string" || !AUTHORED_ROLES.has(role)) {
        errors.push(
          `${path}: role ${show(role)} on ${ownerId} -> ${asText(ce["to"])} ` +
            `is not an authored relationship role (§9.3/§32.1)`,
        );
        return;
      }
      // §10.2 (#31): role legality is per author kind — the matrix is
      // normative, ENDPOINT_RULES transcribes it.
      const rule = ENDPOINT_RULES.get(role) as readonly [
        ReadonlySet<string>,
        ReadonlySet<string>,
      ];
      if (!rule[0].has(ownerKind)) {
        errors.push(
          `${path}: role ${role} on ${ownerId} -> ${asText(ce["to"])} is ` +
            `not authorable from a ${ownerKind} source (§10.2)`,
        );
        return;
      }
      let alternativeIn: string[] | null = null;
      if ("alternative_in" in ce) {
        const pointer = `concept_edges[${index}].alternative_in`;
        if (role !== "alternative_to") {
          errors.push(
            `${path}: ${pointer} is legal only for role alternative_to (§10.3)`,
          );
          return;
        }
        alternativeIn = [];
        for (const value of idList(ce["alternative_in"], path, pointer)) {
          const ref = kindedRef(
            value,
            path,
            pointer,
            new Set(["concept", "pattern"]),
            "§10.3",
          );
          if (ref !== null) alternativeIn.push(ref);
        }
      }
      addEdge(ownerId, ce["to"], role, { doc: path }, [ownerId], {
        meta: { weight: weight ?? null, alternative_in: alternativeIn },
      });
      if (typeof ce["to"] === "string") targets.push(ce["to"]);
    });
    return targets;
  };

  // §9.14: helper -> receiver; endpoint kinds enforced by ENDPOINT_RULES.
  // Authored on the receiving side — the receiver is the authoring node.
  const addSupports = (ownerId: string, entries: unknown, path: string): void => {
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
      errors.push(
        `${path}: supported_by on ${ownerId} must be a list of entries (§9.14)`,
      );
      return;
    }
    for (const helper of Array.isArray(entries) ? entries : []) {
      let helperId: unknown;
      let note: string | null = null;
      if (isDict(helper)) {
        helperId = helper["id"];
        if (helperId === undefined || helperId === null) {
          errors.push(
            `${path}: supported_by entry on ${ownerId} has no id (§9.14)`,
          );
          continue;
        }
        note = strField(
          helper["note"],
          path,
          `supported_by note on ${ownerId}`,
        );
      } else if (typeof helper === "string") {
        helperId = helper;
      } else {
        errors.push(
          `${path}: supported_by entry ${show(helper)} on ${ownerId} is not ` +
            `an id or mapping (§9.14)`,
        );
        continue;
      }
      addEdge(helperId, ownerId, "supports", { doc: path }, [ownerId], {
        meta: { note },
      });
    }
  };

  // §20 steps 1-2, 4-5: curated kinds. Zones/patterns dirs are read the same
  // way and are simply empty until the body domain lands (§32).
  for (const [subdir, expected] of CURATED) {
    let documents: ReturnType<typeof loadDir> = [];
    try {
      documents = reader !== null ? loadDir(reader, curatedPrefix, subdir) : [];
    } catch (error) {
      if (!(error instanceof ReaderError)) throw error;
      errors.push(error.message);
      documents = [];
    }
    for (const document of documents) {
      const path = document.path;
      const body = document.body;
      const meta: Dict = isDict(document.meta) ? document.meta : {};
      let segmentDate: string | null = null;
      if (expected === "trail_segment") {
        // §20.1: read and validate the segment date first; a segment beyond
        // an explicit cut is skipped whole before other fields.
        segmentDate = dateField(meta["date"], path, "date");
        if (skipAfterAsOf(segmentDate)) continue;
        noteActivity(segmentDate);
      }
      const declared = "type" in meta ? meta["type"] : expected;
      if (
        declared !== expected &&
        !(subdir === "suggested-routes" && declared === "suggested_route")
      ) {
        errors.push(
          `${path}: type ${show(declared)}, expected ${show(expected)}`,
        );
        continue;
      }
      // Authored lifecycle travels with the node: the viewer reads
      // atlas-graph.json and nothing else (§16.4), so a hidden route must be
      // distinguishable from an available one in the output.
      let status = meta["status"] ?? null;
      if (status !== null && typeof status !== "string") {
        errors.push(
          `${path}: status ${show(status)} is not a string (§9.2/§9.4/§9.11)`,
        );
        status = null;
      }
      if (
        status !== null &&
        (expected === "concept" ||
          expected === "zone" ||
          expected === "pattern" ||
          expected === "trail_segment")
      ) {
        // §9.1/§32.1: concept-kind files carry identity, links, and content
        // only — every state dimension is derived (§31.8); §10.4 embeds no
        // lifecycle on a trail segment either.
        errors.push(
          `${path}: ${expected} files do not author status ` +
            `(state is derived, §9.1)`,
        );
        status = null;
      } else if (
        status !== null &&
        expected !== "suggested_route" &&
        !LIFECYCLE_STATUSES.has(status as string)
      ) {
        errors.push(
          `${path}: status ${show(status)} outside the §9.2/§9.11 lifecycle ` +
            `vocabulary (active|archived)`,
        );
      }
      // §10.4: the per-kind payload embedded beyond id/type/title/fields;
      // formerly and sensitivity travel wherever persisted.
      const extra: Dict = status ? { status } : {};
      if (meta["formerly"] !== undefined && meta["formerly"] !== null) {
        if (expected === "trail_segment") {
          // §34.4: journal record ids get no redirect machinery —
          // hand-editing the row is the owner's mechanism (§5.2).
          errors.push(
            `${path}: trail segment records get no formerly redirect (§34.4)`,
          );
        } else {
          extra["formerly"] = meta["formerly"];
        }
      }
      const sensitivity = strField(
        meta["sensitivity"],
        path,
        "sensitivity",
        SENSITIVITY_CLASSES,
      );
      if (sensitivity !== null) extra["sensitivity"] = sensitivity;
      if (expected === "concept" || expected === "pattern") {
        // §10.4: aliases embed as an array of strings — gate the authored
        // shape before it reaches the emitted node.
        extra["aliases"] = idList(meta["aliases"], path, "aliases", "string");
      }
      if (expected === "zone") extra["notes"] = body; // care notes (§32.2)
      if (expected === "material") {
        const kind = meta["kind"] ?? null;
        if (
          kind !== null &&
          (typeof kind !== "string" || !MATERIAL_KINDS.has(kind))
        ) {
          errors.push(
            `${path}: material kind ${show(kind)} outside the §9.2 vocabulary`,
          );
        }
        extra["kind"] = kind;
        extra["url"] = strField(meta["url"], path, "url");
      }
      if (expected === "direction") {
        extra["attractor"] = strField(meta["attractor"], path, "attractor");
        const stableWhile = strField(
          meta["stable_while"],
          path,
          "stable_while",
        );
        if (stableWhile !== null) extra["stable_while"] = stableWhile;
      }
      if (expected === "suggested_route" || expected === "probe") {
        let sourcePlan = strField(meta["source_plan"], path, "source_plan");
        if (
          sourcePlan !== null &&
          !(sourcePlan.startsWith("plan:") && NODE_ID_RE.test(sourcePlan))
        ) {
          errors.push(
            `${path}: source_plan ${show(sourcePlan)} is not a plan id ` +
              `(§9.4/§10.4)`,
          );
          sourcePlan = null;
        }
        if (sourcePlan !== null) extra["source_plan"] = sourcePlan;
      }
      if (expected === "probe") extra["body"] = body; // the check itself (§9.11)

      let trailOrigins: string[] = [];
      let trailVia: string[] = [];
      if (expected === "trail_segment") {
        // §9.9 (#31): the record payload and its typed edges are two faces of
        // one record (§10.4) — embed the row verbatim.
        let originRef = meta["from"] ?? null;
        let rawOrigins: string[] = [];
        if (Array.isArray(originRef)) {
          rawOrigins = idList(originRef, path, "from");
        } else if (originRef === null || typeof originRef === "string") {
          rawOrigins = originRef ? [originRef as string] : [];
        } else {
          errors.push(
            `${path}: from ${show(originRef)} is not an id or list of ids (§9.9)`,
          );
          originRef = null;
          rawOrigins = [];
        }
        // §9.9: movement origins are concept-kind ids.
        for (const ref of rawOrigins) {
          const resolved = kindedRef(
            ref,
            path,
            "from",
            new Set(["concept", "pattern"]),
            "§9.9",
          );
          if (resolved !== null) trailOrigins.push(resolved);
        }
        // §9.9/§10.4: via holds material(part) and artifact ids only — an
        // off-kind or malformed id must fail before it is embedded, not
        // merely lose its derived edge in the lenient pass.
        for (const ref of idList(meta["via"], path, "via")) {
          const resolved = kindedRef(
            ref,
            path,
            "via",
            new Set(["material", "part", "artifact"]),
            "§9.9/§10.4",
          );
          if (resolved !== null) trailVia.push(resolved);
        }
        extra["date"] = segmentDate;
        extra["direction"] = kindedRef(
          meta["direction"],
          path,
          "direction",
          new Set(["direction"]),
          "§9.9/§10.4",
        );
        extra["to"] = kindedRef(
          meta["to"],
          path,
          "to",
          new Set(["concept", "pattern"]),
          "§9.9/§10.4",
        );
        extra["via"] = trailVia;
        extra["reason"] = strField(meta["reason"], path, "reason");
        if (typeof originRef === "string" && trailOrigins.length > 0) {
          extra["from"] = originRef;
        } else if (Array.isArray(originRef)) {
          extra["from"] = trailOrigins;
        }
        if (
          meta["resulting_questions"] !== undefined &&
          meta["resulting_questions"] !== null
        ) {
          const resulting: string[] = [];
          for (const ref of idList(
            meta["resulting_questions"],
            path,
            "resulting_questions",
          )) {
            const resolved = kindedRef(
              ref,
              path,
              "resulting_questions",
              new Set(["question"]),
              "§9.9/§10.4",
            );
            if (resolved !== null) resulting.push(resolved);
          }
          extra["resulting_questions"] = resulting;
        }
      }
      // §10.4/§25.7: these authored payload fields are required on the
      // emitted node — a missing one fails the build here rather than
      // emitting a graph the boundary validator rejects.
      const REQUIRED: Readonly<Record<string, readonly string[]>> = {
        material: ["kind", "url", "status"],
        direction: ["attractor", "status"],
        trail_segment: ["date", "direction", "to", "via", "reason"],
        probe: ["status"],
      };
      for (const field of REQUIRED[expected] ?? []) {
        if (meta[field] === undefined || meta[field] === null) {
          errors.push(`${path}: ${expected} requires ${field} (§10.4)`);
        }
      }
      const payload: Dict = {};
      for (const [key, value] of Object.entries(extra)) {
        if (value !== null && value !== undefined) payload[key] = value;
      }
      addNode(
        meta["id"],
        expected,
        "title" in meta ? meta["title"] : "",
        path,
        Object.keys(payload).length > 0 ? payload : null,
      );
      const nodeId = meta["id"];
      if (typeof nodeId !== "string") continue; // addNode recorded the shape

      if (expected === "concept") {
        // §9.1 (#31): concepts are the authored species' third author;
        // related_concepts stays sugar for role: related_to with no weight.
        addConceptEdges(nodeId, "concept", meta["concept_edges"], path);
        for (const rel of idList(
          meta["related_concepts"],
          path,
          "related_concepts",
        )) {
          addEdge(nodeId, rel, "related_to", { doc: path }, [nodeId]);
        }
      }

      if (expected === "pattern") {
        // §32.1: a pattern authors its loads/etc. edges as a part authors
        // concept_edges — same species, same gated weight.
        addConceptEdges(nodeId, "pattern", meta["concept_edges"], path);
      }

      if (expected === "trail_segment") {
        // §10.2: one moved_to per from-origin -> to; material(part) via
        // entries derive via, artifact entries produced_artifact. Segment-
        // derived edges are lenient — deletion elsewhere downgrades them,
        // never fails the trail (§5.2, §34.2).
        const destination = payload["to"];
        if (typeof destination === "string") {
          for (const originId of trailOrigins) {
            addEdge(originId, destination, "moved_to", { doc: path }, [nodeId], {
              lenient: true,
            });
          }
        }
        for (const ref of trailVia) {
          const edgeKind = ref.startsWith("artifact:")
            ? "produced_artifact"
            : "via";
          addEdge(nodeId, ref, edgeKind, { doc: path }, [nodeId], { lenient: true });
        }
        fieldRefs.set(nodeId, [
          ...trailOrigins,
          ...(typeof destination === "string" ? [destination] : []),
        ]);
        segments.push({ id: nodeId, origins: trailOrigins, via: trailVia, path });
      }

      if (expected === "zone") {
        // §20 step 12: the silhouette mapping rides in the graph so the
        // viewer's single input stays single (§16.4); every zone authors its
        // figure_region (§32.1) — a zone the silhouette cannot place never
        // leaves the build.
        const figureRegion = meta["figure_region"] ?? null;
        if (figureRegion === null) {
          errors.push(`${path}: zone requires figure_region (§32.1)`);
        } else if (
          typeof figureRegion !== "string" ||
          !SLUG_RE.test(figureRegion)
        ) {
          errors.push(
            `${path}: figure_region ${show(figureRegion)} is not a slug (§32.1)`,
          );
        } else {
          projections.set(nodeId, figureRegion);
        }
      }

      if (expected === "probe") {
        // §9.11/§20 step 7: a probe targets concepts; the reference loop
        // validates them, the edge is the §10.2 probed_by.
        const probeConcepts = idList(meta["concepts"], path, "concepts");
        for (const concept of probeConcepts) {
          addEdge(concept, nodeId, "probed_by", { doc: path }, [nodeId]);
        }
        fieldRefs.set(nodeId, [...probeConcepts]);
      }

      if (expected === "material") {
        const overall = idList(
          meta["overall_concepts"],
          path,
          "overall_concepts",
        );
        for (const concept of overall) {
          addEdge(nodeId, concept, "overall_concept", { doc: path }, [nodeId]);
        }
        addSupports(nodeId, meta["supported_by"], path);
        const refs: unknown[] = [...overall];
        fieldRefs.set(nodeId, refs);
        // §20 step 3: expand MaterialPart nodes. addNode has already
        // recorded the shape error for a malformed id; don't let the slug
        // derivation crash on it.
        const materialSlug = nodeId.includes(":")
          ? nodeId.slice(nodeId.indexOf(":") + 1)
          : null;
        let parts = meta["parts"] ?? null;
        if (parts !== null && !Array.isArray(parts)) {
          errors.push(`${path}: parts must be a list (§9.3)`);
          parts = [];
        }
        for (const part of Array.isArray(parts) ? parts : []) {
          if (!isDict(part)) {
            errors.push(
              `${path}: parts item ${show(part)} is not a MaterialPart ` +
                `mapping (§9.3)`,
            );
            continue;
          }
          const partId = part["id"];
          // §10.4/§34.4: formerly travels wherever the id is persisted — a
          // part rename keeps its redirects.
          const partExtra: Dict = { material: nodeId };
          if (sensitivity !== null) {
            // §32.6: taint is union by provenance — the part is derived from
            // this classed curated file, so it carries the class (and
            // everything citing it unions through the node, via included).
            partExtra["sensitivity"] = sensitivity;
          }
          if (part["formerly"] !== undefined && part["formerly"] !== null) {
            partExtra["formerly"] = part["formerly"];
          }
          addNode(
            partId,
            "material_part",
            "title" in part ? part["title"] : "",
            path,
            partExtra,
          );
          if (typeof partId !== "string") continue;
          if (materialSlug && !partId.startsWith(`part:${materialSlug}/`)) {
            errors.push(
              `${path}: part id ${show(partId)} does not carry its ` +
                `material's slug ${show(materialSlug)} (§10.1)`,
            );
          }
          addEdge(nodeId, partId, "has_part", { doc: path }, [nodeId]);
          // §10.4: a part's fields come from its concept_edges targets; the
          // material unions its parts' fields.
          fieldRefs.set(
            partId,
            addConceptEdges(
              partId,
              "material_part",
              part["concept_edges"],
              path,
            ),
          );
          addSupports(partId, part["supported_by"], path);
          refs.push(partId);
        }
      }

      if (expected === "direction") {
        const core = idList(meta["core_concepts"], path, "core_concepts");
        for (const concept of core) {
          addEdge(concept, nodeId, "part_of_direction", { doc: path }, [nodeId]);
        }
        fieldRefs.set(nodeId, [...core]);
      }

      if (expected === "suggested_route") {
        let routeStatus = meta["status"] ?? null;
        if (routeStatus !== null && typeof routeStatus !== "string") {
          routeStatus = null; // the string gate above recorded the error
        }
        if (
          typeof routeStatus === "string" &&
          FORBIDDEN_ROUTE_STATUSES.has(routeStatus)
        ) {
          errors.push(
            `${path}: route status ${show(routeStatus)} is a §9.4 forbidden ` +
              `task-state`,
          );
        } else if (
          routeStatus === null ||
          typeof routeStatus !== "string" ||
          !ROUTE_STATUSES.has(routeStatus)
        ) {
          errors.push(
            `${path}: route status ${show(routeStatus)} outside §9.4 vocabulary`,
          );
        }
        let rawSteps = meta["steps"] ?? null;
        if (rawSteps !== null && !Array.isArray(rawSteps)) {
          errors.push(`${path}: steps must be a list of ids (§9.4)`);
          rawSteps = [];
        }
        for (const item of Array.isArray(rawSteps) ? rawSteps : []) {
          if (typeof item !== "string") {
            errors.push(`${path}: steps item ${show(item)} is not an id (§9.4)`);
          }
        }
        const steps = (Array.isArray(rawSteps) ? rawSteps : []).filter(
          (item): item is string => typeof item === "string",
        );
        steps.forEach((step, index) => {
          addEdge(step, nodeId, "step_of_route", { doc: path }, [nodeId], {
            meta: { order: index + 1 },
          });
        });
        // §10.2: consecutive steps of one route derive suggested_next,
        // context = the route id (part of edge identity, §10.3).
        for (let index = 0; index + 1 < steps.length; index += 1) {
          addEdge(
            steps[index] as string,
            steps[index + 1] as string,
            "suggested_next",
            { doc: path },
            [nodeId],
            { meta: { context: nodeId } },
          );
        }
        fieldRefs.set(nodeId, [...steps]);
        // §11.1: the authored route context emits material(part) → route
        // edges carrying step metadata; per step the two lists are disjoint
        // (§9.4 — a §20.3 conflict otherwise).
        let roles = meta["material_roles"] ?? null;
        if (roles !== null && !Array.isArray(roles)) {
          errors.push(
            `${path}: material_roles must be a list of role mappings (§9.4)`,
          );
          roles = [];
        }
        for (const role of Array.isArray(roles) ? roles : []) {
          if (!isDict(role)) {
            errors.push(
              `${path}: material_roles item ${show(role)} is not a role ` +
                `mapping (§9.4)`,
            );
            continue;
          }
          const step = role["step"] ?? null;
          if (step !== null && typeof step !== "string") {
            errors.push(
              `${path}: material_roles step ${show(step)} is not an id (§9.4)`,
            );
            continue;
          }
          // Membership and disjointness are checked post-pass on
          // §34.4-resolved ids — a stale spelling must resolve, not fail
          // (§34.4). Fail closed on non-string items before set math and
          // edge emission — a schema-invalid role list must error, never
          // traceback or emit a malformed endpoint.
          const roleIds = (key: string): string[] => {
            const items = role[key] ?? null;
            if (items === null) return [];
            if (!Array.isArray(items)) {
              errors.push(
                `${path}: material_roles ${key} must be a list of material ` +
                  `ids (§9.4)`,
              );
              return [];
            }
            const ids: string[] = [];
            for (const item of items) {
              if (typeof item === "string") ids.push(item);
              else {
                errors.push(
                  `${path}: material_roles ${key} item ${show(item)} is not ` +
                    `a material id (§9.4)`,
                );
              }
            }
            return ids;
          };
          const pairs: Array<readonly [string, string]> = [
            ...roleIds("primary_materials").map(
              (material) => [material, "primary_for"] as const,
            ),
            ...roleIds("supporting_materials").map(
              (material) => [material, "supporting_for"] as const,
            ),
          ];
          for (const [material, roleType] of pairs) {
            addEdge(material, nodeId, roleType, { doc: path }, [nodeId], {
              meta: { step },
            });
          }
        }
        if (meta["source_plan"]) {
          warnings.push(
            `${path}: source_plan ${show(meta["source_plan"])} embedded; ` +
              `plan nodes are not emitted until the §12 importer lands, so ` +
              `the ref dangles in this build (§20 step 5)`,
          );
        }
      }
    }
  }

  // §20 step 8 (#31): artifact, encounter, and question rows become nodes
  // plus their §10.2 derived edges; decisions feed step 9 without becoming
  // nodes. Every projected or folded row obeys §20.1's as-of bound.
  interface JournalRecord {
    readonly origin: string;
    readonly row: Dict;
    readonly date: string | null;
  }

  function* journalRows(stem: string, dateKey: string): Generator<JournalRecord> {
    if (reader === null) return;
    const paths: ScannedFile[] = [];
    try {
      // §8/§20.1: rotation moves old rows OUT of the direct file, so the
      // per-year files are the older half of the concatenation
      // (lexicographic among themselves) and state/<stem>.jsonl is its
      // newest tail — the rank atlas_io already gives receipts. §20.1 counts
      // position through that order, so a same-day tie on one target and
      // dimension resolves to the row appended last.
      paths.push(...reader.scan(`state/${stem}`, { suffix: ".jsonl" }));
      const direct = reader.optionalFile(`state/${stem}.jsonl`);
      if (direct !== null) paths.push(direct);
    } catch (error) {
      if (!(error instanceof ReaderError)) throw error;
      errors.push(error.message);
      return;
    }
    // §20.1: the rotated files' lexicographic concatenation IS the journal —
    // duplicate detection spans it, not each file.
    const seenRows = new Set<string>();
    for (const path of paths) {
      try {
        for (const line of builderJournalLines(path)) {
          const number = line.number;
          const raw = line.raw;
          if (line.oversized) {
            // §25.8: the boundary reader enforces the same ceiling — an
            // oversize row must never project.
            errors.push(
              `${path.path}:${number}: journal row exceeds ` +
                `${JOURNAL_ROW_BYTES} bytes`,
            );
            continue;
          }
          if (raw.length === 0) {
            errors.push(`${path.path}:${number}: blank journal row`);
            continue;
          }
          // Byte identity, not text: `latin1` through a Buffer is the one
          // decoding that round-trips every octet, so two rows are the same
          // key exactly when they are the same bytes.
          const key = Buffer.from(raw).toString("latin1");
          if (seenRows.has(key)) {
            // §20.1: a byte-identical row repeated within a journal folds
            // once, with a WARNING.
            warnings.push(
              `${path.path}:${number}: byte-identical duplicate row folded ` +
                `once (§20.1)`,
            );
            continue;
          }
          seenRows.add(key);
          if (raw.includes(0x0d)) {
            // §25.7: LF-only, same as the boundary reader.
            errors.push(
              `${path.path}:${number}: CR/CRLF is unsupported; use LF`,
            );
            continue;
          }
          let row: unknown;
          try {
            row = parseStrict(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
          } catch (error) {
            // The oracle splits this two ways: malformed text is a
            // `JSONDecodeError` and reads as a bad row, while a duplicate key
            // or a non-finite number is a `JsonDisciplineError` and reads as
            // itself. The port has one class for both, and says which it is by
            // carrying the line the parse stopped on — see the note on
            // `JsonDisciplineError.line`. A row that is not UTF-8 at all lands
            // here too, on the same side as malformed text.
            if (error instanceof JsonDisciplineError && error.line === undefined) {
              errors.push(`${path.path}:${number}: ${error.message}`);
              continue;
            }
            errors.push(`${path.path}:${number}: invalid JSONL row`);
            continue;
          }
          if (!isDict(row)) {
            errors.push(`${path.path}:${number}: journal row is not an object`);
            continue;
          }
          const origin = `${path.path}:${number}`;
          // §20.1: the dated field is the first row field read. A row beyond
          // an explicit cut is skipped whole, without unrelated schema
          // diagnostics or any projection. Sensitivity is the one metadata
          // exception: an in-cut decision may still cite this row, so
          // §32.6's provenance union must survive the projection cut.
          const rowDate = dateField(row[dateKey], origin, dateKey);
          if (stem === "artifacts" || stem === "encounters" || stem === "questions") {
            const evidenceId = row["id"];
            const sensitivity = row["sensitivity"];
            const expectedType = stem.slice(0, -1);
            if (
              typeof evidenceId === "string" &&
              NODE_ID_RE.test(evidenceId) &&
              idType(evidenceId) === expectedType &&
              typeof sensitivity === "string" &&
              SENSITIVITY_CLASSES.has(sensitivity)
            ) {
              evidenceSensitivity.set(evidenceId, sensitivity);
            }
          }
          if (skipAfterAsOf(rowDate)) continue;
          const nulls = sortedByCodePoint(
            Object.entries(row)
              .filter(([, value]) => value === null)
              .map(([name]) => name),
          );
          if (nulls.length > 0) {
            // §25.7: no journal schema admits null anywhere — an explicit
            // null must fail closed, never collapse to an absent optional
            // field.
            errors.push(
              `${path.path}:${number}: null journal value(s) for ` +
                `${nulls.join(", ")} (§25.7)`,
            );
            continue;
          }
          const intake = row["intake"];
          if (
            intake !== undefined &&
            intake !== null &&
            (typeof intake !== "string" || !INTAKE_KEY_RE.test(intake))
          ) {
            // §25.7: a present-but-malformed intake provenance fails closed
            // like every other schema-shaped field.
            errors.push(
              `${path.path}:${number}: intake ${show(intake)} is not an ` +
                `intake key (§33.2)`,
            );
            continue;
          }
          const allowed = JOURNAL_ROW_KEYS.get(stem) as ReadonlySet<string>;
          const unknown = Object.keys(row).filter((name) => !allowed.has(name));
          if (unknown.length > 0) {
            // The schema closes the key set — an unknown key is a malformed
            // row, never silently ignored content.
            errors.push(
              `${path.path}:${number}: unknown journal key(s) ` +
                `${sortedByCodePoint(unknown).join(", ")} (§25.7)`,
            );
            continue;
          }
          noteActivity(rowDate);
          yield { origin, row, date: rowDate };
        }
      } catch (error) {
        // The builder's row reader raises exactly one thing — the reader
        // refusing to open the file — and the rest of the journal's files are
        // still read. Anything else is not this pass's to answer for.
        if (!(error instanceof ReaderError)) throw error;
        errors.push(error.message);
        continue;
      }
    }
  }

  let position = 0;
  for (const record of journalRows("artifacts", "observed_at")) {
    position += 1;
    const { origin, row, date: rowDate } = record;
    // §9.6/§10.4: the authored type: embeds as kind (type is §10.1's).
    const touches: string[] = [];
    for (const ref of idList(row["touches"], origin, "touches")) {
      const resolved = kindedRef(ref, origin, "touches", REGION_PREFIXES, "§9.6");
      if (resolved !== null) touches.push(resolved);
    }
    const supportsUpdates: string[] = [];
    for (const ref of idList(
      row["supports_state_updates"],
      origin,
      "supports_state_updates",
    )) {
      const resolved = kindedRef(
        ref,
        origin,
        "supports_state_updates",
        REGION_PREFIXES,
        "§9.6",
      );
      if (resolved !== null) supportsUpdates.push(resolved);
    }
    const extra: Dict = {
      kind: strField(row["type"], origin, "type"),
      path: strField(row["path"], origin, "path"),
      observed_at: rowDate,
      summary: strField(row["summary"], origin, "summary"),
      evidence_strength: strField(
        row["evidence_strength"],
        origin,
        "evidence_strength",
        EVIDENCE_STRENGTHS,
      ),
      probe: kindedRef(row["probe"], origin, "probe", new Set(["probe"]), "§9.6/§10.4"),
      sensitivity: strField(
        row["sensitivity"],
        origin,
        "sensitivity",
        SENSITIVITY_CLASSES,
      ),
    };
    for (const field of [
      "kind",
      "path",
      "observed_at",
      "summary",
      "evidence_strength",
    ]) {
      const key = field === "kind" ? "type" : field;
      if (row[key] === undefined || row[key] === null) {
        errors.push(`${origin}: artifact row requires ${key} (§9.6/§10.4)`);
      }
    }
    addNode(row["id"], "artifact", "", origin, present(extra));
    const aid = row["id"];
    if (typeof aid !== "string") continue;
    artifactPositions.set(aid, position);
    for (const field of ["touches", "supports_state_updates"]) {
      // §9.6: both relation arrays are required on every evidence row — an
      // absent one is a malformed row, never an artifact silently projected
      // as touching nothing.
      if (row[field] === undefined || row[field] === null) {
        errors.push(`${origin}: artifact row requires ${field} (§9.6)`);
      }
    }
    artifactTouches.set(aid, new Set(touches));
    for (const target of touches) {
      addEdge(aid, target, "influences", origin, [aid], { lenient: true });
    }
    for (const target of supportsUpdates) {
      addEdge(aid, target, "updates_state", origin, [aid], { lenient: true });
    }
    fieldRefs.set(aid, [...touches, ...supportsUpdates]);
  }

  for (const { origin, row, date: rowDate } of journalRows("encounters", "date")) {
    // §9.7/§10.4: the journal row embeds whole — date, target, depth, mode,
    // context — and derives the visited edge.
    let context = row["context"] ?? null;
    if (
      context !== null &&
      (!isDict(context) ||
        Object.keys(context).length === 0 ||
        Object.entries(context).some(
          ([key, value]) =>
            (key !== "question" && key !== "artifact") ||
            typeof value !== "string" ||
            value.split(":", 1)[0] !== key ||
            !NODE_ID_RE.test(value),
        ))
    ) {
      // Fail closed (§25.8): a malformed context silently dropped would
      // silently change the §11.2 derivation.
      errors.push(`${origin}: context ${show(context)} is not a §9.7 context object`);
      context = null;
    }
    const extra: Dict = {
      date: rowDate,
      target: kindedRef(
        row["target"],
        origin,
        "target",
        new Set(["material", "part"]),
        "§9.7/§10.4",
      ),
      depth: strField(row["depth"], origin, "depth", ENCOUNTER_DEPTHS),
      mode: strField(row["mode"], origin, "mode", ENCOUNTER_MODES),
      context,
      sensitivity: strField(
        row["sensitivity"],
        origin,
        "sensitivity",
        SENSITIVITY_CLASSES,
      ),
    };
    for (const field of ["date", "target", "depth", "mode"]) {
      if (row[field] === undefined || row[field] === null) {
        errors.push(`${origin}: encounter row requires ${field} (§9.7/§10.4)`);
      }
    }
    addNode(row["id"], "encounter", "", origin, present(extra));
    const eid = row["id"];
    if (typeof eid !== "string") continue;
    if (typeof extra["target"] === "string") {
      addEdge(eid, extra["target"], "visited", origin, [eid], { lenient: true });
      fieldRefs.set(eid, [extra["target"]]);
    }
    const ctx = isDict(context) ? context : {};
    encounterRecords.push({
      id: eid,
      target: extra["target"],
      depth: extra["depth"],
      question: ctx["question"],
      artifact: ctx["artifact"],
      origin,
    });
  }

  for (const { origin, row, date: rowDate } of journalRows("questions", "created_at")) {
    // §9.8/§10.4: text, created_at, source embed; pulls derive the pulled_by
    // edges; status is derived, never stored (§31.8).
    const pulls: string[] = [];
    for (const ref of idList(row["pulls"], origin, "pulls")) {
      const resolved = kindedRef(ref, origin, "pulls", REGION_PREFIXES, "§9.8");
      if (resolved !== null) pulls.push(resolved);
    }
    let sourceRef = row["source"] ?? null;
    if (
      sourceRef !== null &&
      (!isDict(sourceRef) ||
        Object.keys(sourceRef).length === 0 ||
        Object.entries(sourceRef).some(
          ([key, value]) =>
            (key !== "artifact" && key !== "encounter") ||
            typeof value !== "string" ||
            value.split(":", 1)[0] !== key ||
            !NODE_ID_RE.test(value),
        ))
    ) {
      // Fail closed (§25.8): a present-but-malformed source must be a build
      // error, never a question node emitted without its §10.4-required
      // provenance.
      errors.push(`${origin}: source ${show(sourceRef)} is not a §9.8 source object`);
      sourceRef = null;
    }
    const extra: Dict = {
      text: strField(row["text"], origin, "text"),
      created_at: rowDate,
      source: sourceRef,
      sensitivity: strField(
        row["sensitivity"],
        origin,
        "sensitivity",
        SENSITIVITY_CLASSES,
      ),
    };
    for (const field of ["text", "created_at", "source"]) {
      if (row[field] === undefined || row[field] === null) {
        errors.push(`${origin}: question row requires ${field} (§9.8/§10.4)`);
      }
    }
    if (row["pulls"] === undefined || row["pulls"] === null) {
      // §9.8: pulls is required — a question that pulls nothing is a
      // malformed row, not an empty-field node.
      errors.push(`${origin}: question row requires pulls (§9.8)`);
    }
    if (row["type"] !== "question") {
      // §9.8: type is the schema's fixed discriminant — an off-type row must
      // never project as a question node.
      errors.push(`${origin}: question row requires type "question" (§9.8)`);
    }
    addNode(row["id"], "question", "", origin, present(extra));
    const qid = row["id"];
    if (typeof qid !== "string") continue;
    questionRecords.set(qid, {
      source: isDict(sourceRef) ? sourceRef : {},
      pulls,
    });
    for (const region of pulls) {
      addEdge(region, qid, "pulled_by", origin, [qid], { lenient: true });
    }
    fieldRefs.set(qid, [...pulls]);
  }

  const validNodeRef = (value: unknown, prefixes: ReadonlySet<string>): boolean => {
    if (typeof value !== "string") return false;
    const prefix = value.split(":", 1)[0] as string;
    const shape = prefix === "part" ? PART_ID_RE : NODE_ID_RE;
    return prefixes.has(prefix) && shape.test(value);
  };

  let decisionPosition = 0;
  for (const { origin, row, date: rowDate } of journalRows("decisions", "date")) {
    decisionPosition += 1;
    // §9.13: diagnostics name the row and field expectation without echoing
    // rejected content (§24.4).
    const REQUIRED_DECISION = [
      "date",
      "target",
      "dimension",
      "to",
      "evidence",
      "proposed_by",
      "decision",
    ];
    const missing = REQUIRED_DECISION.filter((field) => !(field in row));
    for (const field of missing) {
      errors.push(`${origin}: decision row requires ${field} (§9.13)`);
    }
    const dimension = row["dimension"];
    let valid = missing.length === 0;
    // isinstance first: a persisted row can carry an unhashable /dimension,
    // and set membership on one raises instead of reporting the ordinary
    // prefixed diagnostic (§24.4).
    if (
      typeof dimension !== "string" ||
      (!DECISION_VALUES.has(dimension) && !DEFERRED_DIMENSIONS.has(dimension))
    ) {
      errors.push(`${origin}: /dimension must name a §9.13 StateDecision dimension`);
      valid = false;
    } else if (DEFERRED_DIMENSIONS.has(dimension)) {
      errors.push(
        `${origin}: /dimension ${dimension} is ${DEFERRED_DIMENSIONS.get(dimension)}`,
      );
      valid = false;
    }
    const target = row["target"];
    if (
      typeof dimension === "string" &&
      DECISION_VALUES.has(dimension) &&
      !DEFERRED_DIMENSIONS.has(dimension)
    ) {
      const targetValid = validNodeRef(
        target,
        DECISION_TARGET_PREFIXES.get(dimension) as ReadonlySet<string>,
      );
      if (!targetValid) {
        errors.push(`${origin}: /target must match the ${dimension} target kind (§9.13)`);
        valid = false;
      } else if (DEFERRED_DECISION_TARGET_KINDS.has(idType(target as string) ?? "")) {
        // Canon accepts the kind (§9.13); this slice does not fold it.
        errors.push(
          `${origin}: /target is ` +
            `${DEFERRED_DECISION_TARGET_KINDS.get(idType(target as string) ?? "")}`,
        );
        valid = false;
      }
      const to = row["to"];
      if (
        typeof to !== "string" ||
        (DECISION_VALUES.get(dimension) as ReadonlySet<string>).has(to) !== true
      ) {
        errors.push(`${origin}: /to must be on the ${dimension} scale (§9.13)`);
        valid = false;
      }
    }
    const evidence = row["evidence"];
    // §9.8: a status transition cites what made it true — the artifact or
    // encounter that clarified or resolved it, a note artifact for `stale`.
    // The question's own creation record establishes nothing, so the generic
    // §9.12 set narrows for this one dimension. §9.8/§31.5: nothing declines
    // automatically, so `stale` is the user's own note — never an encounter,
    // never someone else's work.
    let evidencePrefixes: ReadonlySet<string>;
    if (dimension === "status" && row["to"] === "stale") {
      evidencePrefixes = STALE_EVIDENCE_PREFIXES;
    } else if (dimension === "status") {
      evidencePrefixes = STATUS_EVIDENCE_PREFIXES;
    } else {
      evidencePrefixes = EVIDENCE_PREFIXES;
    }
    if (
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      evidence.some((ref) => !validNodeRef(ref, evidencePrefixes))
    ) {
      let expectation: string;
      if (dimension === "status" && row["to"] === "stale") {
        expectation = "§9.8 staleness evidence — the user's own note";
      } else if (dimension === "status") {
        expectation = "§9.8 resolution evidence — artifact or encounter ids";
      } else {
        expectation = "§9.12 evidence ids";
      }
      errors.push(`${origin}: /evidence must be a non-empty list of ${expectation}`);
      valid = false;
    }
    const proposedBy = row["proposed_by"];
    // §9.13: the audit record names who proposed it — a §17 agent role or
    // the user, never an anonymous or invented actor.
    if (typeof proposedBy !== "string" || !PROPOSERS.has(proposedBy)) {
      errors.push(`${origin}: /proposed_by must be a §17 agent role or user (§9.13)`);
      valid = false;
    } else if (
      proposedBy === "user" &&
      !(
        Array.isArray(evidence) &&
        evidence.some((ref) => validNodeRef(ref, new Set(["artifact"])))
      )
    ) {
      // §9.13: a manual edit is a self-proposal recorded through the same
      // gate, citing the owner's note rather than an anonymous direct write.
      // The kind is checked after refs resolve below.
      errors.push(
        `${origin}: /evidence for a user self-proposal must include a note ` +
          `artifact (§9.13)`,
      );
      valid = false;
    }
    const outcome = row["decision"];
    if (typeof outcome !== "string" || !DECISION_OUTCOMES.has(outcome)) {
      errors.push(`${origin}: /decision must be confirmed or rejected (§9.13)`);
      valid = false;
    }
    const sensitivity = row["sensitivity"];
    if (
      sensitivity !== undefined &&
      sensitivity !== null &&
      (typeof sensitivity !== "string" || !SENSITIVITY_CLASSES.has(sensitivity))
    ) {
      errors.push(`${origin}: /sensitivity must name a §32.6 class`);
      valid = false;
    }
    if (rowDate === null) valid = false;
    if (valid) {
      decisionRecords.push({
        position: decisionPosition,
        origin,
        row,
        date: rowDate as string,
      });
    }
  }

  // §34.4: the retired→living map — every retired id lives in exactly one
  // living formerly list, and a retired id that is also living, or present in
  // two lists, is a build error (a 1→n redirect is unrepresentable).
  const retired = new Map<string, string>();
  for (const nodeId of sortedByCodePoint([...nodes.keys()])) {
    const node = nodes.get(nodeId) as Dict;
    const redirects = node["formerly"] ?? null;
    if (redirects !== null && !Array.isArray(redirects)) {
      errors.push(`formerly on ${nodeId} must be a list of ids (§34.4)`);
      continue;
    }
    for (const old of Array.isArray(redirects) ? redirects : []) {
      if (typeof old !== "string") {
        errors.push(`formerly entry ${show(old)} on ${nodeId} is not an id (§34.4)`);
        continue;
      }
      const shape = old.startsWith("part:") ? PART_ID_RE : NODE_ID_RE;
      if (idType(old) === null || !shape.test(old)) {
        errors.push(
          `formerly entry ${show(old)} on ${nodeId} is not a canonical §10.1 ` +
            `id (§34.4)`,
        );
        continue;
      }
      if (idType(old) !== node["type"]) {
        errors.push(
          `formerly entry ${show(old)} on ${nodeId} changes kind — identity ` +
            `continuation is per-kind (§34.4)`,
        );
        continue;
      }
      if (nodes.has(old)) {
        errors.push(`formerly ${old} on ${nodeId} is still a living id (§34.4)`);
      }
      const survivor = retired.get(old);
      if (survivor !== undefined) {
        errors.push(
          `retired id ${old} redirects to both ${survivor} and ${nodeId} (§34.4)`,
        );
      } else {
        retired.set(old, nodeId);
      }
    }
  }

  // §34.4: curated refs resolve through the map — stale refs converge on the
  // survivor and are listed in the build report, never failed.
  const resolveRef = (ref: unknown, origin: string): unknown => {
    const survivor = typeof ref === "string" ? retired.get(ref) : undefined;
    if (survivor === undefined) return ref;
    warnings.push(`${origin}: stale curated ref ${ref} resolved to ${survivor} (§34.4)`);
    return survivor;
  };

  for (const edge of edges) {
    const origin = edge["_origin"] as string;
    for (const key of ["source", "target", "context", "step"]) {
      if (key in edge) edge[key] = resolveRef(edge[key], origin);
    }
    if (Array.isArray(edge["provenance"])) {
      edge["provenance"] = sortedByCodePoint(
        (edge["provenance"] as unknown[]).map(
          (ref) => resolveRef(ref, origin) as string,
        ),
      );
    }
    if (Array.isArray(edge["alternative_in"])) {
      edge["alternative_in"] = sortedByCodePoint(
        (edge["alternative_in"] as unknown[]).map(
          (ref) => resolveRef(ref, origin) as string,
        ),
      );
    }
  }
  for (const refs of fieldRefs.values()) {
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      if (typeof ref === "string") refs[index] = retired.get(ref) ?? ref;
    }
  }

  // Journal payload refs resolve like edge refs: the embedded row and its
  // typed edges are two faces of one record (§10.4) — §34.4 resolution must
  // not fork them.
  const quietly = (ref: unknown): unknown =>
    typeof ref === "string" ? retired.get(ref) ?? ref : ref;

  // §20 step 11: a payload-only journal ref that survived a deletion dangles
  // with a warning, never fails retained history (§34.2).
  const warnDangling = (ref: unknown, origin: string): void => {
    if (typeof ref === "string" && !nodes.has(ref)) {
      warnings.push(
        `${origin}: ${ref} missing — kept dangling (deletion is the owner's right)`,
      );
    }
  };

  for (const node of nodes.values()) {
    const origin = (node["_origin"] as string | undefined) ?? (node["id"] as string);
    if (node["type"] === "encounter") {
      if (typeof node["target"] === "string") {
        node["target"] = resolveRef(node["target"], origin);
      }
      if (isDict(node["context"])) {
        const resolved: Dict = {};
        for (const [key, value] of Object.entries(node["context"] as Dict)) {
          resolved[key] = resolveRef(value, origin);
        }
        node["context"] = resolved;
        for (const value of Object.values(resolved)) warnDangling(value, origin);
      }
    }
    if (node["type"] === "trail_segment") {
      for (const key of ["to", "from", "direction"]) {
        if (typeof node[key] === "string") node[key] = resolveRef(node[key], origin);
      }
      for (const key of ["from", "via", "resulting_questions"]) {
        if (Array.isArray(node[key])) {
          node[key] = (node[key] as unknown[]).map((ref) => resolveRef(ref, origin));
        }
      }
      // direction and resulting_questions are payload-only (no derived edge
      // carries them), so their resolution is checked here — a dangling ref
      // in retained history warns, never fails (§34.2, §20 step 11).
      warnDangling(node["direction"], origin);
      for (const ref of (node["resulting_questions"] as unknown[]) ?? []) {
        warnDangling(ref, origin);
      }
      const from = node["from"];
      // `if not node.get("from")` — absent, the empty string, or the
      // []-landing of §9.9 all read as no origin.
      const empty =
        from === undefined ||
        from === null ||
        from === "" ||
        (Array.isArray(from) && from.length === 0);
      if (empty) {
        // With no origin no moved_to edge carries `to`: the destination is
        // payload-only here and its dangle must be reported like the fields
        // above (§20 step 11).
        warnDangling(node["to"], origin);
      }
    }
    if (node["type"] === "artifact" && typeof node["probe"] === "string") {
      node["probe"] = resolveRef(node["probe"], origin);
      warnDangling(node["probe"], origin);
    }
    if (node["type"] === "question" && isDict(node["source"])) {
      const resolved: Dict = {};
      for (const [key, value] of Object.entries(node["source"] as Dict)) {
        resolved[key] = resolveRef(value, origin);
      }
      node["source"] = resolved;
      for (const value of Object.values(resolved)) warnDangling(value, origin);
    }
  }

  // §11.2 (#31): question roles derive from encounters citing the question —
  // the target folds primary when any citing encounter is deep use
  // (applied|taught), else supporting; nothing is stored (§31.8), and
  // provenance lists every deriving encounter (§10.3).
  //
  // The oracle keys a dict by the (material, question) pair and then sorts
  // its items; a JavaScript Map takes only one key, so the pair is carried
  // alongside and the sort is over the pair rather than over the joined
  // string — otherwise the separator would decide the order.
  const questionCiting = new Map<
    string,
    Array<{ id: string; depth: unknown; origin: string }>
  >();
  const citingKeys: Array<readonly [string, string, string]> = [];
  for (const record of encounterRecords) {
    const target = quietly(record.target);
    const ctxQuestion = quietly(record.question);
    if (typeof ctxQuestion === "string" && typeof target === "string") {
      const key = JSON.stringify([target, ctxQuestion]);
      const existing = questionCiting.get(key);
      if (existing === undefined) {
        questionCiting.set(key, [
          { id: record.id, depth: record.depth, origin: record.origin },
        ]);
        citingKeys.push([key, target, ctxQuestion]);
      } else {
        existing.push({ id: record.id, depth: record.depth, origin: record.origin });
      }
    }
  }
  const sortedCiting = [...citingKeys].sort((left, right) => {
    const byTarget = compareCodePoint(left[1], right[1]);
    return byTarget !== 0 ? byTarget : compareCodePoint(left[2], right[2]);
  });
  for (const [key, material, question] of sortedCiting) {
    const citing = questionCiting.get(key) as Array<{
      id: string;
      depth: unknown;
      origin: string;
    }>;
    const role = citing.some(
      (entry) => typeof entry.depth === "string" && DEEP_USE_DEPTHS.has(entry.depth),
    )
      ? "primary_for"
      : "supporting_for";
    addEdge(
      material,
      question,
      role,
      (citing[0] as { origin: string }).origin,
      sortedByCodePoint([...new Set(citing.map((entry) => entry.id))]),
      { lenient: true },
    );
  }

  // §11.3 (#31): a material cited in a segment's via is primary for the
  // segment — the movement went through it; the target of an encounter citing
  // one of the segment's via artifacts, not itself in via, is supporting.
  // Provenance lists the segment, and for the supporting join the deriving
  // encounters too (§10.3).
  for (const segment of segments) {
    const origin = segment.path;
    const segVia = segment.via.map((ref) => quietly(ref) as string);
    const viaMaterials = new Set(segVia.filter((ref) => !ref.startsWith("artifact:")));
    const viaArtifacts = new Set(segVia.filter((ref) => ref.startsWith("artifact:")));

    // §9.9/§13.2 step 9: every listed origin must be evidenced by the
    // segment's own context — co-touched in a via artifact, or the concept
    // whose question the artifact answers. An unevidenced origin is a
    // proposed correction, never a build failure (§5.2), and deleted evidence
    // rows keep history quiet (§34.2).
    const emitted = new Set([...viaArtifacts].filter((aid) => artifactTouches.has(aid)));
    if (emitted.size === viaArtifacts.size) {
      const evidenced = new Set<unknown>();
      for (const aid of sortedByCodePoint([...emitted])) {
        for (const ref of artifactTouches.get(aid) as Set<string>) {
          evidenced.add(quietly(ref));
        }
        for (const record of questionRecords.values()) {
          if (quietly(record.source["artifact"]) === aid) {
            for (const ref of record.pulls) evidenced.add(quietly(ref));
          }
        }
      }
      for (const raw of segment.origins) {
        if (!evidenced.has(quietly(raw))) {
          warnings.push(
            `${origin}: from ${raw} is not evidenced by the segment's own ` +
              `via context (§9.9/§13.2 step 9)`,
          );
        }
      }
    }
    for (const material of sortedByCodePoint([...viaMaterials])) {
      addEdge(material, segment.id, "primary_for", { doc: origin }, [segment.id], {
        lenient: true,
      });
    }
    const supporting = new Map<string, Set<string>>();
    for (const record of encounterRecords) {
      const target = quietly(record.target);
      if (
        typeof target === "string" &&
        viaArtifacts.has(quietly(record.artifact) as string) &&
        !viaMaterials.has(target)
      ) {
        const existing = supporting.get(target);
        if (existing === undefined) supporting.set(target, new Set([record.id]));
        else existing.add(record.id);
      }
    }
    for (const material of sortedByCodePoint([...supporting.keys()])) {
      addEdge(
        material,
        segment.id,
        "supporting_for",
        { doc: origin },
        [
          segment.id,
          ...sortedByCodePoint([...(supporting.get(material) as Set<string>)]),
        ],
        { lenient: true },
      );
    }
  }

  // §20 step 12 / §32.6: a trail segment with classed via is emitted with the
  // class — the union reads the resolved refs.
  for (const node of nodes.values()) {
    if (node["type"] === "trail_segment" && !("sensitivity" in node)) {
      for (const ref of (node["via"] as unknown[]) ?? []) {
        const marked =
          typeof ref === "string" ? nodes.get(ref)?.["sensitivity"] : undefined;
        if (marked) {
          node["sensitivity"] = marked;
          break;
        }
      }
    }
  }

  // §20.3 normalization: related_to and alternative_to are symmetric —
  // endpoints sort lexicographically before anything else sees the edge, so
  // two-sided authoring becomes one identity (provenance and optional
  // annotations union in the collapse below). Sorted after §34.4 resolution:
  // renames re-sort.
  for (const edge of edges) {
    if (
      SYMMETRIC_EDGE_TYPES.has(edge["type"] as string) &&
      typeof edge["source"] === "string" &&
      typeof edge["target"] === "string" &&
      compareCodePoint(edge["target"] as string, edge["source"] as string) < 0
    ) {
      const swap = edge["source"];
      edge["source"] = edge["target"];
      edge["target"] = swap;
    }
  }

  // §20.3 dedup: one identity emits one edge — provenance unions, a weight
  // conflict on one identity is a build ERROR.
  const canonical = new Map<string, Dict>();
  const deduped: Dict[] = [];
  for (const edge of edges) {
    // The oracle's identity is a tuple, which hashes by value; the nearest
    // JavaScript has is a string that cannot be spelled two ways, so it is
    // built with JSON rather than by joining — a context or step containing
    // the separator would otherwise collide with a different identity.
    const identity = JSON.stringify([
      edge["type"],
      edge["source"],
      edge["target"],
      edge["context"] ?? null,
      edge["order"] ?? null,
      edge["step"] ?? null,
    ]);
    const kept = canonical.get(identity);
    if (kept === undefined) {
      canonical.set(identity, edge);
      deduped.push(edge);
      continue;
    }
    if (kept["weight"] !== edge["weight"]) {
      // §14.9: unassessed is the no-hypothesis default — a lone authored
      // weight on the identity wins; two different authored weights are the
      // §20.3 conflict.
      const authored = new Set([kept["weight"], edge["weight"]]);
      authored.delete("unassessed");
      if (authored.size === 1) {
        kept["weight"] = [...authored][0];
      } else {
        errors.push(
          `${edge["_origin"]}: conflicting weights ${show(kept["weight"])} vs ` +
            `${show(edge["weight"])} on ${edge["type"]} ${edge["source"]} -> ` +
            `${edge["target"]} (§20.3)`,
        );
        continue;
      }
    }
    kept["provenance"] = sortedByCodePoint([
      ...new Set([
        ...(kept["provenance"] as string[]),
        ...(edge["provenance"] as string[]),
      ]),
    ]);
    if ("alternative_in" in kept || "alternative_in" in edge) {
      kept["alternative_in"] = sortedByCodePoint([
        ...new Set([
          ...((kept["alternative_in"] as string[] | undefined) ?? []),
          ...((edge["alternative_in"] as string[] | undefined) ?? []),
        ]),
      ]);
    }
  }
  edges = deduped;

  // §10.2/§20.3 (#102): endpoints are two distinct nodes — no type applies to
  // itself, so a self-edge never reaches the graph rather than reaching a
  // viewer that could only draw it as a zero-length line. The check runs on
  // §34.4-resolved ids, so a merge that collapses an authored pair is caught,
  // and before the cycle pass, so a self prerequisite reads as this rule
  // rather than as a too-coarse concept cut.
  const distinct: Dict[] = [];
  for (const edge of edges) {
    if (!(edge["source"] && edge["source"] === edge["target"])) {
      distinct.push(edge);
      continue;
    }
    if (AUTHORED_ROLES.has(edge["type"] as string) || edge["type"] === "supports") {
      // Authored in living curation: curation converges (§34.4).
      errors.push(
        `${edge["_origin"]}: ${edge["type"]} ${edge["source"]} applies to ` +
          `itself — endpoints must be two distinct nodes (§10.2)`,
      );
    } else {
      // Derived from a record the user owns — a route repeating a step, a
      // segment listing its own `to` among its `from`: the degenerate edge
      // goes, the record stays as written (§5.2).
      warnings.push(
        `${edge["_origin"]}: ${edge["type"]} ${edge["source"]} applies to ` +
          `itself — skipped (§10.2)`,
      );
    }
  }
  edges = distinct;

  // §20.3 cycles: a prerequisite_of cycle is a WARNING carrying the cycle
  // path — usually a too-coarse concept cut, never a build failure and
  // never a dependency alarm (§15.3, §25.4). supports cycles are normal
  // (§9.14); no other type is checked. Iterative DFS, sorted order, so
  // the report is deterministic and deep chains cannot overflow.
  const prereq = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (
      edge["type"] === "prerequisite_of" &&
      typeof edge["source"] === "string" &&
      typeof edge["target"] === "string"
    ) {
      const known = prereq.get(edge["source"]);
      if (known === undefined) prereq.set(edge["source"], new Set([edge["target"]]));
      else known.add(edge["target"]);
    }
  }
  // The oracle walks sorted iterators; the same walk here carries an index
  // into a sorted array, because a JavaScript iterator has no `next(it,
  // default)` and exhausting one through its protocol says the same thing
  // less plainly.
  const successorsOf = (nodeId: string): string[] =>
    sortedByCodePoint([...(prereq.get(nodeId) ?? [])]);
  const colour = new Map<string, number>(); // 1 = on the current path, 2 = done
  for (const start of sortedByCodePoint([...prereq.keys()])) {
    if (colour.get(start)) continue;
    const pathStack: string[] = [start];
    const frames: Array<{ items: string[]; index: number }> = [
      { items: successorsOf(start), index: 0 },
    ];
    colour.set(start, 1);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { items: string[]; index: number };
      const next = frame.index < frame.items.length ? frame.items[frame.index] : null;
      if (next === undefined || next === null) {
        colour.set(pathStack.pop() as string, 2);
        frames.pop();
        continue;
      }
      frame.index += 1;
      const mark = colour.get(next);
      if (mark === 1) {
        const cycle = [...pathStack.slice(pathStack.indexOf(next)), next];
        warnings.push(
          "prerequisite_of cycle (usually a too-coarse concept cut, §20.3): " +
            cycle.join(" -> "),
        );
      } else if (mark === undefined) {
        colour.set(next, 1);
        pathStack.push(next);
        frames.push({ items: successorsOf(next), index: 0 });
      }
    }
  }

  // §9.4 on §34.4-resolved ids: a role step must be a member of its
  // route's steps, and per (route, step) the two lists stay disjoint —
  // a rename cannot fail a stale spelling or bypass disjointness.
  //
  // The oracle keys these on tuples; here they are JSON, for the reason the
  // dedup above gives — a pair spelled by joining can be spelled two ways.
  const routeSteps = new Set<string>();
  for (const edge of edges) {
    if (edge["type"] === "step_of_route") {
      routeSteps.add(JSON.stringify([edge["target"] ?? null, edge["source"] ?? null]));
    }
  }
  const roleSeen = new Map<string, string>();
  for (const edge of edges) {
    if (edge["type"] !== "primary_for" && edge["type"] !== "supporting_for") continue;
    const route = edge["target"];
    const step = edge["step"] ?? null;
    if (!(typeof route === "string" && route.startsWith("suggested-route:"))) continue;
    if (!routeSteps.has(JSON.stringify([route, step]))) {
      errors.push(
        `${edge["_origin"]}: material_roles step ${show(step)} is not a ` +
          `member of steps (§9.4)`,
      );
    }
    const key = JSON.stringify([route, step, edge["source"] ?? null]);
    const previous = roleSeen.get(key);
    if (previous !== undefined && previous !== edge["type"]) {
      errors.push(
        `${edge["_origin"]}: ${edge["source"]} is both primary and supporting ` +
          `for step ${asText(step)} (§9.4/§20.3)`,
      );
    }
    roleSeen.set(key, edge["type"] as string);
  }

  // §20 step 11: a broken reference classifies by the ref's ORIGIN — a
  // journal- or segment-derived edge (lenient) downgrades to a warning
  // and is skipped, whatever it targets (§5.2, §34.2); a ref authored in
  // living curation is an error, unless it targets a user-deletable
  // record kind (trail segments, artifacts, encounters).
  //
  // The oracle tracks the skipped edges by `id(edge)`, which is object
  // identity; a Set of the objects themselves is the same thing said
  // directly. Two edges that survived dedup are never the same object, so
  // membership cannot spread from one to another.
  const dropped = new Set<Dict>();
  for (const edge of edges) {
    if (!EDGE_TYPES.has(edge["type"] as string)) {
      errors.push(
        `${edge["_origin"]}: edge type ${show(edge["type"])} outside the §10.2 ` +
          `closed set (${edge["source"]} -> ${edge["target"]})`,
      );
    }
    const rule = ENDPOINT_RULES.get(edge["type"] as string);
    if (rule !== undefined) {
      const sides = [
        ["source", rule[0]],
        ["target", rule[1]],
      ] as const;
      for (const [endpoint, allowed] of sides) {
        const ref = edge[endpoint];
        const kind = typeof ref === "string" && ref !== "" ? idType(ref) : null;
        if (kind !== null && !allowed.has(kind)) {
          if (edge["_lenient"]) {
            // §20.3: a journal-derived edge whose ref resolves outside the
            // matrix row is skipped with a warning.
            warnings.push(
              `${edge["_origin"]}: ${edge["type"]} ${endpoint} ${show(ref)} ` +
                `outside the §10.2 row — skipped`,
            );
            dropped.add(edge);
          } else {
            errors.push(
              `${edge["_origin"]}: ${edge["type"]} ${endpoint} ${show(ref)} must ` +
                `be ${sortedByCodePoint([...allowed]).join("/")}`,
            );
          }
        }
      }
    }
    for (const endpoint of ["source", "target"] as const) {
      const ref = edge[endpoint];
      if (typeof ref === "string" && nodes.has(ref)) continue;
      const kind = typeof ref === "string" && ref !== "" ? idType(ref) : null;
      if (kind === null) {
        errors.push(`${edge["_origin"]}: reference ${show(ref)} has no §10.1 prefix`);
      } else if (edge["_lenient"] || DELETABLE.has(kind)) {
        warnings.push(
          `${edge["_origin"]}: ${ref} missing — skipped (deletion is the ` +
            `owner's right)`,
        );
      } else {
        errors.push(
          `${edge["_origin"]}: broken curated link ${edge["source"]} ` +
            `-[${edge["type"]}]-> ${edge["target"]} (${ref} not found)`,
        );
      }
    }
    for (const ref of (edge["alternative_in"] as unknown[] | undefined) ?? []) {
      const kind = typeof ref === "string" ? idType(ref) : null;
      if (kind === null || !CONCEPT_KIND.has(kind)) {
        errors.push(
          `${edge["_origin"]}: alternative_in ref ${show(ref)} must be ` +
            `concept/pattern (§10.3)`,
        );
      } else if (!nodes.has(ref as string)) {
        errors.push(
          `${edge["_origin"]}: broken curated alternative_in ref ${ref} on ` +
            `${edge["source"]} -[${edge["type"]}]-> ${edge["target"]} (§10.3)`,
        );
      }
    }
  }

  edges = edges.filter(
    (edge) =>
      nodes.has(edge["source"] as string) &&
      nodes.has(edge["target"] as string) &&
      !dropped.has(edge),
  );
  for (const edge of edges) {
    delete edge["_origin"];
    delete edge["_lenient"];
  }

  // §10.4 (REGISTRY_FIELDS in domain). Dangling refs contribute nothing;
  // fields: [] is legal — the viewer flags it, the builder never
  // substitutes.
  const fieldsOf = (
    nodeId: unknown,
    seen: ReadonlySet<unknown> = new Set(),
  ): Set<string> => {
    const node = typeof nodeId === "string" ? nodes.get(nodeId) : undefined;
    if (node === undefined || seen.has(nodeId)) return new Set();
    const registry = REGISTRY_FIELDS.get(node["type"] as string);
    if (registry !== undefined) return new Set(registry);
    const result = new Set<string>();
    const deeper = new Set(seen);
    deeper.add(nodeId);
    for (const ref of fieldRefs.get(nodeId as string) ?? []) {
      for (const field of fieldsOf(ref, deeper)) result.add(field);
    }
    return result;
  };

  for (const [nodeId, node] of nodes) {
    node["fields"] = sortedByCodePoint([...fieldsOf(nodeId)]);
    delete node["_origin"];
  }

  // §20.1: the fold anchor is known only after every dated journal has
  // been read. It is shared by generated_at and §14.7 freshness.
  let latestActivity: string | null = null;
  for (const date of activityDates) latestActivity = laterOf(latestActivity, date);
  const effectiveAsOf: string | null = asOf ? asOf : latestActivity;

  // §20 step 9 / §14.5–§14.8: one generic monotone-max fold over the
  // knowledge-domain rows. Body ladders remain frozen under #45; filtering
  // to concept nodes here is a slice boundary, not a body-kind branch.
  interface ConceptWork {
    exposureRank: number;
    lastSeen: string | null;
    evidence: Set<string>;
    /** §14.5 strength → §20.1 fold keys. */
    strengths: Map<unknown, Array<readonly [string, number]>>;
    sensitivity: unknown;
  }
  const conceptWork = new Map<string, ConceptWork>();
  for (const nodeId of sortedByCodePoint([...nodes.keys()])) {
    const node = nodes.get(nodeId) as Dict;
    if (node["type"] !== "concept") continue;
    conceptWork.set(nodeId, {
      exposureRank: 0,
      lastSeen: null,
      evidence: new Set(),
      strengths: new Map(),
      sensitivity: node["sensitivity"] ?? null,
    });
  }

  /** §20.1's total order, compared — a date, then journal position. */
  const compareFoldKeys = (
    left: readonly [string, number],
    right: readonly [string, number],
  ): number => {
    const byDate = compareCodePoint(left[0], right[0]);
    return byDate !== 0 ? byDate : left[1] - right[1];
  };

  const observeConcept = (
    conceptId: string,
    exposureRank: number,
    date: unknown,
    evidenceId: string,
    ...provenanceIds: readonly string[]
  ): void => {
    const current = conceptWork.get(conceptId);
    if (current === undefined) return;
    current.exposureRank = Math.max(current.exposureRank, exposureRank);
    current.lastSeen = laterOf(
      current.lastSeen,
      typeof date === "string" ? date : null,
    );
    current.evidence.add(evidenceId);
    for (const ref of [evidenceId, ...provenanceIds]) {
      const sensitivity = nodes.get(ref)?.["sensitivity"] ?? null;
      if (sensitivity !== null) current.sensitivity = sensitivity;
    }
  };

  const artifactLinks = new Map<
    string,
    { influences: Set<string>; updates_state: Set<string> }
  >();
  for (const edge of edges) {
    const type = edge["type"];
    if (type === "influences" || type === "updates_state") {
      const source = edge["source"] as string;
      let links = artifactLinks.get(source);
      if (links === undefined) {
        links = { influences: new Set(), updates_state: new Set() };
        artifactLinks.set(source, links);
      }
      links[type].add(edge["target"] as string);
    }
  }
  for (const artifactId of sortedByCodePoint([...artifactLinks.keys()])) {
    const artifact = nodes.get(artifactId);
    const date = artifact?.["observed_at"] ?? null;
    const strength = artifact?.["evidence_strength"] ?? null;
    const position = artifactPositions.get(artifactId);
    const links = artifactLinks.get(artifactId) as {
      influences: Set<string>;
      updates_state: Set<string>;
    };
    // Merely touched concepts move at most to touched, whatever the
    // artifact's strength (§14.5).
    for (const conceptId of sortedByCodePoint([...links.influences])) {
      observeConcept(conceptId, 1, date, artifactId);
    }
    for (const conceptId of sortedByCodePoint([...links.updates_state])) {
      const rank =
        typeof strength === "string" ? ARTIFACT_EXPOSURE_RANK.get(strength) ?? 0 : 0;
      observeConcept(conceptId, rank, date, artifactId);
      const current = conceptWork.get(conceptId);
      if (current !== undefined && date !== null && position !== undefined) {
        let keys = current.strengths.get(strength);
        if (keys === undefined) {
          keys = [];
          current.strengths.set(strength, keys);
        }
        keys.push(foldOrderKey(date as string, position));
      }
    }
  }

  // explained + reviewed is the only compound artifact transition: an
  // explanation that survived review reaches taught (§14.1/§14.5). The
  // review has to be able to be a review OF that explanation, so it cannot
  // predate it — old review history on a concept does not make the next
  // explanation taught. Absent a link from review to reviewed work, the
  // §20.1 keys are the evidence available: the latest review against the
  // earliest explanation, with same-day order decided by journal position.
  for (const current of conceptWork.values()) {
    const explanations = current.strengths.get("explained");
    const reviews = current.strengths.get("reviewed");
    if (
      explanations === undefined ||
      explanations.length === 0 ||
      reviews === undefined ||
      reviews.length === 0
    ) {
      continue;
    }
    const latestReview = reviews.reduce((best, key) =>
      compareFoldKeys(key, best) > 0 ? key : best,
    );
    const earliestExplanation = explanations.reduce((best, key) =>
      compareFoldKeys(key, best) < 0 ? key : best,
    );
    if (compareFoldKeys(latestReview, earliestExplanation) >= 0) {
      current.exposureRank = CONCEPT_EXPOSURE.length - 1;
    }
  }

  // Encounters use the exact id they target for material state (§14.8).
  // Their concept contact follows only that target's own mapping: a
  // material's overall_concepts or a part's concept_edges (§9.2–§9.3).
  const materialConcepts = new Map<string, Set<string>>();
  for (const edge of edges) {
    const source = edge["source"] as string;
    const sourceKind = nodes.get(source)?.["type"];
    const targetKind = nodes.get(edge["target"] as string)?.["type"];
    if (targetKind !== "concept") continue;
    const mapped =
      (edge["type"] === "overall_concept" && sourceKind === "material") ||
      (sourceKind === "material_part" && AUTHORED_ROLES.has(edge["type"] as string));
    if (!mapped) continue;
    const known = materialConcepts.get(source);
    if (known === undefined) {
      materialConcepts.set(source, new Set([edge["target"] as string]));
    } else {
      known.add(edge["target"] as string);
    }
  }

  const visited = new Map<string, string>();
  for (const edge of edges) {
    if (edge["type"] === "visited") {
      visited.set(edge["source"] as string, edge["target"] as string);
    }
  }
  interface MaterialWork {
    depthRank: number;
    lastSeen: string | null;
    evidence: Set<string>;
    sensitivity: unknown;
  }
  const materialWork = new Map<string, MaterialWork>();
  for (const encounterId of sortedByCodePoint([...visited.keys()])) {
    const encounter = nodes.get(encounterId);
    const target = visited.get(encounterId) as string;
    const depth = encounter?.["depth"] ?? null;
    const date = encounter?.["date"] ?? null;
    if (typeof depth !== "string" || !MATERIAL_DEPTH.includes(depth)) continue;
    let current = materialWork.get(target);
    if (current === undefined) {
      current = {
        depthRank: 0,
        lastSeen: typeof date === "string" ? date : null,
        evidence: new Set(),
        sensitivity: nodes.get(target)?.["sensitivity"] ?? null,
      };
      materialWork.set(target, current);
    }
    current.depthRank = Math.max(current.depthRank, MATERIAL_DEPTH.indexOf(depth));
    // A rejected date is already an error; the fold must still reduce
    // without it so the CLI reports that error instead of a crash.
    current.lastSeen = laterOf(
      current.lastSeen,
      typeof date === "string" ? date : null,
    );
    current.evidence.add(encounterId);
    const marked = encounter?.["sensitivity"] ?? null;
    if (marked !== null) current.sensitivity = marked;
    // A skim is contact (touched); read or deeper is capped at read.
    const encounterRank = depth === "skim" ? 1 : 2;
    for (const conceptId of sortedByCodePoint([
      ...(materialConcepts.get(target) ?? []),
    ])) {
      observeConcept(conceptId, encounterRank, date, encounterId, target);
    }
  }

  // §9.13/§20.1: each order-sensitive reduction stays inside the
  // decisions journal. Earlier-dated backfill never beats a later decision;
  // same-day ties resolve by physical journal position. Rejections do not
  // move state and therefore never replace a confirmed winner.
  interface Winner {
    score: readonly [string, number];
    value: unknown;
    evidence: string[];
    sensitivity: unknown;
  }
  const decisionWinners = new Map<string, Winner>();
  const rejectedProposals = new Map<string, Array<Set<string>>>();
  const ordered = [...decisionRecords].sort((left, right) =>
    compareFoldKeys(
      foldOrderKey(left.date, left.position),
      foldOrderKey(right.date, right.position),
    ),
  );
  for (const record of ordered) {
    const { position, origin, row } = record;
    const rowDate = record.date;
    const dimension = row["dimension"] as string;
    // Every accepted dimension targets a node id: the one dimension that
    // named an edge (§14.9 weight) is refused above, not folded here.
    let target = row["target"] as string;
    const survivor = retired.get(target);
    if (survivor !== undefined) {
      warnings.push(
        `${origin}: stale journal ref ${target} resolved to ${survivor} (§34.4)`,
      );
      target = survivor;
    }
    if (!nodes.has(target)) {
      warnings.push(
        `${origin}: ${target} missing — decision target skipped (deletion is ` +
          `the owner's right)`,
      );
      continue;
    }
    const evidence = row["evidence"] as string[];
    for (const ref of sortedByCodePoint([...new Set(evidence)])) {
      if (!nodes.has(ref)) {
        // §20.1: a decision inside the cut still applies when its cited
        // evidence lies outside the cut or was deleted.
        warnings.push(
          `${origin}: ${ref} missing — decision applies with a dangling ` +
            `evidence ref (§20.1)`,
        );
      }
    }
    // §9.13: user self-proposals cite the owner's note. The read pass
    // established an artifact-shaped ref; its kind is knowable here.
    // A decision record remains valid when that artifact lies outside the
    // as-of cut or was deleted (§20.1), so reject only when every cited
    // artifact resolves and none is a note.
    if (row["proposed_by"] === "user") {
      const artifactRefs = evidence.filter((ref) => ref.startsWith("artifact:"));
      const resolvedArtifacts = artifactRefs
        .filter((ref) => nodes.has(ref))
        .map((ref) => nodes.get(ref) as Dict);
      if (
        resolvedArtifacts.length === artifactRefs.length &&
        !resolvedArtifacts.some((node) => node["kind"] === STALE_EVIDENCE_KIND)
      ) {
        errors.push(
          `${origin}: /evidence for a user self-proposal must cite the user's ` +
            `own note (§9.13)`,
        );
        continue;
      }
    }
    // §14.6/§9.13: a rejection is durable memory. The proposal is the
    // resolved target/dimension/value; retrying it requires at least one
    // citation outside every evidence set that already supported a
    // rejection. Reordering or removing citations is not new evidence.
    const proposal = JSON.stringify([target, dimension, row["to"] ?? null]);
    const proposalEvidence = new Set(evidence);
    const alreadyRejected = (rejectedProposals.get(proposal) ?? []).some(
      (rejectedEvidence) =>
        [...proposalEvidence].every((ref) => rejectedEvidence.has(ref)),
    );
    if (alreadyRejected) {
      errors.push(
        `${origin}: a rejected proposal cannot be re-proposed without new ` +
          `evidence (§14.6/§9.13)`,
      );
      continue;
    }
    if (row["decision"] === "rejected") {
      const history = rejectedProposals.get(proposal);
      if (history === undefined) rejectedProposals.set(proposal, [proposalEvidence]);
      else history.push(proposalEvidence);
      continue;
    }
    // §9.8: the read pass held staleness to an artifact; the kind is
    // knowable only here, where nodes exist. §20.1 lets a decision
    // apply on evidence outside the cut, so this speaks only when the
    // cited records resolve — and then one of them must be the note.
    if (dimension === "status" && row["to"] === "stale") {
      const resolved = evidence
        .filter((ref) => nodes.has(ref))
        .map((ref) => nodes.get(ref) as Dict);
      if (
        resolved.length === evidence.length &&
        !resolved.some((node) => node["kind"] === STALE_EVIDENCE_KIND)
      ) {
        errors.push(
          `${origin}: /evidence for a stale status must cite the user's own ` +
            `note (§9.8/§31.5)`,
        );
        continue;
      }
    }
    // The same table the refusals above read: an accepted row is a
    // folded row, so nothing validates into a silently dropped decision.
    const foldedKinds = FOLDED_DECISION_TARGETS.get(dimension);
    const targetKind = nodes.get(target)?.["type"];
    if (foldedKinds === undefined || !foldedKinds.has(targetKind as string)) continue;
    const key = JSON.stringify([target, dimension]);
    const score: readonly [string, number] = [rowDate, position];
    const previous = decisionWinners.get(key);
    if (previous === undefined || compareFoldKeys(score, previous.score) > 0) {
      decisionWinners.set(key, {
        score,
        value: row["to"],
        evidence: sortedByCodePoint([...new Set(evidence)]),
        sensitivity: row["sensitivity"] ?? null,
      });
    }
  }

  const decisionRef = (dimension: string, winner: Winner): Dict => ({
    dimension,
    date: winner.score[0],
    evidence: winner.evidence,
  });

  const decisionSensitivity = (target: string, winner: Winner): unknown => {
    const candidates: unknown[] = [
      nodes.get(target)?.["sensitivity"] ?? null,
      winner.sensitivity ?? null,
      ...winner.evidence.map(
        (ref) =>
          (nodes.get(ref)?.["sensitivity"] ?? null) ||
          (evidenceSensitivity.get(ref) ?? null),
      ),
    ];
    return candidates.find((value) => value !== null && value !== undefined) ?? null;
  };

  // Every key here is a §10.1 id, so every key carries a prefix and a colon.
  // That is what keeps a plain object safe as the state map: an
  // integer-looking key would be reordered ahead of the rest on iteration,
  // and no id can look like one.
  const state: Dict = {};
  const dimensionOrder = ["confidence", "clarity", "coverage"] as const;
  for (const conceptId of sortedByCodePoint([...conceptWork.keys()])) {
    const current = conceptWork.get(conceptId) as ConceptWork;
    const entry: Dict = {
      exposure: CONCEPT_EXPOSURE[current.exposureRank],
      ...Object.fromEntries(CONCEPT_DEFAULTS),
      evidence: sortedByCodePoint([...current.evidence]),
      decisions: [],
    };
    for (const dimension of dimensionOrder) {
      const winner = decisionWinners.get(JSON.stringify([conceptId, dimension]));
      if (winner === undefined) continue;
      entry[dimension] = winner.value;
      entry["evidence"] = sortedByCodePoint([
        ...new Set([...(entry["evidence"] as string[]), ...winner.evidence]),
      ]);
      (entry["decisions"] as Dict[]).push(decisionRef(dimension, winner));
      const sensitivity = decisionSensitivity(conceptId, winner);
      if (sensitivity !== null && sensitivity !== undefined) {
        current.sensitivity = sensitivity;
      }
    }
    const lastSeen = current.lastSeen;
    if (lastSeen !== null && effectiveAsOf !== null) {
      entry["last_seen"] = lastSeen;
      entry["freshness"] = freshnessOf(lastSeen, effectiveAsOf);
    }
    if (current.sensitivity !== null && current.sensitivity !== undefined) {
      entry["sensitivity"] = current.sensitivity;
    }
    state[conceptId] = entry;
  }

  for (const target of sortedByCodePoint([...materialWork.keys()])) {
    const current = materialWork.get(target) as MaterialWork;
    const lastSeen = current.lastSeen;
    const entry: Dict = {
      depth_reached: MATERIAL_DEPTH[current.depthRank],
      last_seen: lastSeen,
    };
    // §14.7 (#105): the fold classifies material contact against the same
    // as-of it classifies concept contact against, so one render never
    // mixes two classifiers. The graph carries the class, never the
    // thresholds — those are canon each implementation transcribes, and a
    // consumer recomputes only to refuse a class this fold would not have
    // produced (§16.5, #108). A build missing either input is already an
    // error; emit no invented class.
    if (lastSeen !== null && effectiveAsOf !== null) {
      entry["freshness"] = freshnessOf(lastSeen, effectiveAsOf);
    }
    entry["evidence"] = sortedByCodePoint([...current.evidence]);
    if (current.sensitivity !== null && current.sensitivity !== undefined) {
      entry["sensitivity"] = current.sensitivity;
    }
    state[target] = entry;
  }

  const questionIds: string[] = [];
  for (const [nodeId, node] of nodes) {
    if (node["type"] === "question") questionIds.push(nodeId);
  }
  for (const questionId of sortedByCodePoint(questionIds)) {
    const winner = decisionWinners.get(JSON.stringify([questionId, "status"]));
    const entry: Dict = {
      status: winner !== undefined ? winner.value : QUESTION_DEFAULT_STATUS,
      evidence: winner !== undefined ? winner.evidence : [],
      decisions: winner !== undefined ? [decisionRef("status", winner)] : [],
    };
    const sensitivity =
      winner !== undefined
        ? decisionSensitivity(questionId, winner)
        : nodes.get(questionId)?.["sensitivity"] ?? null;
    if (sensitivity !== null && sensitivity !== undefined) {
      entry["sensitivity"] = sensitivity;
    }
    state[questionId] = entry;
  }

  // §20.3 determinism: canonical identity order — type, source, target,
  // then the meta discriminant. `or` on the last three is the oracle's:
  // an absent context or step sorts as the empty string, an absent order
  // as zero, so the missing key and the falsy value are one position.
  const edgeSortKey = (
    edge: Dict,
  ): readonly [string, string, string, string, number, string] => [
    edge["type"] as string,
    edge["source"] as string,
    edge["target"] as string,
    (edge["context"] as string | undefined) || "",
    (edge["order"] as number | undefined) || 0,
    (edge["step"] as string | undefined) || "",
  ];

  // §20.1: generated_at is the fold's as-of date at UTC midnight, never
  // the wall clock (determinism: same inputs ⇒ byte-identical output).
  // The default as-of is the max activity date across the dated inputs —
  // journal rows and trail segments; with no dated input the key stays
  // absent, not invented. An explicit as-of is the inclusive upper bound
  // over every journal row and trail segment projected above.
  const graph: Dict = {
    format: "atlas-graph",
    version: 1,
    nodes: [...nodes.values()].sort((left, right) =>
      compareCodePoint(left["id"] as string, right["id"] as string),
    ),
    edges: [...edges].sort((left, right) => {
      const leftKey = edgeSortKey(left);
      const rightKey = edgeSortKey(right);
      for (const index of [0, 1, 2, 3] as const) {
        const order = compareCodePoint(leftKey[index], rightKey[index]);
        if (order !== 0) return order;
      }
      if (leftKey[4] !== rightKey[4]) return leftKey[4] - rightKey[4];
      return compareCodePoint(leftKey[5], rightKey[5]);
    }),
    trails: [], // §29 Phase 3
    state, // §20 step 9 (§14.5–§14.8, §9.8)
    influence: {}, // §29 Phase 4 (§9.10)
    frontier: [], // §29 Phase 4 (§15)
    projections: Object.fromEntries(
      sortedByCodePoint([...projections.keys()]).map((key) => [
        key,
        projections.get(key) as string,
      ]),
    ), // §20 step 12, §32
  };
  if (effectiveAsOf !== null) {
    graph["generated_at"] = `${effectiveAsOf}T00:00:00Z`;
  }
  if (skippedDatedInputs) {
    warnings.push(
      `skipped ${skippedDatedInputs} dated input(s) after as-of ${asOf} (§20.1)`,
    );
  }
  return { graph, errors, warnings };
}
