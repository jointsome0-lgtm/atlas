import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the graph builder against the CPython oracle.
//
// This is the whole of §20 in one comparison. The builder reads a curated
// tree and four journals and folds them into a single persisted artifact
// (§25.7), and every part of that artifact is promised: which nodes and edges
// exist, what payload each carries, the ORDER the keys are written in, the
// order the nodes and edges are sorted into, and the state map folded on top.
// So the comparison is the whole graph, byte for byte after one shared
// serializer, not a summary of it.
//
// The diagnostics are compared beside it, as a sequence. A build says two
// different kinds of thing — an error that stops it and a warning that does
// not — and the line between them is the product rule (§5.2, §34.2): a
// reference that broke because the owner deleted a record is a warning, the
// same shape authored in living curation is an error. Folding the two lists
// into one count would let that line move without anything noticing.
//
// The base tree exercises every pass and builds clean, so a complaint in any
// case belongs to that case's mutation. Each case declares what the oracle
// must say or count, which is what stops agreement about a pass neither side
// reached from reading as agreement about the pass.

import fs from "node:fs";

import { build } from "../src/build.ts";
import { foldParserProse, foldQuotes } from "./spelling.ts";

const DIFFERENTIAL = import.meta.dir;
const ROOT = `${DIFFERENTIAL}/../..`;

// ---------------------------------------------------------------------------
// The base instance
// ---------------------------------------------------------------------------

const row = (payload: Record<string, unknown>): string =>
  `${JSON.stringify(payload)}\n`;

const ALPHA = `---
id: concept:alpha
type: concept
title: Alpha
updated: 2026-01-02
aliases:
  - first
related_concepts:
  - concept:beta
concept_edges:
  - to: concept:beta
    role: prerequisite_of
    weight: high
  - to: concept:gamma
    role: alternative_to
    weight: low
    alternative_in:
      - concept:beta
---

Synthetic build fixture authored by Vera Example.
`;

// The survivor of a rename. The base leaves the retired spelling uncited, so
// that the §34.4 map exists in every case while resolving through it stays a
// case of its own — a base that warned would give every silent case a
// sentence to explain away.
const BETA = `---
id: concept:beta
type: concept
title: Beta
aliases: []
formerly:
  - concept:old-beta
---
`;

const GAMMA = `---
id: concept:gamma
type: concept
title: Gamma
aliases: []
---
`;

const ZONE = `---
id: zone:shoulders
type: zone
title: Shoulders
figure_region: torso-front-upper
---
`;

const PATTERN = `---
id: pattern:push-up
type: pattern
title: Push-up
concept_edges:
  - to: zone:shoulders
    role: loads
    weight: high
---
`;

const DOCS = `---
id: material:docs
type: material
title: Docs (Vera Example)
kind: docs
url: ""
status: active
overall_concepts:
  - concept:alpha
supported_by:
  - material:notes
parts:
  - id: part:docs/intro
    title: Intro
    concept_edges:
      - to: concept:beta
        role: implements
        weight: medium
      - to: concept:gamma
        role: mentions
    supported_by:
      - id: part:notes/basics
        note: Unpacks what the intro assumes.
---
`;

const NOTES = `---
id: material:notes
type: material
title: Notes (Vera Example)
kind: article
url: ""
status: active
overall_concepts:
  - concept:gamma
parts:
  - id: part:notes/basics
    title: Basics
---
`;

const DIRECTION = `---
id: direction:main
type: direction
title: Main direction
status: active
attractor: >
  Understand how the parts fit together.
core_concepts:
  - concept:alpha
  - concept:gamma
---
`;

const ROUTE = `---
id: suggested-route:default
type: suggested_route
title: Alpha then beta
status: available
steps:
  - concept:alpha
  - concept:beta
material_roles:
  - step: concept:alpha
    primary_materials:
      - material:docs
    supporting_materials:
      - material:notes
---
`;

const PROBE = `---
id: probe:recall
type: probe
title: Recall the alpha rule
status: active
concepts:
  - concept:alpha
---
`;

const SEGMENT = `---
id: trail-segment:2026-01-05-001
type: trail_segment
title: Alpha to beta
date: 2026-01-05
direction: direction:main
from:
  - concept:alpha
to: concept:beta
via:
  - material:docs
  - artifact:2026-01-05-001
reason: Worked through the intro and it landed.
resulting_questions:
  - question:why
---
`;

const ARTIFACTS =
  row({
    id: "artifact:2026-01-03-001",
    type: "note",
    path: "vera-example.md",
    observed_at: "2026-01-03",
    summary: "Read the intro (Vera Example).",
    touches: ["concept:gamma"],
    supports_state_updates: ["concept:alpha"],
    evidence_strength: "explained",
  }) +
  row({
    id: "artifact:2026-01-04-001",
    type: "note",
    path: "vera-example.md",
    observed_at: "2026-01-04",
    summary: "Reviewed the explanation (Vera Example).",
    touches: [],
    supports_state_updates: ["concept:alpha"],
    evidence_strength: "reviewed",
  }) +
  row({
    id: "artifact:2026-01-05-001",
    type: "note",
    path: "vera-example.md",
    observed_at: "2026-01-05",
    summary: "Notes on beta (Vera Example).",
    touches: ["concept:alpha", "concept:beta"],
    supports_state_updates: ["concept:beta"],
    evidence_strength: "read",
  });

