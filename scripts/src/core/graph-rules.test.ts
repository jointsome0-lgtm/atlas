import { describe, expect, test } from "bun:test";

import { EDGE_TYPES } from "./domain.ts";
import { emittedGraphErrors } from "./graph-rules.ts";

// The differential proves this pass answers what the Python answers over 91
// whole graphs, so nothing routine is repeated here. What is pinned is what
// agreement cannot pin: the one diagnostic the port deliberately spells
// differently, the §10.3 ownership table across the *whole* closed edge set
// rather than the third of it a real graph happens to carry, and the join that
// had to become a string key because a Python tuple is not a JavaScript one.

const PATH = "atlas/graph.json";
const FULL = "atlas-graph.json";

type Dict = Record<string, unknown>;

/** A graph carrying only what a test is about. */
function graph(nodes: Dict[], edges: Dict[] = [], rest: Dict = {}): Dict {
  return { nodes, edges, state: {}, projections: {}, ...rest };
}

const check = (instance: Dict): string[] =>
  emittedGraphErrors(instance, PATH, FULL, null);

describe("a value inside a diagnostic", () => {
  test("names a string as itself and anything else as JSON", () => {
    // A self-edge names its type, and the type is the one field a broken
    // emission can hand over as something other than a string. CPython would
    // print `None` and `42`; this port prints what JSON calls them, because
    // the identity in the message is the contract and the other language's
    // word for nothing is not (owner's verdict, 2026-08-14). No differential
    // case can cover this: the two sides disagree on purpose.
    const nodes = [{ id: "material:m", type: "material" }];
    const absent = check(
      graph(nodes, [{ source: "material:m", target: "material:m", type: null }]),
    );
    const numeric = check(
      graph(nodes, [{ source: "material:m", target: "material:m", type: 42 }]),
    );
    expect(absent).toEqual([
      `${PATH}: edges[0] null material:m applies to itself — endpoints must ` +
        "be two distinct nodes (§10.2)",
    ]);
    expect(numeric[0]).toContain("edges[0] 42 material:m applies to itself");
  });
});

describe("§10.3 provenance ownership", () => {
  // Two of the three ownership sets are *derived* — the authored roles minus
  // the symmetric ones — so a change to either domain set silently moves the
  // owner of an edge species that no fixture carries. Every member of the
  // closed §10.2 set is asked here, and the table is the answer, so a species
  // that quietly changed hands has to be written down to pass.
  const nodes = [
    { id: "concept:a", type: "concept" },
    { id: "concept:b", type: "concept" },
    { id: "suggested-route:r", type: "suggested_route" },
    { id: "material:m", type: "material" },
  ];
  const state = {
    state: {
      "concept:a": { exposure: "unseen" },
      "concept:b": { exposure: "unseen" },
    },
  };

  /** What the pass says the owner is, for an edge whose provenance names none. */
  function ownerOf(type: string): string | null {
    const errors = check(
      graph(
        nodes,
        [
          {
            source: "concept:a",
            target: "concept:b",
            type,
            context: "suggested-route:r",
            provenance: ["material:m"],
          },
        ],
        state,
      ),
    );
    const spoken = errors.find((message) => message.includes("provenance must include"));
    if (spoken === undefined) return null;
    const match = /provenance must include (?:an? )?(.*?) \(§10\.3\)$/.exec(spoken);
    return match === null ? spoken : (match[1] as string);
  }

  const EXPECTED: ReadonlyMap<string, string | null> = new Map([
    // Authored species (§9.3): the source authored the relation…
    ["prerequisite_of", "the authoring source concept:a"],
    ["extends", "the authoring source concept:a"],
    ["implements", "the authoring source concept:a"],
    ["contradicts", "the authoring source concept:a"],
    ["explains", "the authoring source concept:a"],
    ["demonstrates", "the authoring source concept:a"],
    ["critiques", "the authoring source concept:a"],
    ["mentions", "the authoring source concept:a"],
    ["loads", "the authoring source concept:a"],
    // …except the symmetric ones, where direction carries no meaning and
    // either endpoint may have written it down (§20.3).
    ["related_to", "authoring endpoint"],
    ["alternative_to", "authoring endpoint"],
    // Derived species owned by the record they hang off.
    ["has_part", "the authoring source concept:a"],
    ["overall_concept", "the authoring source concept:a"],
    ["visited", "the authoring source concept:a"],
    ["influences", "the authoring source concept:a"],
    ["updates_state", "the authoring source concept:a"],
    ["via", "the authoring source concept:a"],
    ["produced_artifact", "the authoring source concept:a"],
    ["moved_to", null], // the recording segment is neither endpoint (§9.9)
    // Derived species owned by what they point at.
    ["supports", "the owning target concept:b"],
    ["probed_by", "the owning target concept:b"],
    ["part_of_direction", "the owning target concept:b"],
    ["step_of_route", "the owning target concept:b"],
    ["pulled_by", "the owning target concept:b"],
    // The route is the context, not an endpoint.
    ["suggested_next", "the deriving route suggested-route:r"],
    // Contextual per §11.1–§11.3, checked against the payload instead.
    ["primary_for", null],
    ["supporting_for", null],
  ]);

  test("covers every member of the closed edge set", () => {
    expect(new Set(EXPECTED.keys())).toEqual(new Set(EDGE_TYPES));
  });

  for (const [type, owner] of EXPECTED) {
    test(`${type} is owned by ${owner ?? "no endpoint"}`, () => {
      expect(ownerOf(type)).toBe(owner);
    });
  }
});

