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

describe("what the writer will accept as a JSON value", () => {
  const lone = String.fromCharCode(0xd800);

  test("refuses an unpaired surrogate wherever it sits", () => {
    // UTF-8 has no encoding for one half, so writing it substitutes U+FFFD:
    // the file on disk would not hold the value that was handed over.
    for (
      const value of [
        lone,
        String.fromCharCode(0xdfff),
        { value: lone },
        { [lone]: 1 },
        [lone],
        [{ deep: { deeper: lone } }],
      ]
    ) {
      expect(() => stringifyRow(value)).toThrow(/lone-surrogate/);
      expect(() => stringifyDocument(value)).toThrow(/lone-surrogate/);
    }
    expect(stringifyRow("\u{1f600}")).toBe('"😀"');
  });

  test("refuses an object that is not a JSON object", () => {
    // Each of these has no own enumerable keys and would have been written as
    // `{}` — a document that emits, validates, and carries nothing.
    for (
      const value of [
        new Date(0),
        new Map([["a", 1]]),
        new Set([1]),
        /x/,
        new (class {
          a = 1;
        })(),
        Object(1),
        { at: new Date(0) },
      ]
    ) {
      expect(() => stringifyRow(value)).toThrow(/unserializable-json-value/);
    }
  });

  test("refuses an array that is not a plain dense array", () => {
    const extra: unknown[] & { note?: string } = [1];
    extra.note = "dropped in silence by an ordinary stringify";
    for (const value of [[1, , 3], extra, new (class extends Array {})()]) {
      expect(() => stringifyRow(value)).toThrow(/unserializable-json-value/);
    }
    expect(stringifyRow([1, 2])).toBe("[1,2]");
  });

  test("refuses keys an ordinary stringify would drop", () => {
    const hidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(hidden, "hidden", { value: 2, enumerable: false });
    for (
      const value of [
        { a: 1, [Symbol("s")]: 2 },
        hidden,
        {
          get a() {
            return 1;
          },
        },
      ]
    ) {
      expect(() => stringifyRow(value)).toThrow(/unserializable-json-value/);
    }
  });

  test("refuses a cycle but still writes a shared reference", () => {
    const self: Record<string, unknown> = {};
    self["self"] = self;
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first["second"] = second;
    const loop: unknown[] = [];
    loop.push(loop);
    for (const value of [self, first, loop]) {
      expect(() => stringifyRow(value)).toThrow(/cyclic-json-value/);
    }
    // Repetition is not recursion: the same object twice is ordinary data.
    const shared = { s: 1 };
    expect(stringifyRow({ x: shared, y: shared })).toBe(
      '{"x":{"s":1},"y":{"s":1}}',
    );
  });

  test("refuses the JavaScript values JSON has no room for", () => {
    for (const value of [undefined, () => 1, Symbol("s"), 1n, { a: undefined }]) {
      expect(() => stringifyRow(value)).toThrow(/unserializable-json-value/);
    }
  });

  test("refuses a value nested deeper than the reader accepts", () => {
    const nest = (n: number): unknown =>
      n === 0 ? 0 : [nest(n - 1)] as unknown;
    // Without a bound the writer emits documents its own reader refuses, and
    // past ~12,000 dies with a bare RangeError instead of a diagnostic.
    expect(() => stringifyRow(nest(MAX_JSON_DEPTH + 1))).toThrow(
      /nesting-too-deep/,
    );
    expect(() => stringifyDocument(nest(50_000))).toThrow(JsonDisciplineError);
    // The two sides accept exactly the same shapes at the boundary.
    const edge = "[".repeat(MAX_JSON_DEPTH) + "0" + "]".repeat(MAX_JSON_DEPTH);
    expect(stringifyRow(parseStrict(edge))).toBe(edge);
  });

  test("refuses a document key JavaScript would reorder", () => {
    // An index-like key is hoisted to the front in ascending numeric order, so
    // the insertion order the oracle would emit is already gone. The row form
    // sorts and is decided by content, so it stays writable.
    const numeric = { b: 1, "2": 2, "1": 3 };
    expect(() => stringifyDocument(numeric)).toThrow(/unorderable-json-key/);
    expect(stringifyRow(numeric)).toBe('{"1":3,"2":2,"b":1}');
    // Only a canonical index counts: these keep insertion order as written.
    expect(stringifyDocument({ "01": 1, "-1": 2, "1.0": 3, "": 4 })).toBe(
      '{\n  "01": 1,\n  "-1": 2,\n  "1.0": 3,\n  "": 4\n}\n',
    );
  });

  test("refuses exactly the keys the engine reorders, and no others", () => {
    // The rule is "JavaScript moved this key", so the test asks JavaScript
    // rather than restating the spec's array-index definition and hoping the
    // two agree. 4294967294 is an index; 4294967295 is the length limit and
    // is not — a hand-written bound is one off away from wrong here.
    const reordered = (key: string): boolean => {
      const probe: Record<string, unknown> = {};
      probe["zzz"] = 1;
      probe[key] = 2;
      return Object.keys(probe)[0] === key;
    };
    const refused = (key: string): boolean => {
      try {
        stringifyDocument({ zzz: 1, [key]: 2 });
        return false;
      } catch {
        return true;
      }
    };
    for (
      const key of [
        "0",
        "1",
        "10",
        "4294967293",
        "4294967294",
        "4294967295",
        "4294967296",
        "99999999999999999999",
        "1e2",
        "0.0",
        " 1",
        "+1",
        "-0",
        "-1",
        "01",
        "Infinity",
        "NaN",
        "",
        "1.0",
      ]
    ) {
      expect([key, refused(key)]).toEqual([key, reordered(key)]);
    }
  });

  test("the reader's domain is the row form's, and the document form is narrower", () => {
    // The one asymmetry in this module, pinned rather than left to be found:
    // the reader takes an index-like key, because a year-keyed map is an
    // ordinary foreign document and the row form — which every mandatory
    // byte-equality contract uses — writes it back exactly. Only the
    // order-bearing form has to refuse.
    const parsed = parseStrict('{"2026":"year","2025":"prior"}');
    expect(stringifyRow(parsed)).toBe('{"2025":"prior","2026":"year"}');
    expect(() => stringifyDocument(parsed)).toThrow(/unorderable-json-key/);
  });

  test("refuses an accessor inside an array, not only inside an object", () => {
    let reads = 0;
    const counting: unknown[] = [];
    Object.defineProperty(counting, "0", {
      get: () => ++reads,
      enumerable: true,
      configurable: true,
    });
    // This answered 1, then 2, then 3 — three different canonical forms for
    // one value.
    expect(() => stringifyRow(counting)).toThrow(/unserializable-json-value/);
    const hidden = [1];
    Object.defineProperty(hidden, "note", { value: 2, enumerable: false });
    expect(() => stringifyRow(hidden)).toThrow(/unserializable-json-value/);
  });

  test("refuses an array whose names are not exactly its indices", () => {
    // Length and key count both say one element, and there is no element: an
    // ordinary stringify writes `[null]`, and this writer used to promote the
    // named property into position 0 and write `[7]` — data the value never
    // held. Comparing each name to its position is what catches it.
    const invented: unknown[] & { note?: number } = [];
    invented.length = 1;
    invented.note = 7;
    expect(() => stringifyRow(invented)).toThrow(/unserializable-json-value/);
    const shifted: unknown[] = [];
    Object.defineProperty(shifted, "1", { value: "x", enumerable: true });
    expect(() => stringifyRow(shifted)).toThrow(/unserializable-json-value/);
  });

  test("refuses a Proxy, whose answers are not a function of the value", () => {
    let reads = 0;
    const shifting = new Proxy({ a: 1 }, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => ["a"],
      getOwnPropertyDescriptor: () => ({
        value: ++reads,
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    });
    // Wrote {"a":2} then {"a":4} — two canonical forms for one object, which
    // is the one thing a canonical form may not do.
    expect(() => stringifyRow(shifting)).toThrow(/unserializable-json-value/);
    expect(() => stringifyDocument([{ nested: shifting }])).toThrow(
      /unserializable-json-value/,
    );
    // A revoked one used to escape as a bare TypeError mid-write.
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    expect(() => stringifyRow(proxy)).toThrow(JsonDisciplineError);
  });

  test("names a cycle as a cycle even at the depth bound", () => {
    // Depth was tested first, so a cycle reached at exactly the bound was
    // reported as nesting-too-deep — the right refusal, pointing at the wrong
    // defect.
    const root: unknown[] = [];
    let tip = root;
    for (let i = 1; i < MAX_JSON_DEPTH; i += 1) {
      const next: unknown[] = [];
      tip.push(next);
      tip = next;
    }
    tip.push(root);
    expect(() => stringifyRow(root)).toThrow(/cyclic-json-value/);
  });

  test("writes what the reader produces", () => {
    // The reader hands back null-prototype objects; the round trip has to
    // close, or nothing read can ever be written back.
    const text = '{"__proto__":{"a":1},"b":[1,{"c":"d"}]}';
    expect(stringifyRow(parseStrict(text))).toBe(text);
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

  test("reads only the numbers the writer can write back", () => {
    // One domain, both directions: whatever comes out of the reader goes into
    // the writer unchanged. 9007199254740992 is where that stops — it is a
    // double, but ...993 is not, so a value at the boundary can no longer be
    // told apart from its neighbour and the writer already refuses it.
    expect(parseStrict("9007199254740991")).toBe(9007199254740991);
    for (
      const text of [
        "9007199254740992",
        "9007199254740993",
        "-9007199254740993",
      ]
    ) {
      expect(() => parseStrict(text)).toThrow(/unrepresentable-json-number/);
      expect(() => stringifyRow(Number(text))).toThrow(
        /unrepresentable-json-number/,
      );
    }
  });

  test("judges the value, not how it was spelled", () => {
    // The fraction and exponent forms used to return before the precision
    // check, so ...993e0 read as ...992 while the plain spelling was refused.
    for (
      const text of [
        "9007199254740992.0",
        "9007199254740993e0",
        "-9007199254740993e0",
      ]
    ) {
      expect(() => parseStrict(text)).toThrow(/unrepresentable-json-number/);
    }
    // The same value three ways, one answer each time.
    for (const text of ["1", "1.0", "1e0"]) expect(parseStrict(text)).toBe(1);
    for (const text of ["100", "1e2", "1E+2"]) {
      expect(parseStrict(text)).toBe(100);
    }
    // A fraction is refused: no Atlas schema declares one, and the oracle's
    // int/float split is not a distinction this port carries.
    for (const text of ["1.5", "0.1", "-2.5", "1e-1"]) {
      expect(() => parseStrict(text)).toThrow(/non-integer-json-number/);
    }
    // Written as a fraction but integral once rounded to a double, so it is
    // read as the integer it actually is. The imprecision is the format's.
    expect(parseStrict("1.0000000000000001")).toBe(1);
  });

  test("has one zero, whichever way it is written", () => {
    // -0 emits as "0", so returning -0 would hand back a value the writer
    // cannot put on disk unchanged. The oracle keeps the sign on -0.0 only
    // because it reads that one as a float; §25.7 has no signed zero.
    for (const text of ["0", "-0", "-0.0", "0.0", "-0e0"]) {
      expect(Object.is(parseStrict(text), 0)).toBe(true);
    }
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

});