const ENCOUNTERS =
  row({
    id: "encounter:2026-01-03-001",
    date: "2026-01-03",
    target: "material:docs",
    depth: "applied",
    mode: "question-driven",
    context: { question: "question:why", artifact: "artifact:2026-01-03-001" },
  }) +
  row({
    id: "encounter:2026-01-05-001",
    date: "2026-01-05",
    target: "material:notes",
    depth: "skim",
    mode: "background",
    context: { artifact: "artifact:2026-01-05-001" },
  });

const QUESTIONS = row({
  id: "question:why",
  type: "question",
  text: "Why does beta follow alpha? (Vera Example)",
  created_at: "2026-01-03",
  pulls: ["concept:alpha"],
  source: { artifact: "artifact:2026-01-03-001" },
});

const DECISIONS =
  row({
    date: "2026-01-04",
    target: "concept:alpha",
    dimension: "confidence",
    to: "medium",
    evidence: ["artifact:2026-01-03-001"],
    proposed_by: "state-auditor",
    decision: "confirmed",
  }) +
  row({
    date: "2026-01-05",
    target: "question:why",
    dimension: "status",
    to: "resolved",
    evidence: ["artifact:2026-01-05-001"],
    proposed_by: "state-auditor",
    decision: "confirmed",
  });

const BASE: Readonly<Record<string, string>> = {
  "concepts/alpha.md": ALPHA,
  "concepts/beta.md": BETA,
  "concepts/gamma.md": GAMMA,
  "zones/shoulders.md": ZONE,
  "patterns/push-up.md": PATTERN,
  "materials/docs.md": DOCS,
  "materials/notes.md": NOTES,
  "directions/main.md": DIRECTION,
  "suggested-routes/default.md": ROUTE,
  "trails/2026-01-05-001.md": SEGMENT,
  "probes/recall.md": PROBE,
  "state/artifacts.jsonl": ARTIFACTS,
  "state/encounters.jsonl": ENCOUNTERS,
  "state/questions.jsonl": QUESTIONS,
  "state/decisions.jsonl": DECISIONS,
};

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * What the oracle must say about a case, so agreement can never be vacuous.
 *
 * Every string in `says` must appear in some error and every string in
 * `warns` in some warning — not merely *a* complaint, but the one the case is
 * named for. `absent` carries the opposite claim: a case that exists to show
 * a clause staying quiet says which clause. `silent` is a build nothing may
 * be said about at all.
 *
 * A silent case has no sentence to name, so it claims counts instead: how
 * many nodes, edges and state entries the build produced. A case whose file
 * was never reached fails on the numbers rather than passing as agreement
 * about nothing.
 */
interface Expect {
  readonly says?: readonly string[];
  readonly warns?: readonly string[];
  readonly absent?: readonly string[];
  readonly silent?: boolean;
  readonly counts?: Readonly<Partial<Record<CountName, number>>>;
  /**
   * A phrase the raised message must carry, for the inputs a build refuses to
   * finish on rather than reports about. Those never reach the graph or the
   * two diagnostic lists, so they need a claim of their own or the case would
   * pass on the exception class alone.
   */
  readonly raises?: string;
}

type CountName = "nodes" | "edges" | "state" | "projections" | "graded";

interface Case extends Expect {
  readonly name: string;
  readonly files: Readonly<Record<string, string | null>>;
  /** An explicit §20.1 cut, or null for the default anchor. */
  readonly asOf: string | null;
  /** A tree already on disk, instead of one built from BASE. */
  readonly root?: string;
  /** The curated argument, relative to the case root (§8's two layouts). */
  readonly curated?: string;
}

const cases: Case[] = [];

function add(
  name: string,
  files: Record<string, string | null>,
  expect: Expect,
  options: { asOf?: string | null; root?: string; curated?: string } = {},
): void {
  const claims =
    (expect.says?.length ?? 0) +
    (expect.warns?.length ?? 0) +
    (expect.absent?.length ?? 0) +
    (expect.raises === undefined ? 0 : 1);
  if (expect.silent !== true && claims === 0) {
    throw new Error(`${name}: a case must claim something about the oracle`);
  }
  if (expect.silent === true && claims > 0) {
    throw new Error(`${name}: a silent case cannot also claim a diagnostic`);
  }
  if (expect.silent === true && expect.counts === undefined) {
    throw new Error(`${name}: a silent case must claim a count`);
  }
  cases.push({
    name,
    files,
    asOf: options.asOf ?? null,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.curated === undefined ? {} : { curated: options.curated }),
    ...expect,
  });
}

/** The base tree, with every curated document moved under `atlas/` (§8). */
function nested(): Record<string, string | null> {
  const moved: Record<string, string | null> = {};
  for (const [path, text] of Object.entries(BASE)) {
    if (path.startsWith("state/")) continue;
    moved[path] = null;
    moved[`atlas/${path}`] = text;
  }
  return moved;
}

// --- the base itself, and the shapes of the tree ---------------------------

