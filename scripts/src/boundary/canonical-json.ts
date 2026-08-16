// A runtime builtin, not a dependency: nothing is fetched or installed, and
// this module runs only under Bun (the viewer has its own contract layer and
// never imports it). There is no portable way to recognise a Proxy — that is
// the point of one — and a Proxy is the one value whose canonical form is not
// a function of the value, so the alternative is not "no import" but "no
// guarantee".
import { types } from "node:util";

import { compareCodePoint } from "./ordering.ts";

export class JsonDisciplineError extends Error {
  /**
   * The 1-based line the document stopped parsing on, for a syntax failure.
   *
   * Absent on every other refusal, and deliberately: the oracle raises
   * `JSONDecodeError` with a position for malformed text and a bare
   * `JsonDisciplineError` for a duplicate key or a non-finite number, so the
   * presence of a line is itself the distinction between the two, and callers
   * that format one shape for each read it that way. A line number is stable
   * diagnostic material under the cutover contract; the English tail is not.
   */
  readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(message);
    this.name = "JsonDisciplineError";
    this.line = line;
  }
}

/**
 * A JSON number the oracle would hold as a float rather than an int.
 *
 * Python has two numeric types and JavaScript has one, and the difference is
 * not academic: `isinstance(version, int)` is False for `1.0`, so an intake
 * envelope spelling its version that way is refused (§33.2) — while a parser
 * that folded `1.0` to `1` would accept the delivery and write it into the
 * instance. Every check that asks "is this an integer" is written as
 * `typeof value === "number"`, so wrapping the float is what makes those
 * checks answer the way the oracle's `isinstance` does, without any of them
 * having to know that floats exist.
 *
 * Nothing may write one: no Atlas schema declares a non-integer field, so a
 * float only ever exists between reading a foreign document and the schema
 * refusing it. The writer refuses it too, which is what keeps that true.
 */
export class JsonFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | JsonFloat
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// A guard against stack exhaustion, not a policy ceiling. §25.8's depth ≤ 8 is
// the *intake* reader's bound on foreign records; this same parser also reads
// Atlas's own closed schemas, and atlas-graph.schema.json nests 12 deep. So the
// bound here is the measured worst × ~5 rounded to a power of two, the way
// §25.8 derives its other ceilings. Without it a deeply nested document exits
// with a RangeError and a stack trace instead of a diagnostic, which §24.2 does
// not allow; the oracle has the same gap, raising RecursionError. Reader and
// writer share it, so neither can produce what the other refuses.
export const MAX_JSON_DEPTH = 64;

function tooDeep(): never {
  throw new JsonDisciplineError(
    `nesting-too-deep; expected a document nested at most ` +
      `${MAX_JSON_DEPTH} levels`,
  );
}

const ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function encodeString(value: string): string {
  let out = '"';
  for (const character of value) {
    // Iteration is by code point, so a well-formed pair arrives as one
    // character above 0xFFFF and never lands in this range. What does land
    // here is an unpaired half — which has no UTF-8 encoding, so writing it
    // out substitutes U+FFFD and changes the value on its way to disk. The
    // reader refuses the same thing; a writer that did not would leave the
    // one direction canon cannot check against an input document.
    const point = character.codePointAt(0) as number;
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new JsonDisciplineError(
        "lone-surrogate; expected paired surrogate escapes",
      );
    }
    const escape = ESCAPES.get(point);
    if (escape !== undefined) {
      out += escape;
    } else if (point < 0x20) {
      out += "\\u" + point.toString(16).padStart(4, "0");
    } else {
      out += character;
    }
  }
  return out + '"';
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new JsonDisciplineError(
      "non-finite-json-number; expected a finite JSON number",
    );
  }
  if (!Number.isInteger(value)) {
    throw new JsonDisciplineError(
      "non-integer-json-number; expected an integer JSON number",
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new JsonDisciplineError(
      "unrepresentable-json-number; expected an exactly representable integer",
    );
  }
  return String(value);
}

function unserializable(): never {
  throw new JsonDisciplineError(
    "unserializable-json-value; expected a JSON value",
  );
}

