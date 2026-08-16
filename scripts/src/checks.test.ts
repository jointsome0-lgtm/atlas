import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  EVIDENCE_ID_RE,
  MATERIAL_ID_RE,
  REGION_ID_RE,
  ZONE_ID_RE,
  graphFieldErrors,
  newRejectedProposals,
  reproposalErrors,
  reviewGateErrors,
  snapshotDanglingRefs,
} from "./checks.ts";

// The differential proves these rules answer what the Python answers over 155
// cases, so nothing routine is repeated here. What is pinned is what agreement
// cannot pin: the one place the port deliberately spells a diagnostic
// differently, the id shapes as shapes rather than as one sampled string, and
// the proposal memory's key — a Python tuple that had to become a string, so a
// collision would be a defect this port invented and the oracle cannot have.

const PATH = "atlas/graph.json";

describe("a value inside a diagnostic", () => {
  test("is spelled as JSON, not as CPython's repr", () => {
    // The differential folds apostrophes into quotes, because quoting is the
    // usual difference and it is not a contract. These are the differences the
    // fold does not reach, and the choice is deliberate: the identity in the
    // message is the contract, and a port carrying `True` and `None` into
    // TypeScript would be preserving an accident of the implementation it
    // replaces (owner's verdict, 2026-08-14).
    const instance = {
      nodes: [
        { id: "concept:a", type: "concept" },
        { id: "material:m", type: "material", fields: [true, null, 1] },
      ],
      edges: [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    };
    const errors = graphFieldErrors(instance, PATH);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("[true, null, 1]");
    expect(errors[0]).toContain('["knowledge"]');
  });

  test("keeps the §-tag that identifies the rule", () => {
    // A message may be reworded; the tag is how an issue, a test and a reader
    // agree on which rule fired.
    const errors = snapshotDanglingRefs(
      { evidence_refs: { "concept:a": { kind: "concept" } } },
      PATH,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("§9.12");
  });
});

describe("the §10.1 id shapes", () => {
  // Each row is a shape, not a sample: the slug grammar, the one place a
  // material carries a second slug, and the anchoring. Python's `$` matches
  // before a trailing newline and the oracle's `fullmatch` does not (#129);
  // JavaScript's unflagged `$` is the end of the string, so the two agree —
  // but only because both were written that way, which is what this pins.
  const CASES: ReadonlyArray<readonly [RegExp, string, boolean]> = [
    [REGION_ID_RE, "concept:a", true],
    [REGION_ID_RE, "pattern:two-part-slug", true],
    [REGION_ID_RE, "zone:z", true],
    [REGION_ID_RE, "material:m", false],
    [REGION_ID_RE, "concept:A", false],
    [REGION_ID_RE, "concept:a-", false],
    [REGION_ID_RE, "concept:-a", false],
    [REGION_ID_RE, "concept:a--b", false],
    [REGION_ID_RE, "concept:a\n", false],
    [REGION_ID_RE, "\nconcept:a", false],
    [REGION_ID_RE, "concept:a/b", false],
    [EVIDENCE_ID_RE, "artifact:read", true],
    [EVIDENCE_ID_RE, "encounter:session", true],
    [EVIDENCE_ID_RE, "question:open", true],
    [EVIDENCE_ID_RE, "concept:a", false],
    [EVIDENCE_ID_RE, "artifact:read\n", false],
    [MATERIAL_ID_RE, "material:m", true],
    [MATERIAL_ID_RE, "part:m/one", true],
    [MATERIAL_ID_RE, "part:m/one/two", false],
    [MATERIAL_ID_RE, "part:m", false],
    [MATERIAL_ID_RE, "material:m/one", false],
    [MATERIAL_ID_RE, "material:m\n", false],
    [ZONE_ID_RE, "zone:z", true],
    [ZONE_ID_RE, "concept:a", false],
    [ZONE_ID_RE, "zone:z\n", false],
  ];

  test("admit exactly the ids the grammar describes", () => {
    const wrong = CASES.filter(([shape, id, ok]) => shape.test(id) !== ok).map(
      ([, id, ok]) => `${JSON.stringify(id)} should be ${ok ? "accepted" : "refused"}`,
    );
    expect(wrong).toEqual([]);
  });

  test("are not stateful, so a second call answers the same", () => {
    // A `g`-flagged regex would carry `lastIndex` between calls and refuse
    // every other id in a loop. None of these carries a flag; this fails
    // loudly if one ever gains one.
    for (const [shape] of CASES) expect(shape.flags).toBe("");
    expect([
      EVIDENCE_ID_RE.test("artifact:read"),
      EVIDENCE_ID_RE.test("artifact:read"),
    ]).toEqual([true, true]);
  });
});

describe("the memory of a rejected proposal", () => {
  const KNOWN = new Set(["concept:a", "concept:a-b"]);
  const NO_REDIRECTS = new Map<string, readonly string[]>();
  const propose = (over: Record<string, unknown>): Record<string, unknown> => ({
    target: "concept:a",
    dimension: "confidence",
    to: "solid",
    decision: "rejected",
    evidence: ["artifact:read"],
    ...over,
  });

  test("is keyed on all three parts of the proposal's identity", () => {
    // The oracle keys this on a tuple. A tuple is not a dict key in JavaScript,
    // so the three parts are joined into a string — and a join is only safe if
    // no two distinct triples can produce the same one. Each of these differs
    // from the rejected proposal in exactly one part and must go through.
    const rejected = newRejectedProposals();
    expect(reproposalErrors(propose({}), PATH, rejected, KNOWN, NO_REDIRECTS)).toEqual(
      [],
    );
    const others = [
      propose({ target: "concept:a-b", decision: "confirmed" }),
      propose({ dimension: "clarity", decision: "confirmed" }),
      propose({ to: "shaky", decision: "confirmed" }),
    ];
    for (const row of others) {
      expect(reproposalErrors(row, PATH, rejected, KNOWN, NO_REDIRECTS)).toEqual([]);
    }
    // And the identical triple does not.
    expect(
      reproposalErrors(
        propose({ decision: "confirmed" }),
        PATH,
        rejected,
        KNOWN,
        NO_REDIRECTS,
      ).length,
    ).toBe(1);
  });

  test("uses a separator no part of a proposal can carry", () => {
    // The join is only as safe as the separator's absence from the parts, and
    // every part is a slug or a slug pair (§10.1) — none of which holds a NUL.
    const SEPARATOR = "\u0000";
    const rejected = newRejectedProposals();
    reproposalErrors(propose({}), PATH, rejected, KNOWN, NO_REDIRECTS);
    expect([...rejected.keys()]).toEqual([
      ["concept:a", "confidence", "solid"].join(SEPARATOR),
    ]);
    expect(REGION_ID_RE.test(`concept:a${SEPARATOR}confidence`)).toBe(false);
  });

  test("is written into the source as an escape, not as the byte", () => {
    // A raw NUL in a source file makes it binary to grep, to `git diff` and to
    // every review tool that reads it: the separator is invisible in an editor
    // and the whole file goes quiet. It hid here for a while, which is the
    // reason this costs a test.
    const source = readFileSync(`${import.meta.dir}/checks.ts`, "utf8");
    expect(source.indexOf("\u0000")).toBe(-1);
  });
});

describe("a gated dimension with no decision", () => {
  test("is reported in a stable order whatever the entry's key order", () => {
    // The dimensions are walked in code-point order rather than in the order
    // they happen to sit in the document, so two graphs differing only in key
    // order produce the same diagnostics in the same sequence. Agreement with
    // the oracle would not notice: it sorts them too, and a port that dropped
    // the sort would still match on any single-key fixture.
    const entry = { confidence: "solid", clarity: "clear", coverage: "broad" };
    const reversed = { coverage: "broad", clarity: "clear", confidence: "solid" };
    const of = (value: Record<string, unknown>): string[] =>
      reviewGateErrors(value, PATH, 0, null, new Map(), "concept:a", "concept");
    const dimensions = of(entry).map(
      (error) => error.split(" moves ")[1]?.split(" ")[0],
    );
    expect(dimensions).toEqual(["clarity", "confidence", "coverage"]);
    expect(of(reversed)).toEqual(of(entry));
  });
});
