// The authored JSON Schema subset (§25.7). Not a JSON Schema implementation:
// a closed list of keywords, each one deliberately admitted, so a schema that
// reaches for anything else is refused rather than silently under-enforced.
//
// Ported from validate_atlas.SchemaValidator. The error *order* is part of the
// port — a caller reading the first message must read the same first message —
// so the checks below run in the same sequence as the oracle's.

import { compareCodePoint } from "./ordering.ts";
import { stringifyRow } from "./canonical-json.ts";

export class SchemaSubsetError extends Error {}

export type Schema = boolean | { readonly [key: string]: unknown };

/**
 * One refusal, split into the part that is a contract and the part that is
 * prose. `path` and `keyword` are what a caller may match on; `message` is for
 * a human and may be reworded (§24.4 keeps the rejected value out of both).
 */
export interface SchemaError {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

/**
 * The only JSON Schema keywords the authored schemas may use (§25.7).
 *
 * Exported so a differential can compare the set itself rather than infer it
 * from behaviour: a keyword quietly missing here is a rule quietly not
 * enforced, and every schema that uses it goes on validating clean.
 */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "pattern",
  "oneOf",
  "anyOf",
  "allOf",
  "if",
  "then",
  "minimum",
  "minItems",
  "uniqueItems",
  "minProperties",
]);

// §25.7 schemas declare a date by its shape, and JSON Schema cannot express
// calendar validity. The reader enforcing the shape enforces the calendar too:
// otherwise a clean preflight would still not predict the build, which parses
// the same fields and refuses 2026-02-30 (§9/§10).
const DATE_SHAPE_PATTERNS: ReadonlySet<string> = new Set([
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$",
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$",
]);

const DATE_ONLY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** Whether a string of the declared shape names a day that exists. */
export function isCalendarDate(value: string): boolean {
  let day: string;
  if (DATE_ONLY.test(value)) day = value;
  else if (DATE_TIME.test(value)) day = value.slice(0, 10);
  else return false;

  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  // Year zero is a shape, not a day: the proleptic Gregorian calendar the
  // oracle's `date.fromisoformat` implements starts at year 1, and the two
  // implementations must refuse the same strings or a graph dated `0000-…`
  // reads as an as-of here and as no as-of there (found by review, 2026-08-14).
  if (year < 1 || month < 1 || month > 12 || date < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return date <= (lengths[month - 1] as number);
}

// JSON Schema's `pattern` is an ECMA-262 regular expression, which is what a
// `RegExp` already is. The oracle has to rewrite every unescaped `$` to `\Z`
// because Python's `$` also matches before a trailing newline; nothing here
// needs that, and the flags stay empty on purpose — `m` would reintroduce
// exactly the multiline `$` the oracle is working around, and `u` would change
// what a lone surrogate in a pattern means.
const PATTERN_CACHE = new Map<string, RegExp>();

function ecmaSearch(pattern: string, instance: string): boolean {
  let compiled = PATTERN_CACHE.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(pattern);
    } catch (error) {
      throw new SchemaSubsetError(
        `invalid schema pattern: ${(error as Error).message}`,
      );
    }
    PATTERN_CACHE.set(pattern, compiled);
  }
  return compiled.test(instance);
}

/** Deep equality over JSON values, with no cross-type coercion. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (typeof left === "object") {
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const keys = Object.keys(l);
    return (
      keys.length === Object.keys(r).length &&
      keys.every(
        (key) =>
          Object.hasOwn(r, key) && jsonEqual(l[key], (r as Record<string, unknown>)[key]),
      )
    );
  }
  return left === right;
}

/**
 * Render a schema value for a diagnostic. Never an instance value (§24.4).
 *
 * A schema is authored, not delivered, so a value the canonical writer refuses
 * is a broken registry rather than hostile input — but it reaches here only
 * once something has already failed, and replacing a clear refusal with a
 * writer exception would hide the failure the caller came for.
 */
