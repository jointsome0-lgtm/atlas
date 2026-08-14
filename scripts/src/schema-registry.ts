// The authored schema registry and the §17.7 manifest bindings.
//
// `spec/schemas` is canon (§25.7): the validator loads all of it or says which
// part it could not, and the inventory is compared against a written-down list
// rather than against whatever happens to be on disk — a schema that vanished
// would otherwise turn every record it governs into a record with no rules,
// and the preflight would go green.

import { SchemaSubsetError, SchemaValidator } from "./schema.ts";
import { AtlasReader, ReaderError } from "./reader.ts";
import { JsonInputError, readJsonFile } from "./json-input.ts";

/** Every schema `spec/schemas` must hold, by file stem (§25.7). */
export const SCHEMA_NAMES: ReadonlySet<string> = new Set([
  "concept",
  "zone",
  "pattern",
  "material",
  "direction",
  "suggested-route",
  "trail-segment",
  "probe",
  "plan-extract",
  "journal-artifact",
  "journal-encounter",
  "journal-question",
  "journal-decision",
  "journal-mapping-decision",
  "journal-receipt",
  "journal-purge",
  "atlas-graph",
  "atlas-snapshot",
  "atlas-intake",
  "report-batch",
  "run-manifest",
  "runner-plan-importer-input",
  "runner-plan-importer-output",
  "runner-artifact-observer-input",
  "runner-artifact-observer-output",
]);

// §17.7: role admission and the selected closed transport pair are semantic
// manifest bindings. The generic §17.6 schema intentionally still names all
// four governance roles so an unsupported-role preflight can leave its audit
// line; only these two roles may reach provider transit in runner protocol v1.
const RUNNER_ROLE_SCHEMA_COMPONENTS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ["plan-importer", ["runner-plan-importer-input", "runner-plan-importer-output"]],
    [
      "artifact-observer",
      ["runner-artifact-observer-input", "runner-artifact-observer-output"],
    ],
  ]);

const RUNNER_SCHEMA_COMPONENT_IDS: ReadonlySet<string> = new Set(
  [...RUNNER_ROLE_SCHEMA_COMPONENTS.values()].flat(),
);

const RUNNER_UNSUPPORTED_ROLES: ReadonlySet<string> = new Set([
  "field-cartographer",
  "state-auditor",
]);

const SCHEMA_SUFFIX = ".schema.json";
const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export interface Registry {
  readonly schemas: ReadonlyMap<string, Record<string, unknown>>;
  readonly errors: readonly string[];
}

/**
 * Read `spec/schemas` from `root`, reporting rather than raising.
 *
 * A schema that fails to load is left out of the map and named in `errors`;
 * the caller is a preflight whose job is to list everything wrong at once.
 */
export function loadRegistry(root: string): Registry {
  const errors: string[] = [];
  const schemas = new Map<string, Record<string, unknown>>();

  let paths: ReturnType<AtlasReader["scan"]>;
  try {
    paths = new AtlasReader(root).scan("spec/schemas", { suffix: SCHEMA_SUFFIX });
  } catch (error) {
    if (error instanceof ReaderError) return { schemas, errors: [error.message] };
    throw error;
  }

  const found = new Set(
    paths.map((path) => path.name.slice(0, -SCHEMA_SUFFIX.length)),
  );
  if (!sameNames(found, SCHEMA_NAMES)) {
    errors.push(
      "schema inventory mismatch: " +
        `expected ${showNames(SCHEMA_NAMES)}, found ${showNames(found)}`,
    );
  }

  for (const path of paths) {
    const name = path.name.slice(0, -SCHEMA_SUFFIX.length);
    try {
      const schema = readJsonFile(path);
      if (!isObject(schema)) {
        // The oracle reaches `.get` on a non-object here and reports the
        // AttributeError text; a schema that is not an object is refused for
        // the reason it is refused, which is that it is not a schema.
        errors.push(`${path}: schema must be a JSON object`);
        continue;
      }
      if (schema["$schema"] !== SCHEMA_DIALECT) {
        errors.push(`${path}: $schema must name JSON Schema 2020-12`);
      }
      const expectedId = `https://atlas-sdd.local/schemas/${path.name}`;
      if (schema["$id"] !== expectedId) {
        errors.push(`${path}: $id must be '${expectedId}'`);
      }
      // Constructing the validator is the subset check (§25.7): a schema
      // reaching past the admitted keywords is refused at load, not at the
      // first record unlucky enough to exercise that branch.
      new SchemaValidator(schema);
      schemas.set(name, schema);
    } catch (error) {
      if (error instanceof JsonInputError || error instanceof SchemaSubsetError) {
        errors.push(error.message);
        continue;
      }
      throw error;
    }
  }
  return { schemas, errors };
}