add("base-builds-clean", {}, {
  silent: true,
  counts: { nodes: 19, edges: 35, state: 6, projections: 1, graded: 5 },
});

add("nested-atlas-layout", nested(), {
  silent: true,
  counts: { nodes: 19, edges: 35, state: 6, projections: 1, graded: 5 },
}, { curated: "atlas" });

add(
  "nested-layout-without-the-directory",
  { "concepts/alpha.md": null },
  { says: ["invalid-root"] },
  { curated: "atlas" },
);

add(
  "empty-instance",
  Object.fromEntries(Object.keys(BASE).map((path) => [path, null])),
  { silent: true, counts: { nodes: 0, edges: 0, state: 0, projections: 0 } },
);

add(
  "curated-root-is-missing",
  {},
  { says: ["invalid-root"] },
  { root: "/nonexistent-atlas-root" },
);

// --- §20.1 the fold anchor and the as-of cut -------------------------------

add("as-of-before-every-dated-input", {}, {
  warns: ["skipped", "(§20.1)"],
}, { asOf: "2026-01-01" });

add("as-of-mid-corpus", {}, {
  warns: ["skipped 6 dated input(s) after as-of 2026-01-03 (§20.1)"],
}, { asOf: "2026-01-03" });

add("as-of-after-every-dated-input", {}, {
  silent: true,
  counts: { nodes: 19, edges: 35, state: 6, graded: 5 },
}, { asOf: "2026-09-09" });

add(
  "no-dated-input-leaves-generated-at-absent",
  {
    "state/artifacts.jsonl": null,
    "state/encounters.jsonl": null,
    "state/questions.jsonl": null,
    "state/decisions.jsonl": null,
    "trails/2026-01-05-001.md": null,
  },
  { silent: true, counts: { nodes: 12, state: 3, graded: 0 } },
);

add(
  "byte-identical-duplicate-row-folds-once",
  { "state/questions.jsonl": QUESTIONS + QUESTIONS },
  { warns: ["byte-identical duplicate row folded once (§20.1)"] },
);

add(
  "rotated-prefix-then-tail",
  {
    "state/decisions/2026.jsonl": row({
      date: "2026-01-04",
      target: "concept:alpha",
      dimension: "confidence",
      to: "high",
      evidence: ["artifact:2026-01-03-001"],
      proposed_by: "state-auditor",
      decision: "confirmed",
    }),
  },
  { silent: true, counts: { nodes: 19, state: 6 } },
);

// A refused row is one row refused, and the reader goes on to the next. Every
// malformed-row case above this one puts its bad row last, where a reader that
// gave up on the whole file would look exactly like one that did not — which
// is how the builder came to share the boundary's BOM check and silently drop
// every row after a stray BOM on line 1.
add(
  "a-refused-row-does-not-end-the-file",
  {
    "state/questions.jsonl": "{not json at all\n" + QUESTIONS,
  },
  { says: ["invalid JSONL row"], counts: { nodes: 19, state: 6 } },
);

add(
  "a-BOM-is-a-refused-row-and-not-a-refused-journal",
  {
    // §25.8 scopes no-BOM to the boundary reader. The builder has no BOM check
    // at all: those three bytes are the front of a row that will not parse,
    // reported at line 1, after which line 2 is read like any other.
    "state/questions.jsonl": `﻿${row({
      id: "question:extra",
      type: "question",
      text: "Does this row survive? (Vera Example)",
      created_at: "2026-01-03",
      pulls: ["concept:gamma"],
      source: { artifact: "artifact:2026-01-03-001" },
    })}${QUESTIONS}`,
  },
  {
    says: ["invalid JSONL row"],
    absent: ["question:extra"],
    counts: { nodes: 19, state: 6 },
  },
);

add(
  "a-duplicate-row-spanning-the-rotation-boundary",
  // §20.1 makes the rotated files and the tail one journal, so the byte the
  // dedup set remembers has to be remembered across the file boundary too.
  { "state/questions/2026.jsonl": QUESTIONS },
  { warns: ["byte-identical duplicate row folded once (§20.1)"] },
);

add(
  "the-fold-position-counts-through-the-rotation-boundary",
  // §20.1 counts position through the whole concatenation, not per file. Both
  // rows below are line 1 of their own file and the same day, so a fold that
  // read the physical line number would call them equal — and §14.5's
  // explained-then-reviewed rule turns equality into `taught`.
  {
    "state/artifacts/2026.jsonl": row({
      id: "artifact:2026-01-06-001",
      type: "note",
      path: "vera-example.md",
      observed_at: "2026-01-06",
      summary: "Reviewed the beta write-up (Vera Example).",
      touches: [],
      supports_state_updates: ["concept:beta"],
      evidence_strength: "reviewed",
    }),
    "state/artifacts.jsonl":
      row({
        id: "artifact:2026-01-06-002",
        type: "note",
        path: "vera-example.md",
        observed_at: "2026-01-06",
        summary: "Explained beta to someone (Vera Example).",
        touches: [],
        supports_state_updates: ["concept:beta"],
        evidence_strength: "explained",
      }) + ARTIFACTS,
  },
  { silent: true, counts: { nodes: 21, state: 6 } },
);