describe("the edge identity key", () => {
  test("holds a missing discriminant apart from a present one", () => {
    // §20.3 identity is a Python tuple in the oracle and a string here.
    // Absence has to be written down as something, and whatever that is must
    // not collide with a value a real discriminant could take — otherwise the
    // port reports a duplicate the oracle cannot, on a graph both accept.
    const nodes = [
      { id: "concept:a", type: "concept" },
      { id: "suggested-route:r", type: "suggested_route" },
    ];
    const role = {
      source: "concept:a",
      target: "suggested-route:r",
      type: "primary_for",
    };
    const errors = check(
      graph(nodes, [role, { ...role, step: "concept:a" }], {
        state: { "concept:a": { exposure: "unseen" } },
      }),
    );
    expect(errors.filter((message) => message.includes("duplicates edge identity"))).toEqual(
      [],
    );
  });

  test("keeps a duplicate that agrees on every discriminant", () => {
    const nodes = [
      { id: "concept:a", type: "concept" },
      { id: "suggested-route:r", type: "suggested_route" },
    ];
    const role = {
      source: "concept:a",
      target: "suggested-route:r",
      type: "primary_for",
      step: "concept:a",
    };
    const errors = check(
      graph(nodes, [role, { ...role }], {
        state: { "concept:a": { exposure: "unseen" } },
      }),
    );
    expect(errors).toContain(
      `${PATH}: edges[1] duplicates edge identity primary_for concept:a -> ` +
        "suggested-route:r (§20.3)",
    );
  });
});

describe("the §32.6 redaction", () => {
  test("is compared by value, not by identity", () => {
    // The redacted state is a separate document that has been through a file;
    // it is never the same object as the sibling's, and a comparison that
    // asked whether it was would reject every honest redaction.
    const full = {
      nodes: [
        { id: "concept:a", type: "concept" },
        { id: "artifact:x", type: "artifact" },
      ],
      edges: [],
      state: { "concept:a": { exposure: "unseen", evidence: [], decisions: [] } },
      projections: {},
    };
    const out = {
      nodes: [{ id: "concept:a", type: "concept" }],
      edges: [],
      state: { "concept:a": { exposure: "unseen", evidence: [], decisions: [] } },
      projections: {},
      withheld: {
        nodes: 1,
        edges: 0,
        trails: 0,
        state: 0,
        influence: 0,
        frontier: 0,
        projections: 0,
      },
    };
    expect(out.state).not.toBe(full.state);
    expect(
      emittedGraphErrors(out, PATH, "atlas-graph.redacted.json", full),
    ).toEqual([]);
  });
});
