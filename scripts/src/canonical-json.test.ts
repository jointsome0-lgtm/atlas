import { describe, expect, test } from "bun:test";

import {
  JsonDisciplineError,
  MAX_JSON_DEPTH,
  parseStrict,
  stringifyDocument,
  stringifyRow,
} from "./canonical-json.ts";

// The differential harness proves these two forms byte-match CPython over a
// corpus. What is pinned here is the behaviour the oracle does *not* have:
// the places where §25.7 and §24.2 are deliberately stricter than Python's
// json module, plus the error taxonomy callers branch on.

describe("stringifyDocument", () => {
  test("indents by two and ends with a newline", () => {
    expect(stringifyDocument({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  test("preserves insertion order rather than sorting", () => {
    expect(stringifyDocument({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });

  test("keeps empty containers on one line", () => {
    expect(stringifyDocument({ a: {}, b: [] })).toBe(
      '{\n  "a": {},\n  "b": []\n}\n',
    );
  });

  test("emits non-ASCII literally", () => {
    expect(stringifyDocument("привет 🜂")).toBe('"привет 🜂"\n');
  });
});

describe("stringifyRow", () => {
  test("is compact, sorted, and unterminated", () => {
    expect(stringifyRow({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("sorts keys by code point at every depth", () => {
    expect(stringifyRow({ outer: { "\u{10000}": 1, "�": 2 } })).toBe(
      '{"outer":{"�":2,"\u{10000}":1}}',
    );
  });
});

describe("number discipline", () => {
  test("rejects non-finite numbers", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => stringifyRow(value)).toThrow(JsonDisciplineError);
    }
  });

  test("rejects fractions, which no Atlas schema declares", () => {
    // Every numeric field in spec/schemas is "integer"; a float reaching a
    // serialiser means something upstream invented one, so this fails closed
    // instead of committing a value whose text form is language-specific.
    expect(() => stringifyRow(1.5)).toThrow(JsonDisciplineError);
  });

  test("rejects integers past exact representation", () => {
    expect(() => stringifyRow(2 ** 53)).toThrow(JsonDisciplineError);
    expect(stringifyRow(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });
});

describe("parseStrict", () => {
  test("rejects duplicate keys at any depth", () => {
    // A reviver cannot see this: by the time it runs, the later value has
    // already overwritten the earlier one silently.
    for (const text of ['{"a":1,"a":2}', '{"o":{"a":1,"a":2}}']) {
      expect(() => parseStrict(text)).toThrow(/duplicate-json-key/);
    }
  });

  test("rejects the non-finite literals Python's parser accepts", () => {
    for (const text of ["NaN", "Infinity", "-Infinity"]) {
      expect(() => parseStrict(text)).toThrow(/non-finite-json-number/);
    }
  });

  test("rejects an overflowing exponent", () => {
    // CPython's strict loader catches only the three literals above, so it
    // admits 1e999 as inf. Canon forbids a non-finite number however it is
    // spelled, and canon outranks the oracle (#122).
    expect(() => parseStrict("1e999")).toThrow(/non-finite-json-number/);
  });

  test("rejects trailing content and trailing commas", () => {
    for (const text of ['{"a":1} x', '{"a":1,}', "[1,]", "01", "+1", ""]) {
      expect(() => parseStrict(text)).toThrow(JsonDisciplineError);
    }
  });

  test("accepts surrogate pairs written as escapes", () => {
    expect(parseStrict('"\\ud83d\\ude00"')).toBe("😀");
  });

  test("round-trips a document through the row form", () => {
    const text = '{"a":[1,{"b":null},true],"c":"д"}';
    expect(stringifyRow(parseStrict(text))).toBe(text);
  });

  test("keeps __proto__ as an ordinary member", () => {
    const parsed = parseStrict(
      '{"id":"artifact:1","__proto__":{"sensitivity":"medical"}}',
    ) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["__proto__", "id"]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    // The whole point: nothing about the parsed object changed, and no other
    // object learned anything from it.
    expect(stringifyRow(parsed)).toBe(
      '{"__proto__":{"sensitivity":"medical"},"id":"artifact:1"}',
    );
    expect(({} as Record<string, unknown>)["sensitivity"]).toBeUndefined();
  });

  test("counts a repeated __proto__ as a duplicate key", () => {
    expect(() => parseStrict('{"__proto__":1,"__proto__":2}')).toThrow(
      /duplicate-json-key/,
    );
  });

  test("refuses an integer no double can hold exactly", () => {
    // 9007199254740993 rounds to ...992, which is itself a "safe" integer —
    // so the check is an exact round-trip of the literal, not a range test.
    for (const text of ["9007199254740993", "-9007199254740993"]) {
      expect(() => parseStrict(text)).toThrow(/unrepresentable-json-number/);
    }
    expect(parseStrict("9007199254740992")).toBe(9007199254740992);
    // A float literal is a double in both languages; imprecision there is the
    // format's, not the port's.
    expect(parseStrict("1.0000000000000001")).toBe(1);
  });

  test("refuses an unpaired surrogate, escaped or raw", () => {
    for (
      const text of [
        '"\\ud800"',
        '"\\udfff"',
        '"\\ud800\\ud800"',
        '"\\ud800a"',
        `"${String.fromCharCode(0xd800)}"`,
      ]
    ) {
      expect(() => parseStrict(text)).toThrow(/lone-surrogate/);
    }
    expect(parseStrict('"\\ud83d\\ude00"')).toBe("😀");
  });

  test("refuses nesting past the stack-safety bound instead of crashing", () => {
    const deep = (n: number) => "[".repeat(n) + "0" + "]".repeat(n);
    expect(() => parseStrict(deep(50_000))).toThrow(JsonDisciplineError);
    expect(() => parseStrict(deep(MAX_JSON_DEPTH + 1))).toThrow(
      /nesting-too-deep/,
    );
    // The bound is stack safety, not policy: this parser also reads Atlas's
    // own schemas, the deepest of which nests 12.
    expect(stringifyRow(parseStrict(deep(MAX_JSON_DEPTH)))).toBe(
      deep(MAX_JSON_DEPTH),
    );
  });

  test("counts depth per branch, not per value read", () => {
    // Siblings must not accumulate: a wide-but-shallow document is legal.
    const wide = `[${Array.from({ length: 200 }, () => "[[1]]").join(",")}]`;
    expect(stringifyRow(parseStrict(wide))).toBe(wide);
  });

  test("reads -0 as an integer literal, keeping the sign only on a float", () => {
    // The oracle routes an integer literal through int(), which has no signed
    // zero; a float literal keeps it.
    expect(Object.is(parseStrict("-0"), 0)).toBe(true);
    expect(Object.is(parseStrict("-0.0"), -0)).toBe(true);
  });
});