// Two shapes CPython spells with `repr` and this port spells as JSON. The
// quote fold reaches a bare string and stops there: it has nothing to say
// about `None` against `null`, or about the space CPython puts after a key.
add(
  "a-material-role-attached-to-no-step-at-all",
  {
    "suggested-routes/default.md": ROUTE.replace(
      "  - step: concept:alpha\n    primary_materials:",
      "  - primary_materials:",
    ),
  },
  { says: ["is not a member of steps (§9.4)"] },
);

add(
  "an-encounter-context-that-is-not-one",
  {
    "state/encounters.jsonl": ENCOUNTERS.replace(
      '"context":{"question":"question:why","artifact":"artifact:2026-01-03-001"}',
      '"context":{"question":0}',
    ),
  },
  { says: ["is not a §9.7 context object"] },
);

add(
  "a-route-carrying-the-plan-it-came-from",
  { "suggested-routes/default.md": ROUTE.replace(
    "status: available",
    "status: available\nsource_plan: plan:learn-basics",
  ) },
  { warns: ["source_plan", "the ref dangles in this build"] },
);

// --- §34.4 retired ids -----------------------------------------------------

add(
  "retired-id-is-also-a-living-id",
  { "concepts/gamma.md": GAMMA.replace("aliases: []", "aliases: []\nformerly:\n  - concept:beta") },
  { says: ["is still a living id (§34.4)"] },
);

add(
  "one-retired-id-redirects-twice",
  { "concepts/gamma.md": GAMMA.replace("aliases: []", "aliases: []\nformerly:\n  - concept:old-beta") },
  { says: ["redirects to both"] },
);

add(
  "formerly-changes-kind",
  { "concepts/gamma.md": GAMMA.replace("aliases: []", "aliases: []\nformerly:\n  - material:old") },
  { says: ["changes kind"] },
);

add(
  "formerly-is-not-a-list",
  { "concepts/gamma.md": GAMMA.replace("aliases: []", "aliases: []\nformerly: concept:old-gamma") },
  { says: ["must be a list of ids (§34.4)"] },
);

add(
  "formerly-entry-is-not-canonical",
  { "concepts/gamma.md": GAMMA.replace("aliases: []", "aliases: []\nformerly:\n  - concept:Not_A_Slug") },
  { says: ["is not a canonical §10.1 id (§34.4)"] },
);

add(
  "stale-journal-ref-resolves",
  {
    "state/decisions.jsonl": DECISIONS + row({
      date: "2026-01-06",
      target: "concept:old-beta",
      dimension: "clarity",
      to: "stable",
      evidence: ["artifact:2026-01-05-001"],
      proposed_by: "state-auditor",
      decision: "confirmed",
    }),
  },
  { warns: ["stale journal ref concept:old-beta resolved to concept:beta (§34.4)"] },
);

// --- §20.3 normalization, dedup and cycles ---------------------------------

add(
  "symmetric-edge-authored-from-both-sides",
  {
    "concepts/gamma.md": GAMMA.replace(
      "aliases: []",
      "aliases: []\nrelated_concepts:\n  - concept:alpha",
    ),
    "concepts/alpha.md": ALPHA.replace(
      "  - concept:old-beta",
      "  - concept:old-beta\n  - concept:gamma",
    ),
  },
  { silent: true, counts: { nodes: 19, edges: 36 } },
);

// The base authors alpha -[alternative_to]-> gamma at `low`. Authored back
// from gamma at `high`, the §20.3 symmetry pass folds the two onto one
// identity, and there the two weights cannot both be right.
add(
  "conflicting-weights-on-one-identity",
  {
    "concepts/gamma.md": GAMMA.replace(
      "aliases: []",
      "aliases: []\nconcept_edges:\n  - to: concept:alpha\n" +
        "    role: alternative_to\n    weight: high",
    ),
  },
  { says: ["conflicting weights", "(§20.3)"] },
);

add(
  "prerequisite-cycle-warns-and-does-not-fail",
  {
    "concepts/beta.md": BETA.replace(
      "aliases: []",
      "aliases: []\nconcept_edges:\n  - to: concept:alpha\n    role: prerequisite_of\n    weight: high",
    ),
  },
  {
    warns: ["prerequisite_of cycle (usually a too-coarse concept cut, §20.3):"],
    absent: ["outside the §10.2"],
  },
);

add(
  "authored-self-edge-is-an-error",
  {
    "concepts/gamma.md": GAMMA.replace(
      "aliases: []",
      "aliases: []\nconcept_edges:\n  - to: concept:gamma\n    role: prerequisite_of\n    weight: high",
    ),
  },
  { says: ["applies to itself — endpoints must be two distinct nodes (§10.2)"] },
);

add(
  "derived-self-edge-only-warns",
  {
    "suggested-routes/default.md": ROUTE.replace(
      "  - concept:beta\n",
      "  - concept:beta\n  - concept:beta\n",
    ),
  },
  { warns: ["applies to itself — skipped (§10.2)"] },
);

