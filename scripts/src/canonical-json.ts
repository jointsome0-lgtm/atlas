import { compareCodePoint } from "./ordering.ts";

export class JsonDisciplineError extends Error {}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
    const point = character.codePointAt(0) as number;
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

function encode(
  value: unknown,
  sortKeys: boolean,
  indent: string | null,
  depth: number,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((item) => encode(item, sortKeys, indent, depth + 1));
    if (indent === null) return "[" + parts.join(",") + "]";
    const inner = indent.repeat(depth + 1);
    return "[\n" + inner + parts.join(",\n" + inner) + "\n" +
      indent.repeat(depth) + "]";
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (sortKeys) keys.sort(compareCodePoint);
    if (keys.length === 0) return "{}";
    const colon = indent === null ? ":" : ": ";
    const parts = keys.map(
      (key) =>
        encodeString(key) +
        colon +
        encode(record[key], sortKeys, indent, depth + 1),
    );
    if (indent === null) return "{" + parts.join(",") + "}";
    const inner = indent.repeat(depth + 1);
    return "{\n" + inner + parts.join(",\n" + inner) + "\n" +
      indent.repeat(depth) + "}";
  }

  throw new JsonDisciplineError(
    "unserializable-json-value; expected a JSON value",
  );
}

export function stringifyDocument(value: unknown): string {
  return encode(value, false, "  ", 0) + "\n";
}

export function stringifyRow(value: unknown): string {
  return encode(value, true, null, 0);
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

class StrictParser {
  private index = 0;
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
    throw new JsonDisciplineError("invalid-json; expected a JSON document");
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

  private parseValue(): JsonValue {
    const ch = this.text[this.index];
    if (ch === undefined) this.fail();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
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
    const result: { [key: string]: JsonValue } = {};
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
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 5;
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
      if (this.text.charCodeAt(this.index) < 0x20) this.fail();
      out += ch;
      this.index += 1;
    }
  }

  private parseNumber(): number {
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
    return value;
  }
}

export function parseStrict(text: string): JsonValue {
  return new StrictParser(text).parse();
}
