import { describe, expect, test } from "bun:test";

import { compareCodePoint, sortedByCodePoint } from "./ordering.ts";

describe("compareCodePoint", () => {
  test("orders by code point, not by UTF-16 code unit", () => {
    // The discriminator: U+FFFD is one unit (0xFFFD), U+10000 is the pair
    // 0xD800 0xDC00. By code point U+FFFD comes first; by code unit the
    // surrogate lead 0xD800 does. A default `.sort()` gets this backwards,
    // and the §20.3 endpoint sort runs before dedup, so the order it
    // produces is part of an edge's identity rather than a display detail.
    expect(compareCodePoint("�", "\u{10000}")).toBe(-1);
    expect("�" < "\u{10000}").toBe(false);
  });

  test("is a total order: reflexive, antisymmetric, transitive", () => {
    const values = ["", "a", "ab", "b", "A", "�", "\u{10000}", "é", "e"];
    for (const left of values) {
      expect(compareCodePoint(left, left)).toBe(0);
      for (const right of values) {
        // Negated explicitly rather than with unary minus, which turns a
        // zero result into -0 and fails an Object.is comparison.
        const backward = compareCodePoint(right, left);
        expect(compareCodePoint(left, right)).toBe(
          backward === 0 ? 0 : -backward,
        );
        for (const third of values) {
          if (
            compareCodePoint(left, right) < 0 &&
            compareCodePoint(right, third) < 0
          ) {
            expect(compareCodePoint(left, third)).toBeLessThan(0);
          }
        }
      }
    }
  });

  test("treats a prefix as smaller than its extension", () => {
    expect(compareCodePoint("", "a")).toBe(-1);
    expect(compareCodePoint("ab", "abc")).toBe(-1);
    expect(compareCodePoint("abc", "ab")).toBe(1);
  });

  test("ignores locale collation", () => {
    // Under a locale-aware comparison "a" and "A" can compare equal, and
    // accented letters can sort next to their base letter. Neither may
    // happen here: the order has to be the same on every machine.
    expect(compareCodePoint("A", "a")).toBe(-1);
    expect(compareCodePoint("z", "é")).toBe(-1);
  });
});

describe("sortedByCodePoint", () => {
  test("returns a new array and leaves the input untouched", () => {
    const input = Object.freeze(["b", "a"]) as readonly string[];
    expect(sortedByCodePoint(input)).toEqual(["a", "b"]);
    expect(input).toEqual(["b", "a"]);
  });

  test("places astral characters after every BMP character", () => {
    expect(sortedByCodePoint(["\u{10000}", "�", "a"])).toEqual([
      "a",
      "�",
      "\u{10000}",
    ]);
  });
});
