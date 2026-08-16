// The gate that keeps the two written-down copies of the graph's vocabulary
// from drifting apart.
//
// `spec/schemas` is canon (§25.7) and the builder's constants are what the
// code actually enforces. Both exist on purpose — the schema so a consumer can
// validate a graph without running us, the constants so the builder needs no
// schema at run time — and this is where the copy is held against the
// original, in both directions: a name added to one and not the other fails
// here rather than in whatever the graph turns out to mean.
//
// The §25.8 intake ceilings are the same promise the other way round. The
// numbers live in code, the SDD line is canonical, and the one normative
// sentence is parsed so that editing either side alone fails the gate.
//
// Ported from check_constants in scripts/validate_atlas.py.

import fs from "node:fs";

import {
  AGENT_ROLES,
  AUTHORED_ROLES,
  DECISION_OUTCOMES,
  DECISION_VALUES,
  DEFERRED_DIMENSIONS,
  EDGE_TYPES,
  EDGE_WEIGHTS,
  ENDPOINT_RULES,
  ID_PREFIXES,
  LIFECYCLE_STATUSES,
  MATERIAL_KINDS,
  NODE_TYPES,
  PROPOSERS,
  ROUTE_STATUSES,
} from "./domain.ts";
import {
  INTAKE_BATCH_BYTES,
  INTAKE_NESTING_DEPTH,
  INTAKE_RECORDS,
  INTAKE_RECORD_BYTES,
  INTAKE_STRING_BYTES,
} from "./intake.ts";
import { SchemaValidator } from "./schema.ts";
import { loadRegistry } from "./schema-registry.ts";

/** The one §25.8 line that fixes the intake ceilings. */
const NFR_SPEC = "spec/25-non-functional-requirements.md";

// Python's `\s` inside a str pattern is Unicode whitespace, which is wider
// than JavaScript's in one direction (the C0 separators) and narrower in
// another (no U+FEFF). Spelled out so the line the oracle matches and the line
// this matches are the same line.
const SPACE = "[ \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const CEILINGS = new RegExp(
  `intake batches${SPACE}+≤ ([0-9,]+) total bytes, ≤ ([0-9,]+) records, ` +
    `≤ ([0-9,]+) bytes per${SPACE}+record, ≤ ([0-9,]+) bytes per string, ` +
    `nesting depth ≤ ([0-9,]+)`,
);

type Fragment = Record<string, unknown>;