function show(value: unknown): string {
  // A closed key set and an enum are lists, and a reader comparing a
  // diagnostic against the one the previous implementation printed reads the
  // separators too. Members are spaced out the way the oracle's repr spaces
  // them; only the quote character differs, which every consumer of these
  // messages already folds.
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (isObject(value)) {
    const fields = Object.entries(value).map(
      ([key, member]) => `${show(key)}: ${show(member)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  try {
    return stringifyRow(value);
  } catch {
    return "<unrenderable schema value>";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON object, which is narrower than a JavaScript one.
 *
 * The oracle asks `isinstance(value, dict)`, and no Python value that is not a
 * dict answers yes. In this language a `Date`, a `Map` and every class
 * instance are objects, so the structural test above would call them objects
 * too and let `type: "object"` pass on a value the writer then refuses to
 * emit. Nothing the reader returns is anything but plain, so this only ever
 * turns away a value built in memory — where saying no is the honest answer.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function* schemaChildren(
  schema: Record<string, unknown>,
): Generator<[string, unknown]> {
  for (const keyword of ["properties", "$defs"] as const) {
    const value = schema[keyword];
    if (isObject(value)) {
      for (const [name, child] of Object.entries(value)) {
        yield [`${keyword}/${name}`, child];
      }
    }
  }
  for (const keyword of ["items", "additionalProperties", "if", "then"] as const) {
    const value = schema[keyword];
    if (isObject(value)) yield [keyword, value];
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const value = schema[keyword];
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        yield [`${keyword}/${index}`, child];
      }
    }
  }
}

/** Refuse a schema reaching past the admitted keyword list, before any use. */
export function checkSchemaSubset(schema: unknown, path = "#"): void {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) {
    throw new SchemaSubsetError(`${path}: schema must be an object or boolean`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new SchemaSubsetError(
        `${path}: unsupported schema keyword ${show(keyword)}`,
      );
    }
  }
  for (const [suffix, child] of schemaChildren(schema)) {
    checkSchemaSubset(child, `${path}/${suffix}`);
  }
}

export class SchemaValidator {
  readonly root: Schema;

  constructor(schema: Schema) {
    checkSchemaSubset(schema);
    this.root = schema;
  }

  /** Resolve one local `#/...` pointer, unescaping `~1` and `~0`. */
  resolve(ref: string): unknown {
    if (!ref.startsWith("#/")) {
      throw new SchemaSubsetError(
        `unsupported non-local schema reference ${show(ref)}`,
      );
    }
    let value: unknown = this.root;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isObject(value) || !Object.hasOwn(value, key)) {
        throw new SchemaSubsetError(`unresolved schema reference ${show(ref)}`);
      }
      value = value[key];
    }
    return value;
  }

  validate(instance: unknown): SchemaError[] {
    return this.validateAgainst(instance, this.root);
  }

  /**
   * Validate against one sub-schema — a `$defs` entry, say — while references
   * still resolve through the whole document.
   *
   * A definition is not a schema on its own: lift it out and every `#/$defs/…`
   * inside it stops resolving, so the sub-schema is the starting point and the
   * root stays the resolution context.
   *
   * `path` names where the instance sits in its container, so a record lifted
   * out of an envelope still says `$.records[3].id` and the reader can find it.
   */
  validateAgainst(
    instance: unknown,
    schema: unknown,
    path = "$",
  ): SchemaError[] {
    const errors: SchemaError[] = [];
    this.check(instance, schema, path, errors);
    return errors;
  }

  private matches(instance: unknown, schema: unknown): boolean {
    const errors: SchemaError[] = [];
    this.check(instance, schema, "$", errors);
    return errors.length === 0;
  }

  private check(
    instance: unknown,
    schema: unknown,
    path: string,
    errors: SchemaError[],
  ): void {
    if (schema === true) return;
    if (schema === false) {
      errors.push({ path, keyword: "false", message: `${path}: rejected by false schema` });
      return;
    }
    if (!isObject(schema)) {
      throw new SchemaSubsetError(`${path}: schema must be an object or boolean`);
    }

    if (Object.hasOwn(schema, "$ref")) {
      this.check(instance, this.resolve(schema["$ref"] as string), path, errors);
    }

    const expected = schema["type"];
    if (expected !== undefined && expected !== null) {
      let ok: boolean;
      switch (expected) {
        case "object":
          ok = isJsonObject(instance);
          break;
        case "array":
          ok = Array.isArray(instance);
          break;
        case "string":
          ok = typeof instance === "string";
          break;
        case "integer":
          // A fraction read from a document arrives as a `JsonFloat`, which is
          // an object, so `typeof` refuses it — and here is the boundary §24.2
          // asks for. No schema declares a non-integer field, and `isJsonObject`
          // wants a plain prototype, so a float fails every type this subset
          // has: it is refused by a schema, never by whatever would have
          // written it later. `Number.isInteger` covers a value built in
          // memory, which has no spelling to have been read from.
          ok = typeof instance === "number" && Number.isInteger(instance);
          break;
        default:
          throw new SchemaSubsetError(`unsupported schema type ${show(expected)}`);
      }
      if (!ok) {
        errors.push({
          path,
          keyword: "type",
          message: `${path}: expected type ${expected as string}`,
        });
        return;
      }
    }

    if (Object.hasOwn(schema, "const") && !jsonEqual(instance, schema["const"])) {
      errors.push({
        path,
        keyword: "const",
        message: `${path}: expected constant ${show(schema["const"])}`,
      });
    }
    if (Object.hasOwn(schema, "enum")) {
      const choices = schema["enum"] as unknown[];
      if (!choices.some((choice) => jsonEqual(instance, choice))) {
        errors.push({
          path,
          keyword: "enum",
          message: `${path}: value is outside allowed choices ${show(choices)}`,
        });
      }
    }
    if (Object.hasOwn(schema, "pattern") && typeof instance === "string") {
      const pattern = schema["pattern"] as string;
      if (!ecmaSearch(pattern, instance)) {
        errors.push({
          path,
          keyword: "pattern",
          message: `${path}: string does not match pattern ${show(pattern)}`,
        });
      } else if (DATE_SHAPE_PATTERNS.has(pattern) && !isCalendarDate(instance)) {
        // §24.4: the rejected value stays out of the diagnostic.
        errors.push({
          path,
          keyword: "calendar",
          message: `${path}: date shape is not a real calendar date (§9/§10)`,
        });
      }
    }
    if (
      Object.hasOwn(schema, "minimum") &&
      typeof instance === "number" &&
      Number.isInteger(instance) &&
      instance < (schema["minimum"] as number)
    ) {
      errors.push({
        path,
        keyword: "minimum",
        message: `${path}: value is below minimum ${schema["minimum"] as number}`,
      });
    }

    if (isJsonObject(instance)) {
      for (const key of (schema["required"] as string[] | undefined) ?? []) {
        if (!Object.hasOwn(instance, key)) {
          errors.push({
            path,
            keyword: "required",
            message: `${path}: missing required property ${show(key)}`,
          });
        }
      }
      const minProperties = schema["minProperties"];
      if (minProperties !== undefined && Object.keys(instance).length < (minProperties as number)) {
        errors.push({
          path,
          keyword: "minProperties",
          message: `${path}: has fewer properties than minimum ${minProperties as number}`,
        });
      }
      const properties = (schema["properties"] as Record<string, unknown>) ?? {};
      const additional = schema["additionalProperties"];
      for (const [key, value] of Object.entries(instance)) {
        const childPath = `${path}.${key}`;
        if (Object.hasOwn(properties, key)) {
          this.check(value, properties[key], childPath, errors);
        } else if (additional === false) {
          // §24.4: the rejected key name is rejected content — the closed key
          // set is the expectation shown instead.
          errors.push({
            path,
            keyword: "additionalProperties",
            message:
              `${path}: unknown property outside the closed key set ` +
              show(Object.keys(properties).sort(compareCodePoint)),
          });
        } else if (isObject(additional)) {
          this.check(value, additional, childPath, errors);
        }
      }
    }

    if (Array.isArray(instance)) {
      const minItems = schema["minItems"];
      if (minItems !== undefined && instance.length < (minItems as number)) {
        errors.push({
          path,
          keyword: "minItems",
          message: `${path}: has fewer items than minimum ${minItems as number}`,
        });
      }
      if (schema["uniqueItems"]) {
        for (const [index, item] of instance.entries()) {
          if (instance.slice(0, index).some((prior) => jsonEqual(item, prior))) {
            errors.push({
              path: `${path}[${index}]`,
              keyword: "uniqueItems",
              message: `${path}[${index}]: duplicate item`,
            });
          }
        }
      }
      if (isObject(schema["items"])) {
        for (const [index, item] of instance.entries()) {
          this.check(item, schema["items"], `${path}[${index}]`, errors);
        }
      }
    }

    if (Object.hasOwn(schema, "oneOf")) {
      const branches = schema["oneOf"] as unknown[];
      const count = branches.filter((branch) => this.matches(instance, branch)).length;
      if (count !== 1) {
        errors.push({
          path,
          keyword: "oneOf",
          message: `${path}: expected exactly one oneOf match, got ${count}`,
        });
      }
    }
    if (Object.hasOwn(schema, "anyOf")) {
      const branches = schema["anyOf"] as unknown[];
      if (!branches.some((branch) => this.matches(instance, branch))) {
        errors.push({
          path,
          keyword: "anyOf",
          message: `${path}: did not match any anyOf branch`,
        });
      }
    }
    for (const branch of (schema["allOf"] as unknown[] | undefined) ?? []) {
      this.check(instance, branch, path, errors);
    }
    if (Object.hasOwn(schema, "if")) {
      if (this.matches(instance, schema["if"]) && Object.hasOwn(schema, "then")) {
        this.check(instance, schema["then"], path, errors);
      }
    }
  }
}