// Two role edges alike in type, endpoints, context and order, and unlike only
// in the step they carry — which is the last key the §20.3 canonical order
// has, and the only case that can show it is read at all.
add(
  "two-role-edges-that-differ-only-by-step",
  {
    // The later step is authored first, so the order the two edges are
    // emitted in is the opposite of the order they belong in.
    "suggested-routes/default.md": ROUTE.replace(
      "material_roles:\n",
      "material_roles:\n  - step: concept:beta\n    primary_materials:\n" +
        "      - material:docs\n",
    ),
  },
  { silent: true, counts: { edges: 36 } },
);

// A cycle the walk reaches through a node that is not in it: alpha leads into
// beta, and beta and gamma lead into each other. The reported path is the
// loop, not the walk that found it.
add(
  "a-cycle-below-the-node-the-walk-started-from",
  {
    "concepts/beta.md": BETA.replace(
      "aliases: []",
      "aliases: []\nconcept_edges:\n  - to: concept:gamma\n" +
        "    role: prerequisite_of\n    weight: high",
    ),
    "concepts/gamma.md": GAMMA.replace(
      "aliases: []",
      "aliases: []\nconcept_edges:\n  - to: concept:beta\n" +
        "    role: prerequisite_of\n    weight: high",
    ),
  },
  { warns: ["§20.3): concept:beta -> concept:gamma -> concept:beta"] },
);

// --- §10.2 the endpoint matrix and §20 step 11 broken refs -----------------

add(
  "curated-endpoint-outside-the-matrix-row",
  {
    "probes/recall.md": PROBE.replace("  - concept:alpha", "  - material:docs"),
  },
  { says: ["must be"] },
);

add(
  "curated-link-to-a-missing-concept",
  {
    "directions/main.md": DIRECTION.replace(
      "  - concept:gamma",
      "  - concept:absent",
    ),
  },
  { says: ["broken curated link", "not found"] },
);

add(
  "journal-link-to-a-missing-concept-only-warns",
  {
    "state/artifacts.jsonl": ARTIFACTS + row({
      id: "artifact:2026-01-06-001",
      type: "note",
      path: "vera-example.md",
      observed_at: "2026-01-06",
      summary: "Touches a deleted concept (Vera Example).",
      touches: ["concept:deleted"],
      supports_state_updates: [],
      evidence_strength: "noticed",
    }),
  },
  { warns: ["missing — skipped (deletion is the owner's right)"] },
);

add(
  "curated-ref-to-a-deletable-kind-only-warns",
  {
    "trails/2026-01-05-001.md": SEGMENT.replace(
      "  - artifact:2026-01-05-001",
      "  - artifact:2026-01-09-999",
    ),
  },
  { warns: ["artifact:2026-01-09-999 missing"] },
);

add(
  "alternative-in-names-a-missing-concept",
  { "concepts/alpha.md": ALPHA.replace("      - concept:beta\n", "      - concept:absent\n") },
  { says: ["broken curated alternative_in ref"] },
);

add(
  "alternative-in-names-the-wrong-kind",
  { "concepts/alpha.md": ALPHA.replace("      - concept:beta\n", "      - material:docs\n") },
  { says: ["is not a concept/pattern id (§10.3)"] },
);

// --- §9.4 role steps -------------------------------------------------------

add(
  "role-step-is-not-a-member-of-steps",
  { "suggested-routes/default.md": ROUTE.replace("  - step: concept:alpha", "  - step: concept:gamma") },
  { says: ["is not a member of steps (§9.4)"] },
);

add(
  "one-material-is-both-primary-and-supporting",
  {
    "suggested-routes/default.md": ROUTE.replace(
      "      - material:notes",
      "      - material:docs",
    ),
  },
  { says: ["is both primary and supporting for step"] },
);

// --- §11.2 and §11.3 derived roles ----------------------------------------

add(
  "deep-use-encounter-makes-the-target-primary-for-the-question",
  {},
  { silent: true, counts: { edges: 35 } },
);

add(
  "a-shallow-encounter-derives-a-supporting-role",
  { "state/encounters.jsonl": ENCOUNTERS.replace('"depth":"applied"', '"depth":"skim"') },
  { silent: true, counts: { edges: 35 } },
);

add(
  "unevidenced-segment-origin",
  { "trails/2026-01-05-001.md": SEGMENT.replace("  - concept:alpha", "  - concept:gamma") },
  { warns: ["is not evidenced by the segment's own via context"] },
);

// --- §14.5–§14.8 the folds -------------------------------------------------

add(
  "explained-then-reviewed-reaches-taught",
  {},
  { silent: true, counts: { state: 6, graded: 5 } },
);

add(
  "a-review-that-predates-the-explanation-does-not-teach",
  {
    "state/artifacts.jsonl": ARTIFACTS.replace(
      '"observed_at":"2026-01-04"',
      '"observed_at":"2026-01-02"',
    ).replace('"id":"artifact:2026-01-04-001"', '"id":"artifact:2026-01-02-001"'),
  },
  { silent: true, counts: { state: 6, graded: 5 } },
);

add(
  "an-encounter-with-an-unknown-depth",
  { "state/encounters.jsonl": ENCOUNTERS.replace('"depth":"applied"', '"depth":"chewed"') },
  { says: ["depth"] },
);

// --- §9.13/§14.6 the decision fold ----------------------------------------

