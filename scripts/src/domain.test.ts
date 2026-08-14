import { describe, expect, test } from "bun:test";

import {
  CONCEPT_EXPOSURE,
  DECISION_VALUES,
  GATED_DEFAULTS,
  INTAKE_KEY_RE,
  MATERIAL_DEPTH,
  NODE_ID_RE,
  PART_ID_RE,
  depthCeiling,
  exposureCeiling,
  freshnessOf,
  graphFieldExpectations,
  idType,
} from "./domain.ts";
import { CalendarError } from "./calendar.ts";

// The differential harness proves this module answers what the Python answers,
// constant for constant. What is pinned here is the rest: the one predicate
// the oracle disagrees with itself about, the recursion's termination, and the
// refusals a comparison of return values would read as agreement.

describe("an id's shape", () => {
  test("does not admit a trailing newline, as one oracle call site does", () => {
    // Python's `$` also matches before a trailing newline, so the oracle's own
    // call sites disagree: id validation calls `match` and takes
    // `"concept:a\n"`, evidence validation calls `fullmatch` and does not.
    // One predicate here, and it is the strict one — an id reaches a URL as a
    // §16.4 focus value, and a newline in one is not an id (#129).
    expect(NODE_ID_RE.test("concept:a")).toBe(true);
    expect(NODE_ID_RE.test("concept:a\n")).toBe(false);
    expect(PART_ID_RE.test("part:m/one")).toBe(true);
    expect(PART_ID_RE.test("part:m/one\n")).toBe(false);
    expect(INTAKE_KEY_RE.test("batch/entry#0")).toBe(true);
    expect(INTAKE_KEY_RE.test("batch/entry#0\n")).toBe(false);
  });

  test("is anchored at both ends, so an embedded newline cannot smuggle one", () => {
    expect(NODE_ID_RE.test("concept:a\nconcept:b")).toBe(false);
    expect(NODE_ID_RE.test("\nconcept:a")).toBe(false);
  });
});

describe("field membership", () => {
  test("terminates on a cycle instead of running out of stack", () => {
    // Two materials naming each other. The registry is never reached, so the
    // answer is empty — but the point is that there is an answer at all.
    const fields = graphFieldExpectations({
      nodes: [
        { id: "material:a", type: "material" },
        { id: "material:b", type: "material" },
      ],
      edges: [
        { source: "material:a", target: "material:b", type: "overall_concept" },
        { source: "material:b", target: "material:a", type: "overall_concept" },
      ],
    });
    expect(fields.get("material:a")).toEqual([]);
    expect(fields.get("material:b")).toEqual([]);
  });

  test("takes the union of every region it can reach, not the first", () => {
    const fields = graphFieldExpectations({
      nodes: [
        { id: "concept:a", type: "concept" },
        { id: "zone:z", type: "zone" },
        { id: "artifact:x", type: "artifact" },
      ],
      edges: [
        { source: "artifact:x", target: "concept:a", type: "influences" },
        { source: "artifact:x", target: "zone:z", type: "updates_state" },
      ],
    });
    expect(fields.get("artifact:x")).toEqual(["body", "knowledge"]);
  });

  test("answers only for the derived kinds, never for a region itself", () => {
    const fields = graphFieldExpectations({
      nodes: [
        { id: "concept:a", type: "concept" },
        { id: "material:m", type: "material" },
      ],
      edges: [],
    });
    // A concept's fields are pinned by its own schema, so the derivation has
    // nothing to say about it; a material's are derived and it does.
    expect(fields.has("concept:a")).toBe(false);
    expect(fields.get("material:m")).toEqual([]);
  });
});

describe("a ceiling", () => {
  const nodes = new Map<string, unknown>([
    ["artifact:read", { type: "artifact", evidence_strength: "read", observed_at: "2026-01-02" }],
    ["encounter:taught", { type: "encounter", depth: "taught" }],
  ]);

  test("survives evidence that is not a list of strings", () => {
    // A boundary check runs on input that already failed its schema, so every
    // one of these arrives in practice.
    for (const evidence of [[], [7], [null], [{}], ["missing:entirely"]]) {
      expect(exposureCeiling(evidence, nodes)).toBe(0);
      expect(depthCeiling(evidence, nodes)).toBe(0);
    }
  });

  test("stays an index into its own ladder", () => {
    expect(exposureCeiling(["artifact:read"], nodes)).toBeLessThan(CONCEPT_EXPOSURE.length);
    expect(depthCeiling(["encounter:taught"], nodes)).toBe(MATERIAL_DEPTH.length - 1);
  });
});

describe("freshness", () => {
  test("buckets are inclusive at both boundaries", () => {
    // Day 30 is still fresh and day 31 is not; day 90 is still aging and day
    // 91 is not. Both buckets take their own boundary (§14.7).
    expect(freshnessOf("2026-01-01", "2026-01-31")).toBe("fresh");
    expect(freshnessOf("2026-01-01", "2026-02-01")).toBe("aging");
    expect(freshnessOf("2026-01-01", "2026-04-01")).toBe("aging");
    expect(freshnessOf("2026-01-01", "2026-04-02")).toBe("stale");
  });

  test("refuses a stamp that is not a date rather than inventing an age", () => {
    expect(() => freshnessOf("not-a-date", "2026-01-01")).toThrow(CalendarError);
    expect(() => freshnessOf("2026-02-30", "2026-01-01")).toThrow(CalendarError);
  });
});

describe("the gated dimensions", () => {
  test("each default is a value its own decision vocabulary admits", () => {
    // A default outside its own scale would be a value no decision could ever
    // restore, so the gate would be one-way.
    for (const [dimension, fallback] of GATED_DEFAULTS) {
      expect(DECISION_VALUES.get(dimension)?.has(fallback)).toBe(true);
    }
  });
});

describe("an id's type", () => {
  test("is the prefix's kind, or nothing at all", () => {
    expect(idType("part:m/one")).toBe("material_part");
    expect(idType("suggested-route:r")).toBe("suggested_route");
    expect(idType("invented:thing")).toBe(null);
    expect(idType("")).toBe(null);
  });
});