function asObject(value: unknown, what: string): Fragment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${what} is not a schema object`);
  }
  return value as Fragment;
}

/**
 * `$defs` members are compared as sets of names, so a member that is not a
 * name is refused rather than coerced.
 *
 * The oracle would carry a number through into its own diagnostic; a port
 * cannot follow it there, because JSON's `1.0` and `1` are one value in
 * JavaScript and two different reprs in Python. Nothing in `spec/schemas`
 * spells one of these enums with a number, and a schema that started to would
 * be a change to the vocabulary rather than the drift this gate watches for.
 */
function enumNames(fragment: Fragment, what: string): Set<string> {
  const members = fragment["enum"];
  if (!Array.isArray(members)) throw new TypeError(`${what} has no enum`);
  for (const member of members) {
    if (typeof member !== "string") {
      throw new TypeError(`${what} enum holds a value that is not a name`);
    }
  }
  return new Set(members as string[]);
}

/** Follow `$ref`s, keeping whatever the referring object said as well. */
function resolved(schema: Fragment, value: Fragment): Fragment {
  let current = value;
  while (Object.hasOwn(current, "$ref")) {
    const ref = current["$ref"];
    if (typeof ref !== "string") throw new TypeError("$ref is not a pointer");
    const target = asObject(new SchemaValidator(schema).resolve(ref), ref);
    const rest = { ...current };
    delete rest["$ref"];
    current = { ...target, ...rest };
  }
  return current;
}

// --- Python's repr, for the drift diagnostics --------------------------------
//
// The diagnostic prints both values, so the port has to spell a set and a dict
// the way Python spells them. One thing it cannot reproduce is the order of a
// set, which CPython derives from the hash of its members and so varies per
// interpreter run: sorted here, and the differential sorts the oracle's before
// comparing.

function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += "\\" + char;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else out += char;
  }
  return out + quote;
}

function reprSet(value: ReadonlySet<string>): string {
  if (value.size === 0) return "set()";
  return `{${[...value].sort().map(repr).join(", ")}}`;
}

function reprNames(value: ReadonlyMap<string, string>): string {
  const items = [...value].map(([key, item]) => `${repr(key)}: ${repr(item)}`);
  return `{${items.join(", ")}}`;
}

function reprEndpoints(
  value: ReadonlyMap<string, readonly [ReadonlySet<string>, ReadonlySet<string>]>,
): string {
  const items = [...value].map(
    ([key, [source, target]]) =>
      `${repr(key)}: (${reprSet(source)}, ${reprSet(target)})`,
  );
  return `{${items.join(", ")}}`;
}

// --- The comparisons ---------------------------------------------------------

function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

function sameEndpoints(
  left: ReadonlyMap<string, readonly [ReadonlySet<string>, ReadonlySet<string>]>,
  right: ReadonlyMap<string, readonly [ReadonlySet<string>, ReadonlySet<string>]>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, [source, target]] of left) {
    const other = right.get(key);
    if (other === undefined) return false;
    if (!sameNames(source, other[0]) || !sameNames(target, other[1])) return false;
  }
  return true;
}

function samePrefixes(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

/**
 * Compare every constant the builder holds against the schema that also holds
 * it, and the intake ceilings against §25.8.
 *
 * `root` is the repository, not an instance: both canons are tracked files.
 */
export function checkConstants(root: string): string[] {
  const { schemas, errors } = loadRegistry(root);
  if (errors.length > 0) return [...errors];
  const found: string[] = [];

  const graph = asObject(schemas.get("atlas-graph"), "atlas-graph");
  const defs = asObject(graph["$defs"], "atlas-graph $defs");
  const named = (name: string): Set<string> =>
    enumNames(asObject(defs[name], `atlas-graph $defs.${name}`), `$defs.${name}`);

  const endpointProperties = asObject(
    asObject(defs["endpointRules"], "$defs.endpointRules")["properties"],
    "$defs.endpointRules.properties",
  );
  const schemaEndpoints = new Map<string, readonly [Set<string>, Set<string>]>();
  for (const [edgeType, edgeSchema] of Object.entries(endpointProperties)) {
    const rule = resolved(graph, asObject(edgeSchema, `endpointRules.${edgeType}`));
    const properties = asObject(rule["properties"], `endpointRules.${edgeType}`);
    schemaEndpoints.set(edgeType, [
      enumNames(asObject(properties["source"], "source"), `${edgeType}.source`),
      enumNames(asObject(properties["target"], "target"), `${edgeType}.target`),
    ]);
  }

  const prefixProperties = asObject(
    asObject(defs["idPrefixes"], "$defs.idPrefixes")["properties"],
    "$defs.idPrefixes.properties",
  );
  const schemaPrefixes = new Map<string, string>();
  for (const [prefix, prefixSchema] of Object.entries(prefixProperties)) {
    const constant = asObject(prefixSchema, `idPrefixes.${prefix}`)["const"];
    if (typeof constant !== "string") {
      throw new TypeError(`idPrefixes.${prefix} const is not a name`);
    }
    schemaPrefixes.set(prefix, constant);
  }

  const decisionDefs = asObject(
    asObject(schemas.get("journal-decision"), "journal-decision")["$defs"],
    "journal-decision $defs",
  );
  const decisionEnum = (name: string): Set<string> =>
    enumNames(
      asObject(decisionDefs[name], `journal-decision $defs.${name}`),
      `journal-decision $defs.${name}`,
    );
  const decisionValues = (dimension: string): ReadonlySet<string> => {
    const values = DECISION_VALUES.get(dimension);
    if (values === undefined) throw new TypeError(`no ${dimension} dimension`);
    return values;
  };

  const drift = (
    codeName: string,
    code: string,
    schemaName: string,
    schema: string,
  ): void => {
    found.push(
      `build_atlas_graph.py ${codeName}=${code} does not match ${schemaName}=${schema}`,
    );
  };

  const names = (
    codeName: string,
    code: ReadonlySet<string>,
    schemaName: string,
    schema: ReadonlySet<string>,
  ): void => {
    if (!sameNames(code, schema)) {
      drift(codeName, reprSet(code), schemaName, reprSet(schema));
    }
  };

  names("NODE_TYPES", NODE_TYPES, "schema $defs.nodeType", named("nodeType"));
  names("EDGE_TYPES", EDGE_TYPES, "schema $defs.edgeType", named("edgeType"));
  names(
    "AUTHORED_ROLES",
    AUTHORED_ROLES,
    "schema $defs.authoredRole",
    named("authoredRole"),
  );
  if (!sameEndpoints(ENDPOINT_RULES, schemaEndpoints)) {
    drift(
      "ENDPOINT_RULES",
      reprEndpoints(ENDPOINT_RULES),
      "schema $defs.endpointRules",
      reprEndpoints(schemaEndpoints),
    );
  }
  names("EDGE_WEIGHTS", EDGE_WEIGHTS, "schema $defs.edgeWeight", named("edgeWeight"));
  names(
    "LIFECYCLE_STATUSES",
    LIFECYCLE_STATUSES,
    "schema $defs.lifecycleStatus",
    named("lifecycleStatus"),
  );
  names(
    "MATERIAL_KINDS",
    MATERIAL_KINDS,
    "schema $defs.materialKind",
    named("materialKind"),
  );
  names(
    "ROUTE_STATUSES",
    ROUTE_STATUSES,
    "schema $defs.routeStatus",
    named("routeStatus"),
  );
  if (!samePrefixes(ID_PREFIXES, schemaPrefixes)) {
    drift(
      "ID_PREFIXES",
      reprNames(ID_PREFIXES),
      "schema $defs.idPrefixes",
      reprNames(schemaPrefixes),
    );
  }
  // §17.1/§9.13: the proposer set is the run manifest's role enum plus the
  // user — one roster, drift caught here like every other constant.
  const manifestRole = asObject(
    asObject(
      asObject(schemas.get("run-manifest"), "run-manifest")["properties"],
      "run-manifest properties",
    )["role"],
    "run-manifest properties.role",
  );
  names(
    "AGENT_ROLES",
    AGENT_ROLES,
    "run-manifest schema properties.role",
    enumNames(manifestRole, "run-manifest properties.role"),
  );
  // The journal schema carries the same roster plus the user, so the boundary
  // preflight predicts whether the builder accepts the row.
  names(
    "PROPOSERS",
    PROPOSERS,
    "journal-decision schema $defs.proposer",
    decisionEnum("proposer"),
  );
  // §9.13 is canon-complete while this slice defers named rows. Keep the
  // active and deferred builder rosters exhaustive against that persisted
  // contract so preflight/build drift fails in CI.
  names(
    "DECISION_DIMENSIONS",
    new Set([...DECISION_VALUES.keys(), ...DEFERRED_DIMENSIONS.keys()]),
    "journal-decision schema $defs.dimension",
    decisionEnum("dimension"),
  );
  names(
    "DECISION_OUTCOMES",
    DECISION_OUTCOMES,
    "journal-decision schema $defs.decision",
    decisionEnum("decision"),
  );
  for (const dimension of ["confidence", "clarity", "coverage", "weight", "status"]) {
    names(
      `DECISION_VALUES.${dimension}`,
      decisionValues(dimension),
      `journal-decision schema $defs.${dimension}Value`,
      decisionEnum(`${dimension}Value`),
    );
  }

  // §25.8/#56: the intake reader's named ceilings are code constants, but the
  // SDD remains canonical. Parse the one normative line so either-side drift
  // fails the existing check-constants gate.
  const nfr = fs.readFileSync(`${root}/${NFR_SPEC}`, "utf8");
  const match = CEILINGS.exec(nfr);
  if (match === null) {
    found.push("§25.8 intake ceiling registry line is missing or malformed");
  } else {
    // Exact integers, not doubles: the SDD is free to name a ceiling past the
    // precision of a double, and `int()` on the oracle's side would read it
    // exactly while `Number()` here would land on a neighbour and disagree.
    const spec = match.slice(1).map((value) => BigInt(value.replaceAll(",", "")));
    const code = [
      INTAKE_BATCH_BYTES,
      INTAKE_RECORDS,
      INTAKE_RECORD_BYTES,
      INTAKE_STRING_BYTES,
      INTAKE_NESTING_DEPTH,
    ].map(BigInt);
    if (code.some((value, at) => value !== spec[at])) {
      found.push(
        "process_intake.py intake ceilings do not match §25.8: " +
          `code=(${code.join(", ")}), spec=(${spec.join(", ")})`,
      );
    }
  }
  return found;
}