add(
  "a-rejected-proposal-cannot-return-on-the-same-evidence",
  {
    "state/decisions.jsonl":
      row({
        date: "2026-01-04",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "rejected",
      }) +
      row({
        date: "2026-01-05",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "confirmed",
      }),
  },
  { says: ["a rejected proposal cannot be re-proposed without new evidence (§14.6/§9.13)"] },
);

add(
  "a-rejected-proposal-returns-on-new-evidence",
  {
    "state/decisions.jsonl":
      row({
        date: "2026-01-04",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "rejected",
      }) +
      row({
        date: "2026-01-05",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001", "artifact:2026-01-05-001"],
        proposed_by: "state-auditor",
        decision: "confirmed",
      }),
  },
  { silent: true, counts: { state: 6 } },
);

// §20.1: the fold reads the journal in date order, not file order. The
// rejection here was appended after the retry but dated before it, so it is
// the rejection that comes first and the retry that is refused. A fold that
// walked the file as written would let the retry through — and the winner
// comparison alone cannot show this, because it reads the date too.
add(
  "a-rejection-dated-before-the-retry-that-was-appended-first",
  {
    "state/decisions.jsonl":
      row({
        date: "2026-01-05",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "confirmed",
      }) +
      row({
        date: "2026-01-04",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "rejected",
      }),
  },
  { says: ["a rejected proposal cannot be re-proposed without new evidence"] },
);

// §14.6: dropping a citation is not new evidence. The retry cites strictly
// less than the rejection did, so it is the same proposal made again — a rule
// that asked the two sets to be equal would let it through.
add(
  "a-rejected-proposal-cannot-return-on-less-evidence",
  {
    "state/decisions.jsonl":
      row({
        date: "2026-01-04",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001", "artifact:2026-01-04-001"],
        proposed_by: "state-auditor",
        decision: "rejected",
      }) +
      row({
        date: "2026-01-05",
        target: "concept:alpha",
        dimension: "confidence",
        to: "high",
        evidence: ["artifact:2026-01-03-001"],
        proposed_by: "state-auditor",
        decision: "confirmed",
      }),
  },
  { says: ["a rejected proposal cannot be re-proposed without new evidence"] },
);

add(
  "a-user-self-proposal-must-cite-the-owner-s-note",
  {
    "state/decisions.jsonl": DECISIONS.replaceAll(
      '"proposed_by":"state-auditor"',
      '"proposed_by":"user"',
    ),
    "state/artifacts.jsonl": ARTIFACTS.replaceAll('"type":"note"', '"type":"exercise"'),
  },
  { says: ["/evidence for a user self-proposal must cite the user's own note (§9.13)"] },
);

add(
  "a-decision-on-a-deleted-target-is-skipped",
  {
    "state/decisions.jsonl": DECISIONS.replace(
      '"target":"concept:alpha"',
      '"target":"concept:deleted"',
    ),
  },
  { warns: ["decision target skipped (deletion is the owner's right)"] },
);

add(
  "a-decision-keeps-a-dangling-evidence-ref",
  {
    "state/decisions.jsonl": DECISIONS.replace(
      '"evidence":["artifact:2026-01-03-001"]',
      '"evidence":["artifact:2026-01-01-999"]',
    ),
  },
  { warns: ["decision applies with a dangling evidence ref (§20.1)"] },
);

add(
  "a-stale-status-must-cite-the-owner-s-note",
  {
    "state/decisions.jsonl": DECISIONS.replace('"to":"resolved"', '"to":"stale"'),
    "state/artifacts.jsonl": ARTIFACTS.replaceAll('"type":"note"', '"type":"exercise"'),
  },
  { says: ["must cite the user's own note"] },
);

// --- §10.4 the node contract ----------------------------------------------

add(
  "a-material-without-its-required-payload",
  { "materials/notes.md": "---\nid: material:notes\ntype: material\ntitle: Notes\n---\n" },
  { says: ["material requires kind", "material requires url", "material requires status"] },
);

add(
  "a-segment-without-its-required-payload",
  {
    "trails/2026-01-05-001.md":
      "---\nid: trail-segment:2026-01-05-001\ntype: trail_segment\ntitle: Bare\n---\n",
  },
  { says: ["trail_segment requires"] },
);

add(
  "an-id-whose-prefix-contradicts-its-type",
  { "concepts/gamma.md": GAMMA.replace("id: concept:gamma", "id: material:gamma") },
  { says: ["prefix does not match type"] },
);

add(
  "an-id-outside-the-canonical-shape",
  { "concepts/gamma.md": GAMMA.replace("id: concept:gamma", "id: concept:Gamma_1") },
  { says: ["is not the canonical §10.1 shape"] },
);

add(
  "a-type-outside-the-closed-set",
  { "concepts/gamma.md": GAMMA.replace("type: concept", "type: notion") },
  { says: ["type 'notion', expected 'concept'"] },
);

// --- §32.6 the sensitivity union ------------------------------------------

add(
  "a-classed-artifact-taints-the-concept-it-updates",
  {
    "state/artifacts.jsonl": ARTIFACTS.replace(
      '"evidence_strength":"read"}',
      '"evidence_strength":"read","sensitivity":"medical"}',
    ),
  },
  { silent: true, counts: { state: 6 } },
);