// `typeof value === "object"` is true of a Date, a Map, a Set, a RegExp, a
// boxed primitive and every class instance — all of which have no own
// enumerable keys and would have been written as `{}`. The document would
// emit, validate against a schema expecting an object, and carry nothing.
// Only two shapes are a JSON object here: a literal, and the null-prototype
// one the reader produces.
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Every own name must be an ordinary enumerable data property. A symbol key, a
// non-enumerable one, and an accessor are each invisible to `Object.keys` and
// would drop out of the document in silence. Taking the value out of the
// descriptor rather than off the container is what rules out the second read:
// an accessor that answers differently each time never gets called at all, so
// no canonical form can be built from two different answers.
function plainDataValues(container: object, keys: string[]): unknown[] {
  if (Object.getOwnPropertySymbols(container).length > 0) unserializable();
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined || !("value" in descriptor)) unserializable();
    return descriptor.value;
  });
}

// JavaScript orders an array-index-like key ahead of every other one, ascending
// — `{"b":1,"2":2,"1":3}` has key order 1, 2, b. The oracle keeps insertion
// order. The row form sorts, so content decides it and the two agree; the
// document form is emitter order, and for such a key that order was already
// lost when the object was built, before this writer saw it. No Atlas field
// name is a number, so refusing costs nothing and is the fail-closed half of
// §25.7 — better than emitting an order nothing chose.
//
// This is the one place the two forms do not share a domain, so it is worth
// being exact about the rule the rest of this module keeps: what the reader
// returns, the *row* writer can always write — that is the form journal rows,
// receipts and every mandatory byte-equality contract use. The document form
// is narrower by exactly this key shape. The reader still accepts it, because
// refusing would turn away an ordinary foreign document (a year-keyed map is
// a normal JSON idiom) over an order Atlas would never need to reproduce.
function isIndexLikeKey(key: string): boolean {
  const asNumber = Number(key);
  return (
    Number.isInteger(asNumber) &&
    asNumber >= 0 &&
    asNumber < 2 ** 32 - 1 &&
    String(asNumber) === key
  );
}

function encode(
  value: unknown,
  sortKeys: boolean,
  indent: string | null,
  depth: number,
  open: WeakSet<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);
  if (typeof value !== "object") unserializable();

  const container = value as object;
  // Every check below reflects on the container, and a Proxy answers each
  // reflection with arbitrary code — it can report Object.prototype, invent
  // keys, hide symbols, and return a different value for the same key on every
  // pass. Two writes of one object then produce two canonical forms, which is
  // the single property §25.7 exists to provide. A revoked one throws a bare
  // TypeError mid-write, which §24.2 does not allow either.
  if (types.isProxy(container)) unserializable();
  // After the Proxy defence, never before: `instanceof` reads the prototype,
  // which is a trap a revoked Proxy answers with a bare TypeError. A float can
  // be read but never written — it exists only long enough for a schema to
  // refuse the document that carried it.
  if (container instanceof JsonFloat) {
    throw new JsonDisciplineError(
      "non-integer-json-number; expected an integer JSON number",
    );
  }
  // Before the depth bound, not after: a cycle reached at exactly the bound is
  // a cycle, and saying "nesting-too-deep" would point at the wrong defect.
  // A repeated reference is fine and writes twice; a reference back into a
  // container still being written never terminates. Membership is dropped on
  // the way out so the two stay distinguishable.
  if (open.has(container)) {
    throw new JsonDisciplineError(
      "cyclic-json-value; expected an acyclic JSON value",
    );
  }
  // The reader refuses past this bound; a writer without it emits documents its
  // own reader will not take back, and dies at about 12,000 with a bare
  // RangeError instead of a diagnostic. Level is depth + 1, so the two sides
  // accept exactly the same shapes.
  if (depth >= MAX_JSON_DEPTH) tooDeep();
  open.add(container);
  try {
    if (Array.isArray(value)) {
      // The own enumerable names must be exactly 0..length-1, in order.
      // Counting them is not enough: `a.length = 1; a.note = 7` has one own
      // key and length 1, yet no element 0 — an ordinary stringify writes
      // `[null]` and this writer used to write `[7]`, inventing an element out
      // of a property that is not one. Comparing each name to its position
      // catches that, holes, extra properties and a subclassed array together;
      // the name count then catches a hidden own property, since an array's
      // names are `length` plus the indices and nothing else.
      if (Object.getPrototypeOf(value) !== Array.prototype) unserializable();
      const indices = Object.keys(value);
      if (indices.length !== value.length) unserializable();
      if (indices.some((key, position) => key !== String(position))) {
        unserializable();
      }
      if (Object.getOwnPropertyNames(value).length !== indices.length + 1) {
        unserializable();
      }
      const items = plainDataValues(value, indices);
      if (items.length === 0) return "[]";
      const parts = items.map((item) =>
        encode(item, sortKeys, indent, depth + 1, open)
      );
      if (indent === null) return "[" + parts.join(",") + "]";
      const inner = indent.repeat(depth + 1);
      return "[\n" + inner + parts.join(",\n" + inner) + "\n" +
        indent.repeat(depth) + "]";
    }

    if (!isPlainObject(container)) unserializable();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (Object.getOwnPropertyNames(record).length !== keys.length) {
      unserializable();
    }
    const values = plainDataValues(record, keys);
    if (sortKeys) {
      const order = keys
        .map((key, position) => [key, values[position]] as const)
        .sort((left, right) => compareCodePoint(left[0], right[0]));
      keys.length = 0;
      values.length = 0;
      for (const [key, item] of order) {
        keys.push(key);
        values.push(item);
      }
    } else if (keys.some(isIndexLikeKey)) {
      throw new JsonDisciplineError(
        "unorderable-json-key; expected keys JavaScript keeps in insertion order",
      );
    }
    if (keys.length === 0) return "{}";
    const colon = indent === null ? ":" : ": ";
    const parts = keys.map(
      (key, position) =>
        encodeString(key) +
        colon +
        encode(values[position], sortKeys, indent, depth + 1, open),
    );
    if (indent === null) return "{" + parts.join(",") + "}";
    const inner = indent.repeat(depth + 1);
    return "{\n" + inner + parts.join(",\n" + inner) + "\n" +
      indent.repeat(depth) + "}";
  } finally {
    open.delete(container);
  }
}