/** Validate one instance against one schema, each complaint placed at `source`. */
export function schemaErrors(
  instance: unknown,
  schema: Record<string, unknown>,
  source: unknown,
): string[] {
  return new SchemaValidator(schema)
    .validate(instance)
    .map((error) => `${String(source)}: ${error.message}`);
}

/** Validate the §17.7 role/prompt/outcome bindings without echoing data. */
export function runnerManifestErrors(
  instance: unknown,
  source: unknown,
): string[] {
  if (!isObject(instance)) return [];
  const at = `${String(source)}`;
  const errors: string[] = [];

  const role = instance["role"];
  const promptBundle = instance["prompt_bundle"];
  const components = isObject(promptBundle) ? promptBundle["components"] : [];
  const entries = Array.isArray(components)
    ? components.filter((component): component is Record<string, unknown> =>
        isObject(component),
      )
    : [];
  const namedRunnerSchema = (component: Record<string, unknown>): boolean =>
    typeof component["id"] === "string" &&
    RUNNER_SCHEMA_COMPONENT_IDS.has(component["id"]);

  // §25.7/#41: v1 remains readable as the pre-runner historical shape, but it
  // cannot masquerade as #46 by naming a registered runner schema.
  if (instance["version"] === 1) {
    if (entries.some(namedRunnerSchema)) {
      errors.push(
        `${at}: legacy run-manifest v1 cannot claim runner transport schemas (§17.7)`,
      );
    }
    return errors;
  }
  if (instance["version"] !== 2) return errors;

  const expected =
    typeof role === "string" ? RUNNER_ROLE_SCHEMA_COMPONENTS.get(role) : undefined;
  if (expected !== undefined) {
    for (const componentId of expected) {
      const matches = entries.filter((component) => component["id"] === componentId);
      if (matches.length !== 1) {
        errors.push(
          `${at}: prompt bundle must contain '${componentId}' exactly once (§17.7)`,
        );
      } else if ((matches[0] as Record<string, unknown>)["version"] !== "1") {
        errors.push(
          `${at}: prompt bundle component '${componentId}' ` +
            "must declare version '1' (§17.7)",
        );
      }
    }
    const unexpected = entries.some(
      (component) =>
        namedRunnerSchema(component) &&
        !expected.includes(component["id"] as string),
    );
    if (unexpected) {
      errors.push(
        `${at}: prompt bundle contains a runner schema outside ` +
          "the selected role's closed pair (§17.7)",
      );
    }
  } else if (typeof role === "string" && RUNNER_UNSUPPORTED_ROLES.has(role)) {
    if (instance["outcome"] !== "aborted") {
      errors.push(
        `${at}: unsupported runner v1 role must close as aborted at preflight (§17.7)`,
      );
    }
    if (entries.some(namedRunnerSchema)) {
      errors.push(
        `${at}: unsupported runner v1 role has no registered transport schema pair (§17.7)`,
      );
    }
  }

  if (instance["outcome"] === "aborted") {
    const outputs = instance["outputs"];
    const warnings = instance["warnings"];
    const decisions = instance["decisions"];
    if (Array.isArray(outputs) && outputs.length > 0) {
      errors.push(`${at}: aborted runner execution must record no outputs (§17.7)`);
    }
    if (Array.isArray(decisions) && decisions.length > 0) {
      errors.push(`${at}: aborted runner execution must record no decisions (§17.7)`);
    }
    if (Array.isArray(warnings) && warnings.length === 0) {
      errors.push(
        `${at}: aborted runner execution must record a stable warning code (§17.7)`,
      );
    }
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) if (!right.has(name)) return false;
  return true;
}

// The oracle prints a sorted list of Python string reprs; the schema stems are
// all plain ASCII slugs, so single quotes are the whole of that repr.
function showNames(names: ReadonlySet<string>): string {
  return `[${[...names].sort().map((name) => `'${name}'`).join(", ")}]`;
}