add(
  "a-classed-via-taints-the-segment",
  {
    "state/artifacts.jsonl": ARTIFACTS.replace(
      '"evidence_strength":"read"}',
      '"evidence_strength":"read","sensitivity":"medical"}',
    ),
    "state/encounters.jsonl": ENCOUNTERS,
  },
  { silent: true, counts: { nodes: 19 } },
);

// --- the frontmatter and journal boundaries -------------------------------

add(
  "a-document-with-no-frontmatter",
  { "concepts/gamma.md": "Just prose, no fence.\n" },
  { raises: "frontmatter" },
);

add(
  "a-journal-row-that-is-not-an-object",
  { "state/questions.jsonl": "[1, 2, 3]\n" },
  { says: ["journal row is not an object"] },
);

add(
  "a-journal-row-with-CRLF",
  { "state/questions.jsonl": QUESTIONS.replace("\n", "\r\n") },
  { says: ["CR/CRLF is unsupported; use LF"] },
);

add(
  "a-journal-row-that-is-not-JSON",
  { "state/questions.jsonl": "{oops\n" },
  { says: ["invalid JSON"] },
);

add(
  "an-underscore-prefixed-document-is-skipped",
  { "concepts/_scratch.md": "---\nid: concept:scratch\ntype: concept\ntitle: Scratch\n---\n" },
  { silent: true, counts: { nodes: 19 } },
);

// --- the repository's own fixture -----------------------------------------

// A real tree under the repository root, which is the branch where an edge
// origin has the root stripped off it. Every case above lives in a temporary
// directory outside the root and therefore exercises the other branch.
add(
  "the-demo-instance-fixture",
  {},
  { warns: ["stale curated ref concept:restful-api resolved to concept:rest-api (§34.4)"] },
  { root: `${ROOT}/fixtures/demo-instance` },
);

add(
  "the-demo-instance-fixture-under-a-cut",
  {},
  { warns: ["§34.4"] },
  { root: `${ROOT}/fixtures/demo-instance`, asOf: "2026-01-01" },
);

// The same tree named through a root POSIX gives a meaning of its own. Exactly
// two leading slashes are an implementation-defined root and CPython keeps
// them; `path.resolve` throws them away, which would rename the caller's root
// and, here, strip a repository prefix that no longer matches. One slash is
// the difference between an origin the reader gave and one it invented.
add(
  "the-demo-instance-fixture-under-a-doubled-root",
  {},
  { warns: ["§34.4"] },
  { root: `/${ROOT}/fixtures/demo-instance` },
);