export function stringifyDocument(value: unknown): string {
  return encode(value, false, "  ", 0, new WeakSet()) + "\n";
}

export function stringifyRow(value: unknown): string {
  return encode(value, true, null, 0, new WeakSet());
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

class StrictParser {
  private index = 0;
  private depth = 0;
  private readonly text: string;

  // Spelled out rather than declared as a constructor parameter property:
  // those are not erasable, and every TypeScript source here is type-stripped
  // rather than compiled (§25.8).
  constructor(text: string) {
    this.text = text;
  }

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail();
    return value;
  }

  private fail(): never {
    // Counted from the failure point rather than tracked as the parser walks:
    // the scan is over text already read, it runs once per document and only
    // on the way out, and a running counter would have to be maintained by
    // every branch that advances the index — including the ones that advance
    // it past an escape or a surrogate pair.
    let line = 1;
    for (let at = this.text.indexOf("\n"); at >= 0 && at < this.index; ) {
      line += 1;
      at = this.text.indexOf("\n", at + 1);
    }
    throw new JsonDisciplineError("invalid-json; expected a JSON document", line);
  }

  private skipWhitespace(): void {
    while (
      this.index < this.text.length &&
      WHITESPACE.has(this.text.charCodeAt(this.index))
    ) {
      this.index += 1;
    }
  }

  private literal(word: string): boolean {
    if (this.text.startsWith(word, this.index)) {
      this.index += word.length;
      return true;
    }
    return false;
  }

  // Depth is counted here rather than inside the two container parsers, which
  // each return from several places. A refusal aborts the whole parse, so the
  // decrement needs no unwinding.
  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_JSON_DEPTH) tooDeep();
  }

  private parseValue(): JsonValue {
    const ch = this.text[this.index];
    if (ch === undefined) this.fail();
    if (ch === "{") {
      this.enter();
      const value = this.parseObject();
      this.depth -= 1;
      return value;
    }
    if (ch === "[") {
      this.enter();
      const value = this.parseArray();
      this.depth -= 1;
      return value;
    }
    if (ch === '"') return this.parseString();
    if (this.literal("true")) return true;
    if (this.literal("false")) return false;
    if (this.literal("null")) return null;
    if (
      this.text.startsWith("NaN", this.index) ||
      this.text.startsWith("Infinity", this.index) ||
      this.text.startsWith("-Infinity", this.index)
    ) {
      throw new JsonDisciplineError(
        "non-finite-json-number; expected a finite JSON number",
      );
    }
    return this.parseNumber();
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.index += 1;
    // Null-prototype, so that `__proto__` is an ordinary key. On a plain `{}`
    // it would hit Object.prototype's accessor instead: the key would vanish
    // from the parsed object with no diagnostic, and the input would choose
    // the prototype every absent field is then answered from. The oracle
    // treats it as an ordinary key and §24.2 forbids a partial object, so
    // both point the same way.
    const result = Object.create(null) as { [key: string]: JsonValue };
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail();
      const key = this.parseString();
      if (seen.has(key)) {
        throw new JsonDisciplineError(
          "duplicate-json-key; expected unique object keys",
        );
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail();
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ",") {
        this.index += 1;
        continue;
      }
      if (ch === "}") {
        this.index += 1;
        return result;
      }
      this.fail();
    }
  }

  private parseArray(): JsonValue[] {
    this.index += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ",") {
        this.index += 1;
        continue;
      }
      if (ch === "]") {
        this.index += 1;
        return result;
      }
      this.fail();
    }
  }

  private parseString(): string {
    this.index += 1;
    let out = "";
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined) this.fail();
      if (ch === '"') {
        this.index += 1;
        return out;
      }
      if (ch === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === undefined) this.fail();
        if (escape === "u") {
          const unit = this.readHexEscape();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (
              this.text[this.index] !== "\\" || this.text[this.index + 1] !== "u"
            ) {
              this.loneSurrogate();
            }
            this.index += 1;
            const low = this.readHexEscape();
            if (low < 0xdc00 || low > 0xdfff) this.loneSurrogate();
            out += String.fromCharCode(unit, low);
            continue;
          }
          if (unit >= 0xdc00 && unit <= 0xdfff) this.loneSurrogate();
          out += String.fromCharCode(unit);
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        const mapped = simple[escape];
        if (mapped === undefined) this.fail();
        out += mapped;
        this.index += 1;
        continue;
      }
      const unit = this.text.charCodeAt(this.index);
      if (unit < 0x20) this.fail();
      // Unreachable from a strict-UTF-8 decode, which cannot produce an
      // unpaired half; reachable from a string built in memory. Checking it
      // here is what makes "the returned string encodes to UTF-8" hold for
      // every caller rather than only for the reader path.
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = this.text.charCodeAt(this.index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) this.loneSurrogate();
        out += this.text.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) this.loneSurrogate();
      out += ch;
      this.index += 1;
    }
  }

  private readHexEscape(): number {
    const hex = this.text.slice(this.index + 1, this.index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
    this.index += 5;
    return Number.parseInt(hex, 16);
  }

  // The oracle accepts a lone surrogate and hands back a string that cannot be
  // encoded; here it would survive the parse and come back as U+FFFD on the way
  // out, so a parse-emit-parse cycle would change the value. §25.8 fixes every
  // Atlas-authored text as strict UTF-8, and §20.4's parser already refuses the
  // same escape, so the refusal is the canon's, not a new rule.
  private loneSurrogate(): never {
    throw new JsonDisciplineError(
      "lone-surrogate; expected paired surrogate escapes",
    );
  }

  private parseNumber(): number | JsonFloat {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    if (this.text[this.index] === ".") {
      this.index += 1;
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    const exponent = this.text[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    const literal = this.text.slice(start, this.index);
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(literal)) {
      this.fail();
    }
    const value = Number(literal);
    if (!Number.isFinite(value)) {
      throw new JsonDisciplineError(
        "non-finite-json-number; expected a finite JSON number",
      );
    }
    // Reading is where the oracle's two numeric types have to survive, because
    // downstream checks ask which one they got. A fraction or an exponent makes
    // a Python float, and a float is not an int: `{"version": 1.0}` fails the
    // envelope's integer test rather than passing it as 1. Refusing the whole
    // document here instead would be both stricter and more permissive than the
    // oracle at once — it would turn a structured `schema-invalid` report into
    // a bare `invalid-json`, and it would let `1.0` through as `1`.
    //
    // The literal decides, not the value: Python reads `1.0` as a float even
    // though the value is integral, so the spelling is what is asked.
    if (/[.eE]/.test(literal)) return new JsonFloat(value);
    if (!Number.isInteger(value)) {
      throw new JsonDisciplineError(
        "non-integer-json-number; expected an integer JSON number",
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new JsonDisciplineError(
        "unrepresentable-json-number; expected an exactly representable integer",
      );
    }
    // No signed zero survives: the writer emits "0" for both, so returning -0
    // would hand back a value it cannot write faithfully.
    if (Object.is(value, -0)) return 0;
    return value;
  }
}

export function parseStrict(text: string): JsonValue {
  return new StrictParser(text).parse();
}