// The command line refuses an as-of that is not a date before a build starts,
// so this can only be reached by calling `build` directly — which the harnesses
// and any future caller do. Both sides refuse; they name the refusal
// differently, and the sentence after it differently again.
add(
  "an-as-of-that-is-not-a-date-at-all",
  {},
  // Whatever each side calls the failure, both name the value they refused.
  { raises: '"x"' },
  { asOf: "x" },
);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const workspace = fs.mkdtempSync("/tmp/atlas-build-");
const roots = cases.map((item, index) => {
  if (item.root !== undefined) return item.root;
  const root = `${workspace}/case-${String(index).padStart(3, "0")}`;
  const files: Record<string, string | null> = { ...BASE, ...item.files };
  for (const [relative, text] of Object.entries(files)) {
    if (text === null) continue;
    const target = `${root}/${relative}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
});
const curated = cases.map((item, index) =>
  item.curated === undefined ? (roots[index] as string) : `${roots[index]}/${item.curated}`,
);

const payload = JSON.stringify(
  curated.map((root, index) => ({ root, as_of: cases[index]?.asOf ?? null })),
);
interface OracleReport {
  graph?: Record<string, unknown>;
  errors?: string[];
  warnings?: string[];
  raised?: string;
  said?: string;
}
// This run's temporary roots are folded out of the question and the answer
// before either is written down, and folded back in for the comparison. The
// checkout itself joins them: the fixture cases name it through `..`, and the
// oracle answers with the path it resolved to, which is this machine's.
const folded = [...roots, fs.realpathSync(ROOT)];
const theirs = JSON.parse(
  unfoldRoots(
    oracleAnswer("build", foldRoots(payload, folded)) as string,
    folded,
  ),
) as OracleReport[];

/** Divergences that are understood, each pinned by the issue that holds it. */
const KNOWN: ReadonlyMap<string, string> = new Map([
  // A value inside a diagnostic is spelled as JSON here and as CPython `repr`
  // there. The quote fold reaches a bare string and no further: it has nothing
  // to say about `None` against `null`, or about the space CPython puts after
  // a key inside a mapping. §24.4 makes the place and the reason the contract
  // and the punctuation around a value not one. Recorded as #133.
  ["a-material-role-attached-to-no-step-at-all", "#133"],
  ["an-encounter-context-that-is-not-one", "#133"],
  // A refusal that crosses the language boundary: CPython raises `ValueError`
  // out of `date.fromisoformat` and this port raises `CalendarError` out of its
  // own calendar, with each one's own sentence. The class and the English are
  // not the contract; the CLI refuses this argument before a build starts, so
  // only a direct caller can reach it. Recorded as #134.
  ["an-as-of-that-is-not-a-date-at-all", "#134"],
]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
// A recorded divergence that quietly stopped diverging is a stale note about
// the port, and the next reader would believe it.
const stillDiverging = new Set<string>();

/** Both folds, in the one place a build diagnostic passes through. */
const spell = (text: string): string => foldParserProse(foldQuotes(text));

// The graph is not spelled through the folds: it is the persisted artifact
// (§25.7), and every byte of it is the promise. Only the prose around it is
// allowed to differ.
const shape = (report: OracleReport): string =>
  JSON.stringify({
    graph: report.graph ?? null,
    errors: (report.errors ?? []).map(spell),
    warnings: (report.warnings ?? []).map(spell),
  });

const tally = (graph: Record<string, unknown> | undefined): Record<CountName, number> => {
  const nodes = (graph?.["nodes"] as unknown[] | undefined) ?? [];
  const edges = (graph?.["edges"] as unknown[] | undefined) ?? [];
  const state = (graph?.["state"] as Record<string, unknown> | undefined) ?? {};
  const projections = (graph?.["projections"] as Record<string, unknown>) ?? {};
  return {
    nodes: nodes.length,
    edges: edges.length,
    state: Object.keys(state).length,
    projections: Object.keys(projections).length,
    graded: Object.values(state).filter(
      (entry) => typeof entry === "object" && entry !== null && "freshness" in entry,
    ).length,
  };
};

cases.forEach((item, index) => {
  const root = curated[index] as string;
  const oracle = theirs[index] as OracleReport;
  let ours: { graph: Record<string, unknown>; errors: string[]; warnings: string[] };
  try {
    const result = build(root, item.asOf);
    ours = {
      graph: result.graph as Record<string, unknown>,
      errors: result.errors,
      warnings: result.warnings,
    };
  } catch (error) {
    // A build does not catch everything: a document whose frontmatter cannot
    // be parsed at all raises out of it, and the CLI is what turns that into
    // an exit code. So a raise is part of what is being compared, not a
    // harness failure — the class and the sentence both, since the sentence
    // is the diagnostic the owner reads.
    const raised = (error as Error).name;
    const said = spell((error as Error).message);
    if (oracle?.raised === raised && spell(oracle.said ?? "") === said) {
      if (item.raises === undefined || !said.includes(item.raises)) {
        vacuous += 1;
        console.error(
          `build: ${item.name}: raised ${JSON.stringify(said)}, which does not ` +
            `carry ${JSON.stringify(item.raises ?? "")}`,
        );
      }
      return;
    }
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    console.error(
      `build: ${item.name}: raised ${raised} ${JSON.stringify(said)} — oracle ` +
        `${oracle?.raised ?? "returned"} ${JSON.stringify(spell(oracle?.said ?? ""))}`,
    );
    diverged += 1;
    return;
  }
  if (oracle?.raised !== undefined) {
    console.error(`build: ${item.name}: the oracle raised ${oracle.raised}`);
    diverged += 1;
    return;
  }
  const mineText = shape(ours);
  const theirsText = shape(oracle);
  if (mineText !== theirsText) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`build: ${item.name}`);
    // A whole graph is far too much to print on every divergence, so the
    // first difference is located and shown with what surrounds it.
    let at = 0;
    while (at < mineText.length && at < theirsText.length && mineText[at] === theirsText[at]) {
      at += 1;
    }
    const window = (text: string): string =>
      text.slice(Math.max(0, at - 120), at + 160).replaceAll(workspace, "…");
    console.error(`  at ${at} of ${mineText.length}/${theirsText.length}`);
    console.error(`  mine:   ${window(mineText)}`);
    console.error(`  oracle: ${window(theirsText)}`);
    return;
  }
  // Agreement about a pass neither side reached is not evidence about the
  // pass. Checked against the oracle's report, since that is the authority.
  const errors = oracle.errors ?? [];
  const warnings = oracle.warnings ?? [];
  const said = [...errors, ...warnings];
  const complaints: string[] = [];
  if (item.raises !== undefined) {
    complaints.push("finished the build instead of raising");
  }
  if (item.silent === true && said.length > 0) {
    complaints.push("said something about a build nothing may be said of");
  }
  for (const phrase of item.says ?? []) {
    if (!errors.some((message) => message.includes(phrase))) {
      complaints.push(`never said ${JSON.stringify(phrase)}`);
    }
  }
  for (const phrase of item.warns ?? []) {
    if (!warnings.some((message) => message.includes(phrase))) {
      complaints.push(`never warned ${JSON.stringify(phrase)}`);
    }
  }
  for (const phrase of item.absent ?? []) {
    if (said.some((message) => message.includes(phrase))) {
      complaints.push(`said ${JSON.stringify(phrase)}, which it must not`);
    }
  }
  const counted = tally(oracle.graph);
  for (const [name, wanted] of Object.entries(item.counts ?? {})) {
    const got = counted[name as CountName];
    if (got !== wanted) {
      complaints.push(`counted ${got} ${name}, not ${wanted}`);
    }
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`build: ${item.name}: the oracle ${complaints.join("; ")}`);
    for (const message of said) {
      console.error(`  ${message.replaceAll(workspace, "…")}`);
    }
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`build: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `build [TZ=${zone}]: ${cases.length} cases compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
