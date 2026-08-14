// Differential harness: the instance driver against the CPython oracle.
//
// The rules this driver dispatches to are proved next door, one harness per
// group. What is proved here is everything *between* them: which directories
// are walked and in what order, which file names are skipped, what state one
// pass leaves for the next, and which complaints are errors and which are
// warnings. None of that is visible in a rule's own test, and all of it is
// load-bearing — a diagnostic list is compared as a sequence, and the counts
// the command prints are read by CI.
//
// The base is the oracle's own whole-instance fixture: curated documents under
// `atlas/`, an extracted plan, two delivered batches, three journals, and the
// three emitted files. It validates clean, so any complaint a case produces is
// the mutation's and not the fixture's. Each case declares what the oracle
// must say about it, which is what keeps agreement from being agreement about
// a pass neither side reached.

import fs from "node:fs";

import { type InstanceReport, validateInstance } from "../src/validate.ts";
import { foldParserProse, foldQuotes } from "./spelling.ts";

const DIFFERENTIAL = import.meta.dir;
const SCRIPTS = `${DIFFERENTIAL}/..`;
const ROOT = `${DIFFERENTIAL}/../..`;

const ORACLE = `
import json, sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import validate_atlas as V

payload = json.load(sys.stdin)
out = []
for case in payload:
    try:
        errors, warnings, counts = V.validate_instance(Path(case["root"]))
        out.append({"errors": errors, "warnings": warnings, "counts": counts})
    except Exception as exc:  # noqa: BLE001 - the divergence is the report
        out.append({"raised": type(exc).__name__})
json.dump(out, sys.stdout)
`;

// ---------------------------------------------------------------------------
// The base instance
// ---------------------------------------------------------------------------

const CONCEPT = `---
id: concept:example
type: concept
title: Example
updated: 2026-07-16
aliases: []
related_concepts: []
concept_edges: []
---

Synthetic schema fixture authored by Vera Example.
`;

const MATERIAL = `---
id: material:example-docs
type: material
title: Example Docs (Vera Example)
kind: docs
url: ""
status: active
overall_concepts:
  - concept:example
parts:
  - id: part:example-docs/intro
    title: Intro
    formerly:
      - part:example-docs/old-intro
---
`;

const ROUTE = `---
id: suggested-route:example-default
type: suggested_route
title: Example route (Vera Example)
status: available
steps:
  - concept:example
material_roles:
  - step: concept:example
    primary_materials:
      - material:example-docs
---
`;

const PLAN_EXTRACT = `id: plan:example
title: Example plan
directions: []
concepts: []
materials: []
material_parts: []
suggested_routes: []
probes: []
notes: []
`;

const ARTIFACT_ROW = `{"id":"artifact:2026-07-16-001","type":"note","path":"notes/example.md","observed_at":"2026-07-16","summary":"Synthetic schema fixture.","touches":["concept:example"],"supports_state_updates":[],"evidence_strength":"noticed"}
`;

const DECISION_ROW = `{"date":"2026-07-16","target":"supports:part:b/y->part:a/x","dimension":"weight","to":"high","evidence":["artifact:2026-07-16-001"],"proposed_by":"user","decision":"confirmed"}
`;

const RECEIPT_ROWS = `{"intake":"watch-sync/2026-07-16-001#0","marker":"opened","date":"2026-07-16"}
{"intake":"watch-sync/2026-07-16-001#0","marker":"processed","date":"2026-07-16"}
`;

const INTAKE_BATCH = `{
  "format": "atlas-intake",
  "version": 1,
  "source": "watch-sync",
  "batch": "2026-07-16-001",
  "records": [
    {"kind": "question", "date": "2026-07-16", "text": "synthetic Vera Example question?"}
  ]
}
`;

const GRAPH = `{
  "format": "atlas-graph",
  "version": 1,
  "nodes": [{"id": "concept:example", "type": "concept", "title": "Example", "fields": ["knowledge"], "aliases": []}, {"id": "concept:other", "type": "concept", "title": "Other", "fields": ["knowledge"], "aliases": []}],
  "edges": [{"source": "concept:example", "target": "concept:other", "type": "related_to", "provenance": ["concept:example"], "weight": "low"}],
  "trails": [],
  "state": {"concept:example": {"exposure": "unseen", "confidence": "unknown", "clarity": "vague", "coverage": "none", "evidence": [], "decisions": []}, "concept:other": {"exposure": "unseen", "confidence": "unknown", "clarity": "vague", "coverage": "none", "evidence": [], "decisions": []}},
  "influence": {},
  "frontier": [],
  "projections": {}
}
`;

const SNAPSHOT = `{
  "format": "atlas-snapshot",
  "version": 1,
  "generated_at": "2026-07-16T00:00:00Z",
  "withheld": {
    "state": 0,
    "materials": 0,
    "trail": 0,
    "questions": 0,
    "evidence_refs": 0
  },
  "scales": {
    "concept": {
      "exposure": [
        "unseen",
        "touched",
        "read",
        "summarized",
        "applied",
        "taught"
      ],
      "confidence": [
        "unknown",
        "low",
        "medium",
        "high"
      ],
      "clarity": [
        "vague",
        "rough",
        "stable",
        "disputed"
      ],
      "coverage": [
        "none",
        "partial",
        "broad"
      ],
      "freshness": [
        "fresh",
        "aging",
        "stale"
      ]
    },
    "material": {
      "depth_reached": [
        "skim",
        "read",
        "summarized",
        "applied",
        "taught"
      ]
    },
    "pattern": {
      "exposure": [
        "unseen",
        "touched",
        "studied",
        "tried",
        "drilled",
        "reviewed"
      ],
      "confidence": [
        "unknown",
        "low",
        "medium",
        "high"
      ],
      "clarity": [
        "vague",
        "rough",
        "stable",
        "disputed"
      ],
      "coverage": [
        "none",
        "partial",
        "broad"
      ],
      "freshness": [
        "fresh",
        "aging",
        "stale"
      ]
    },
    "zone": {
      "contact": [
        "unseen",
        "touched",
        "loaded",
        "probed"
      ],
      "strength": [
        "unknown",
        "low",
        "medium",
        "high"
      ],
      "endurance": [
        "unknown",
        "low",
        "medium",
        "high"
      ],
      "mobility": [
        "unknown",
        "low",
        "medium",
        "high"
      ],
      "condition": [
        "unknown",
        "fine",
        "irritated",
        "recovering",
        "restricted",
        "chronic"
      ],
      "freshness": [
        "fresh",
        "aging",
        "stale"
      ]
    }
  },
  "evidence_refs": {
    "artifact:2026-07-16-001": {
      "kind": "artifact",
      "date": "2026-07-16"
    }
  },
  "state": {
    "concept:example": {
      "exposure": "applied",
      "evidence": [
        "artifact:2026-07-16-001"
      ],
      "decisions": [
        {
          "dimension": "confidence",
          "date": "2026-07-16",
          "evidence": [
            "artifact:2026-07-16-001"
          ]
        }
      ]
    }
  },
  "materials": {},
  "trail": [],
  "questions": []
}
`;

// The second delivery is the first one's bytes with CRLF line endings and its
// own batch name — a persisted format arriving from another operating system
// is a real delivery, not a malformed one (§25.7).
const INTAKE_BATCH_CRLF = INTAKE_BATCH.replaceAll("\n", "\r\n").replaceAll(
  '"2026-07-16-001"',
  '"2026-07-16-002"',
);

// §20/§32.6: the redacted variant is the full graph plus a withheld tally, and
// this fixture withholds nothing — the tally is zero across the board rather
// than absent, because absent is what the rule refuses.
const REDACTED_GRAPH = `${JSON.stringify(
  {
    ...(JSON.parse(GRAPH) as Record<string, unknown>),
    withheld: {
      nodes: 0,
      edges: 0,
      trails: 0,
      state: 0,
      influence: 0,
      frontier: 0,
      projections: 0,
    },
  },
  null,
  2,
)}\n`;

const BASE: Readonly<Record<string, string>> = {
  "atlas/concepts/example.md": CONCEPT,
  "atlas/materials/example-docs.md": MATERIAL,
  "atlas/suggested-routes/example-default.md": ROUTE,
  "plans/extracted/example.yaml": PLAN_EXTRACT,
  "state/artifacts.jsonl": ARTIFACT_ROW,
  "state/decisions.jsonl": DECISION_ROW,
  "state/receipts.jsonl": RECEIPT_ROWS,
  "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH,
  "intake/watch-sync/2026-07-16-002.json": INTAKE_BATCH_CRLF,
  "graph/atlas-graph.json": GRAPH,
  "graph/atlas-graph.redacted.json": REDACTED_GRAPH,
  "graph/atlas-snapshot.json": SNAPSHOT,
};

// A manifest that satisfies §17.6 and §17.7, for the runs pass.
const RUN_MANIFEST = JSON.stringify({
  format: "run-manifest",
  version: 2,
  run_id: "run:2026-07-21-001",
  role: "plan-importer",
  model: {
    provider: "example",
    id: "model-1",
    parameters: [{ name: "temperature", value: "0.2" }],
  },
  engine_revision: "0".repeat(40),
  runner_version: "0.1.0",
  runner_protocol: {
    version: 1,
    commit: "be83303bfbe3a1523c72ebaa3f0baa03389c5832",
  },
  prompt_bundle: {
    components: [
      { id: "plan-importer-core", version: "1", sha256: "a".repeat(64) },
      { id: "runner-plan-importer-input", version: "1", sha256: "c".repeat(64) },
      { id: "runner-plan-importer-output", version: "1", sha256: "d".repeat(64) },
    ],
    sha256: "b".repeat(64),
  },
  inputs: {
    included: [{ path: "plans/imported/example.md", bytes: 123 }],
    unavailable: [{ path: "atlas/concepts/example.md", reason: "excluded" }],
  },
  budget: {
    model_calls: 1,
    timeout_seconds: 600,
    input_bytes: 123,
    input_entries: 1,
  },
  timings: {
    started_at: "2026-07-21T10:00:00Z",
    ended_at: "2026-07-21T10:05:00Z",
  },
  outcome: "processed",
  outputs: ["report:plan:example"],
  warnings: [],
  decisions: [],
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * What the oracle must say about a case, so agreement can never be vacuous.
 *
 * `silent` is a whole instance nothing may be said about. Otherwise every
 * string in `says` must appear in some error and every string in `warns` in
 * some warning — not merely *a* complaint, but the one the case is named for,
 * which is the part a bare "something fired" guard cannot check. `absent`
 * carries the opposite claim: a case that exists to show a clause staying
 * quiet says which clause.
 *
 * A silent case has no sentence to name, so it claims a count instead: the
 * pass that was supposed to walk the mutation says how many things it walked,
 * and a case whose file was silently never reached fails on the number rather
 * than passing as agreement about nothing.
 */
interface Expect {
  readonly says?: readonly string[];
  readonly warns?: readonly string[];
  readonly absent?: readonly string[];
  readonly silent?: boolean;
  readonly counts?: Readonly<Partial<Record<CountName, number>>>;
}

type CountName = "frontmatter" | "rows" | "intake" | "emitted";

interface Case extends Expect {
  readonly name: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly links: Readonly<Record<string, string>>;
}

const cases: Case[] = [];

function add(
  name: string,
  files: Record<string, string | null>,
  expect: Expect,
  links: Record<string, string> = {},
): void {
  const claims =
    (expect.says?.length ?? 0) +
    (expect.warns?.length ?? 0) +
    (expect.absent?.length ?? 0);
  if (expect.silent !== true && claims === 0) {
    throw new Error(`${name}: a case must claim something about the oracle`);
  }
  if (expect.silent === true && claims > 0) {
    throw new Error(`${name}: a silent case cannot also claim a diagnostic`);
  }
  if (expect.silent === true && expect.counts === undefined) {
    throw new Error(`${name}: a silent case must claim a count`);
  }
  cases.push({ name, files, links, ...expect });
}

/** The curated documents, moved out of `atlas/` into the flat layout (§8). */
function flattened(): Record<string, string | null> {
  const moved: Record<string, string | null> = {};
  for (const [path, text] of Object.entries(BASE)) {
    if (!path.startsWith("atlas/")) continue;
    moved[path] = null;
    moved[path.slice("atlas/".length)] = text;
  }
  return moved;
}

/** A second concept document, for the cross-file id cases (§10.1, §34.4). */
function concept(id: string, formerly: readonly string[] = []): string {
  const retired =
    formerly.length === 0
      ? ""
      : `formerly:\n${formerly.map((old) => `  - ${old}\n`).join("")}`;
  return CONCEPT.replace("id: concept:example", `id: ${id}`).replace(
    "concept_edges: []\n",
    `concept_edges: []\n${retired}`,
  );
}

/** A question the decisions journal can aim a §9.8 status decision at. */
const QUESTION_ROW = `${JSON.stringify({
  id: "question:example",
  type: "question",
  text: "why?",
  created_at: "2026-07-16",
  pulls: ["concept:example"],
  source: { artifact: "artifact:2026-07-16-001" },
})}\n`;

/** One status-decision row, varied by whichever field the case is about. */
function statusDecision(over: Record<string, unknown>): string {
  return `${JSON.stringify({
    date: "2026-07-16",
    target: "question:example",
    dimension: "status",
    to: "resolved",
    evidence: ["artifact:2026-07-16-001"],
    proposed_by: "user",
    decision: "confirmed",
    ...over,
  })}\n`;
}

/** The first receipt row, which several journal cases repeat or respell. */
const FIRST_RECEIPT = `${RECEIPT_ROWS.split("\n")[0] as string}\n`;

// --- The walk itself: which trees are entered, and which files are skipped ---

add("layout: the fixture a real build would produce", {}, {
  silent: true,
  counts: { frontmatter: 4, rows: 4, intake: 2, emitted: 3 },
});

add("layout: curated documents in the flat spelling", flattened(), {
  silent: true,
  counts: { frontmatter: 4 },
});

add(
  "layout: a curated directory that is not under a directory",
  { ...flattened(), atlas: "not a directory\n" },
  { says: ["atlas: unsafe-path"], counts: { frontmatter: 0 } },
);

add(
  "layout: a curated directory reached through a symlink",
  { "atlas/concepts/example.md": null },
  { says: ["atlas/concepts: unsafe-path"], counts: { frontmatter: 3 } },
  { "atlas/concepts": "../plans" },
);

add(
  "layout: a journal reached through a symlink",
  { "state/artifacts.jsonl": null },
  { says: ["state/artifacts.jsonl: unsafe-path"], counts: { rows: 3 } },
  { "state/artifacts.jsonl": "../plans/extracted/example.yaml" },
);

add(
  "layout: a file in a curated directory that is not a document",
  { "atlas/concepts/notes.txt": "not frontmatter at all\n" },
  { silent: true, counts: { frontmatter: 4 } },
);

add(
  "layout: a curated document whose name marks it a draft",
  { "atlas/concepts/_draft.md": "not frontmatter at all\n" },
  { silent: true, counts: { frontmatter: 4 } },
);

add("layout: no intake at all", { "intake/watch-sync/2026-07-16-001.json": null, "intake/watch-sync/2026-07-16-002.json": null }, {
  silent: true,
  counts: { intake: 0, frontmatter: 4 },
});

add(
  "layout: no state at all",
  {
    "state/artifacts.jsonl": null,
    "state/decisions.jsonl": null,
    "state/receipts.jsonl": null,
  },
  { silent: true, counts: { rows: 0, frontmatter: 4 } },
);

add(
  "layout: a snapshot with no graph beside it",
  { "graph/atlas-graph.json": null, "graph/atlas-graph.redacted.json": null },
  { silent: true, counts: { emitted: 1 } },
);

// --- Curated frontmatter, and the ids it declares ---

add(
  "curated: a document with no frontmatter",
  { "atlas/concepts/broken.md": "no fences here\n" },
  { says: ["frontmatter line 1: opening fence must be the exact line"] },
);

add(
  "curated: an id with no kind prefix",
  { "atlas/materials/example-docs.md": MATERIAL.replace("material:example-docs", "materialexampledocs") },
  { says: ["$.id: string does not match pattern"] },
);

add(
  "curated: the same part id twice inside one material",
  {
    "atlas/materials/example-docs.md": MATERIAL.replace(
      "  - id: part:example-docs/intro\n    title: Intro\n",
      "  - id: part:example-docs/intro\n    title: Intro\n  - id: part:example-docs/intro\n    title: Again\n",
    ),
  },
  { says: ["duplicate id part:example-docs/intro"] },
);

add(
  "curated: the same concept id in two documents",
  { "atlas/concepts/twin.md": CONCEPT },
  { says: ["duplicate id concept:example"] },
);

add(
  "curated: a part id carrying another material's slug",
  {
    "atlas/materials/other-docs.md": MATERIAL.replace(
      "material:example-docs",
      "material:other-docs",
    ).replace(
      "    formerly:\n      - part:example-docs/old-intro\n",
      "",
    ),
  },
  { says: ["does not carry its material's slug 'other-docs'"] },
);

// --- §34.4: the retired map, and everything it spans ---

add(
  "retired: an id declared retired while it is still declared",
  {
    "atlas/concepts/a.md": concept("concept:aaa", ["concept:gone"]),
    "atlas/concepts/gone.md": concept("concept:gone"),
  },
  { says: ["formerly concept:gone on concept:aaa is still a living id (§34.4)"] },
);

add(
  "retired: two such ids, reported in sorted order",
  {
    "atlas/concepts/keeper.md": concept("concept:keeper", [
      "concept:zzz",
      "concept:aaa",
    ]),
    "atlas/concepts/aaa.md": concept("concept:aaa"),
    "atlas/concepts/zzz.md": concept("concept:zzz"),
  },
  {
    says: [
      "formerly concept:aaa on concept:keeper is still a living id (§34.4)",
      "formerly concept:zzz on concept:keeper is still a living id (§34.4)",
    ],
  },
);

add(
  "retired: one id redirected to two survivors",
  {
    "atlas/concepts/a.md": concept("concept:aaa", ["concept:old"]),
    "atlas/concepts/b.md": concept("concept:bbb", ["concept:old"]),
  },
  { says: ["retired id concept:old redirects to both concept:aaa and concept:bbb (§34.4)"] },
);

add(
  "retired: the same survivor claimed twice",
  { "atlas/concepts/a.md": concept("concept:aaa", ["concept:old", "concept:old"]) },
  { silent: true, counts: { frontmatter: 5 } },
);

add(
  "retired: a route step spelled with a retired id",
  {
    "atlas/concepts/example.md": CONCEPT.replace(
      "concept_edges: []\n",
      "concept_edges: []\nformerly:\n  - concept:old-example\n",
    ),
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "  - concept:example\nmaterial_roles",
      "  - concept:old-example\nmaterial_roles",
    ),
  },
  { warns: ["stale curated ref concept:old-example resolved to concept:example (§34.4)"] },
);

add(
  "retired: a route material spelled with a retired id",
  {
    "atlas/materials/example-docs.md": MATERIAL.replace(
      "status: active\n",
      "status: active\nformerly:\n  - material:old-docs\n",
    ),
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "      - material:example-docs",
      "      - material:old-docs",
    ),
  },
  { warns: ["stale curated ref material:old-docs resolved to material:example-docs (§34.4)"] },
);

// --- §9.4: the route checks deferred until the retired map is whole ---

add(
  "route: a role naming a step the route does not have",
  {
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "  - step: concept:example",
      "  - step: concept:other",
    ),
  },
  { says: ["material_roles[0].step concept:other is not a member of steps (§9.4)"] },
);

add(
  "route: steps that are not a list at all",
  {
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "steps:\n  - concept:example\n",
      "steps: concept:example\n",
    ),
  },
  {
    says: [
      "$.steps: expected type array",
      "material_roles[0].step concept:example is not a member of steps (§9.4)",
    ],
  },
);

add(
  "route: a role that is not an object",
  {
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "  - step: concept:example\n    primary_materials:\n      - material:example-docs\n",
      "  - notanobject\n",
    ),
  },
  { says: ["$.material_roles[0]: expected type object"] },
);

add(
  "route: one material in both roles at one step",
  {
    "atlas/suggested-routes/example-default.md": ROUTE.replace(
      "      - material:example-docs\n---\n",
      "      - material:example-docs\n    supporting_materials:\n      - material:example-docs\n---\n",
    ),
  },
  { says: ["material_roles[0] lists material:example-docs as both primary and supporting (§9.4)"] },
);

// --- §33.2: a delivery, and the place its own envelope names ---

add(
  "intake: an envelope missing a required key",
  { "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH.replace('  "format": "atlas-intake",\n', "") },
  { says: ["missing required property 'format'"] },
);

add(
  "intake: a delivery that is not JSON",
  { "intake/watch-sync/2026-07-16-001.json": "{not json\n" },
  { says: ["invalid JSON"], counts: { intake: 1 } },
);

add(
  "intake: a record the schema refuses inside an envelope it does not",
  {
    "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH.replace(
      '{"kind": "question", "date": "2026-07-16", "text": "synthetic Vera Example question?"}',
      '{"kind": "nope"}',
    ),
  },
  { warns: ["record refused per §33.2; delivery preserved as delivered"] },
);

add(
  "intake: an envelope naming a batch it was not delivered as",
  { "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH.replace('"batch": "2026-07-16-001"', '"batch": "2026-07-16-009"') },
  { says: ["envelope names watch-sync/2026-07-16-009, delivered as intake/watch-sync/2026-07-16-001.json (§33.2)"] },
);

add(
  "intake: a delivery one directory deeper than its source",
  {
    "intake/watch-sync/2026-07-16-001.json": null,
    "intake/watch-sync/extra/2026-07-16-001.json": INTAKE_BATCH,
  },
  { says: ["delivered as intake/watch-sync/extra/2026-07-16-001.json (§33.2)"] },
);

add(
  "intake: a batch name that is an absolute path",
  { "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH.replace('"batch": "2026-07-16-001"', '"batch": "/2026-07-16-001"') },
  {
    says: [
      "$.batch: string does not match pattern",
      "envelope names watch-sync//2026-07-16-001, delivered as intake/watch-sync/2026-07-16-001.json (§33.2)",
    ],
  },
);

add(
  "intake: a source with a trailing slash, which the join folds away",
  { "intake/watch-sync/2026-07-16-001.json": INTAKE_BATCH.replace('"source": "watch-sync"', '"source": "watch-sync/"') },
  { says: ["$.source: string does not match pattern"], absent: ["(§33.2)"] },
);

// --- §20.1: journals, their duplicates, and the order decisions fold in ---

add(
  "journal: a row repeated byte for byte",
  { "state/receipts.jsonl": RECEIPT_ROWS + FIRST_RECEIPT },
  { warns: ["state/receipts.jsonl:3: byte-identical duplicate row folded once (§20.1)"] },
);

add(
  "journal: a row the rotated prefix already carried",
  { "state/receipts/0001.jsonl": FIRST_RECEIPT },
  { warns: ["state/receipts.jsonl:1: byte-identical duplicate row folded once (§20.1)"] },
);

add(
  "journal: the same object spelled with different spacing",
  { "state/receipts.jsonl": `${RECEIPT_ROWS}{ ${FIRST_RECEIPT.slice(1)}` },
  { silent: true, counts: { rows: 5 } },
);

add(
  "journal: a status decision aimed at something that is not a question",
  { "state/decisions.jsonl": statusDecision({ target: "concept:example", to: "open" }) },
  { says: ["$.target: string does not match pattern"] },
);

add(
  "journal: a status decision naming a question the instance declares",
  {
    "state/decisions.jsonl": statusDecision({}),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { silent: true, counts: { rows: 5 } },
);

add(
  "journal: a status decision naming a question nothing declares",
  { "state/decisions.jsonl": statusDecision({}) },
  { silent: true, counts: { rows: 4 } },
);

// The rejection fold sorts by activity date and then by physical position, so
// a same-date pair is the only place the second half of that key is visible.
add(
  "journal: a rejection and its re-proposal on one date, in that order",
  {
    "state/decisions.jsonl":
      statusDecision({ decision: "rejected" }) + statusDecision({}),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { says: ["state/decisions.jsonl:2: a rejected proposal cannot be re-proposed without new evidence (§14.6/§9.13)"] },
);

add(
  "journal: the same two rows on one date, written the other way round",
  {
    "state/decisions.jsonl":
      statusDecision({}) + statusDecision({ decision: "rejected" }),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { silent: true, counts: { rows: 6 } },
);

add(
  "journal: a user self-proposal resting on something that is not a note",
  {
    "state/decisions.jsonl": statusDecision({ evidence: ["encounter:x"] }),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { says: ["/evidence for a user self-proposal must include a note artifact (§9.13)"] },
);

add(
  "journal: a rejected proposal made again on the same evidence",
  {
    "state/decisions.jsonl":
      statusDecision({ decision: "rejected" }) +
      statusDecision({ date: "2026-07-17" }),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { says: ["state/decisions.jsonl:2: a rejected proposal cannot be re-proposed without new evidence (§14.6/§9.13)"] },
);

add(
  "journal: the same pair written in the other physical order",
  {
    "state/decisions.jsonl":
      statusDecision({ date: "2026-07-17" }) +
      statusDecision({ decision: "rejected" }),
    "state/questions.jsonl": QUESTION_ROW,
  },
  { says: ["state/decisions.jsonl:1: a rejected proposal cannot be re-proposed without new evidence (§14.6/§9.13)"] },
);

// --- §17.6/§17.7: run manifests ---

add(
  "runs: a manifest that satisfies both bindings",
  { "runs/2026-07-21-001.json": RUN_MANIFEST },
  { silent: true, counts: { emitted: 4 } },
);

add(
  "runs: a manifest whose run_id is not its file name",
  { "runs/2026-07-21-002.json": RUN_MANIFEST },
  { says: ["run_id does not match the file name (§17.6)"] },
);

add(
  "runs: a prompt bundle missing both runner components",
  {
    "runs/2026-07-21-001.json": JSON.stringify({
      ...(JSON.parse(RUN_MANIFEST) as Record<string, unknown>),
      prompt_bundle: {
        components: [{ id: "plan-importer-core", version: "1", sha256: "a".repeat(64) }],
        sha256: "b".repeat(64),
      },
    }),
  },
  {
    says: [
      "prompt bundle must contain 'runner-plan-importer-input' exactly once (§17.7)",
      "prompt bundle must contain 'runner-plan-importer-output' exactly once (§17.7)",
    ],
  },
);

// --- The emitted files, reached by the loop this driver owns ---

// The only rule that reads across two emitted files: the driver has to carry
// the full graph out of one iteration of the loop and into the next.
add(
  "emitted: a redacted graph keeping the state of the node it withheld",
  {
    "graph/atlas-graph.redacted.json": (() => {
      const graph = JSON.parse(GRAPH) as Record<string, unknown>;
      graph["nodes"] = (graph["nodes"] as Array<Record<string, unknown>>).filter(
        (node) => node["id"] !== "concept:other",
      );
      graph["edges"] = [];
      graph["withheld"] = {
        nodes: 1,
        edges: 1,
        trails: 0,
        state: 0,
        influence: 0,
        frontier: 0,
        projections: 0,
      };
      return `${JSON.stringify(graph, null, 2)}\n`;
    })(),
  },
  {
    says: [
      "/state is not the whole-value §32.6 redaction of the full sibling graph",
      "/withheld/state does not match the full sibling graph (§20/§32.6)",
    ],
  },
);

add(
  "emitted: a redacted graph with no withheld tally",
  { "graph/atlas-graph.redacted.json": GRAPH },
  { says: ["the redacted graph must carry withheld (§20)"] },
);

// --- What only shows when two complaints have to be told apart ---
//
// Every case above raises one complaint in one place, and a single complaint
// cannot show whose turn it was, or that a pass carried on after the one
// before it failed. These do: each puts two diagnostics in flight at once,
// where dropping either of them, or swapping them, changes the answer.

add(
  "emitted: a graph that breaks its schema and its edges at the same time",
  {
    // A schema complaint does not end the graph's turn. The oracle validates
    // and then applies the §10.2 rules to the same file, so a graph wrong in
    // both ways is told about both — and a port that treated the schema as a
    // gate would report exactly half of this.
    "graph/atlas-graph.json": (() => {
      const graph = JSON.parse(GRAPH) as Record<string, unknown>;
      graph["format"] = "not-atlas-graph";
      graph["edges"] = [
        {
          source: "concept:example",
          target: "concept:missing",
          type: "related_to",
          provenance: ["concept:example"],
          weight: "low",
        },
      ];
      return `${JSON.stringify(graph, null, 2)}\n`;
    })(),
  },
  { says: ["format", "concept:missing"] },
);

add(
  "journals: the same row bytes in two different journals",
  {
    // Rows are deduplicated by their bytes, and the bytes are only a key
    // within one journal. `{}` fails both schemas, so if the two journals
    // shared a set the second complaint would vanish — and `{}` is the one
    // row every journal can spell identically.
    "state/artifacts.jsonl": "{}\n",
    "state/questions.jsonl": "{}\n",
  },
  { says: ["state/artifacts.jsonl:1", "state/questions.jsonl:1"] },
);

add(
  "journals: same-date re-proposals across a rotated file and the tail",
  {
    // §20.1 makes the rotated file the older prefix and `decisions.jsonl` the
    // newest tail. Rows that share a date are ordered by where they physically
    // arrived across the whole journal, so the position counter runs on from
    // one file into the next — and these two complaints are laid out to swap
    // if it restarts: the rotated file's re-proposal is its fourth row, and
    // the tail's is its first.
    //
    // Both complaints are the same sentence and differ only in the file that
    // drew them, which is what makes their order the whole of the evidence.
    "state/questions.jsonl": QUESTION_ROW,
    "state/decisions/2026-07-a.jsonl":
      statusDecision({ to: "resolved", decision: "rejected" }) +
      statusDecision({ to: "clarified", decision: "rejected" }) +
      statusDecision({ to: "stale", decision: "rejected" }) +
      statusDecision({ to: "resolved" }),
    "state/decisions.jsonl": statusDecision({ to: "clarified" }),
  },
  {
    says: [
      "state/decisions/2026-07-a.jsonl:4: a rejected proposal cannot be re-proposed",
      "state/decisions.jsonl:1: a rejected proposal cannot be re-proposed",
    ],
  },
);

add(
  "plans: an extract that is not spelled with a .yaml suffix",
  {
    // The oracle walks every file under `plans/extracted`, whatever it is
    // called. Narrowing that to one suffix would let an extract through
    // unchecked and silently — so this one parses, to be counted, and is
    // wrong only where the schema can see it.
    "plans/extracted/second.json": PLAN_EXTRACT.replace(
      "id: plan:example",
      "id: 12",
    ),
  },
  { says: ["second.json"], counts: { frontmatter: 5 } },
);

add(
  "order: the redacted graph and the snapshot complaining at once",
  {
    // The emitted files are walked graph, redacted graph, snapshot — the full
    // graph first because the redacted one is checked against it. Nothing
    // until now made the last two speak in the same run, so swapping them was
    // free; here the two complaints trade places.
    "graph/atlas-graph.redacted.json": GRAPH,
    "graph/atlas-snapshot.json": SNAPSHOT.replace(
      '"artifact:2026-07-16-001": {\n      "kind": "artifact",',
      '"artifact:2026-07-16-001": {\n      "kind": "encounter",',
    ),
  },
  {
    says: [
      "the redacted graph must carry withheld (§20)",
      "evidence_refs",
    ],
  },
);

add(
  "order: two curated directories complaining at once",
  {
    // `concepts` is walked before `zones`, and nothing until now has made both
    // speak in the same run. Reverse the walk and these two swap.
    "atlas/concepts/broken.md": "---\nid: 12\n---\n",
    "atlas/zones/broken.md": "---\nid: 34\n---\n",
  },
  { says: ["concepts/broken.md", "zones/broken.md"] },
);

add(
  "runs: a manifest that breaks its schema and its runner binding at once",
  {
    // The schema pass and the §17.7 binding pass both read this one file, and
    // until now no manifest has made both speak. Reverse the two pushes and
    // every other run case still passes.
    "runs/2026-07-21-001.json": JSON.stringify({
      ...(JSON.parse(RUN_MANIFEST) as Record<string, unknown>),
      run_id: 12,
      prompt_bundle: {
        components: [{ id: "plan-importer-core", version: "1", sha256: "a".repeat(64) }],
        sha256: "b".repeat(64),
      },
    }),
  },
  {
    says: [
      "run_id",
      "prompt bundle must contain 'runner-plan-importer-input' exactly once (§17.7)",
    ],
  },
);

add(
  "order: the other two curated directories complaining at once",
  {
    // The pair above is the first two entries of the walk; these are the
    // fourth and the sixth, and swapping them is invisible to it.
    "atlas/materials/broken.md": "---\nid: 12\n---\n",
    "atlas/suggested-routes/broken.md": "---\nid: 34\n---\n",
  },
  { says: ["materials/broken.md", "suggested-routes/broken.md"] },
);

add(
  "intake: an envelope naming no source at all",
  {
    // An empty source joins to the batch name alone — `PurePosixPath("") / "x"`
    // is `x` and not `/x` — so this delivery sits exactly where its envelope
    // says and draws no §33.2 complaint, only the schema's.
    "intake/watch-sync/2026-07-16-001.json": null,
    "intake/2026-07-16-001.json": INTAKE_BATCH.replace(
      '"source": "watch-sync"',
      '"source": ""',
    ),
  },
  { says: ["source"], absent: ["(§33.2)"] },
);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// One instance per case, so the oracle can walk the whole corpus in a single
// process and every diagnostic still carries the path it was found at. Both
// sides read the same bytes off the same disk, so nothing has to be folded
// away before comparing except the way the two languages quote a value.
const workspace = fs.mkdtempSync("/tmp/atlas-validate-instance-");
const roots = cases.map((item, index) => {
  const root = `${workspace}/case-${String(index).padStart(3, "0")}`;
  const files: Record<string, string | null> = { ...BASE, ...item.files };
  for (const [relative, text] of Object.entries(files)) {
    if (text === null) continue;
    const target = `${root}/${relative}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, text);
  }
  // Links last: a link standing where a directory would be cannot be written
  // through, so the files it replaces have to exist — or not — first.
  for (const [relative, destination] of Object.entries(item.links)) {
    const target = `${root}/${relative}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(destination, target);
  }
  return root;
});

const payload = JSON.stringify(roots.map((root) => ({ root })));
const run = Bun.spawnSync(["python3", "-c", ORACLE], {
  stdin: Buffer.from(payload),
});
if (run.exitCode !== 0) {
  console.error("validate-instance: the oracle failed");
  console.error(run.stderr.toString());
  process.exit(1);
}
const theirs = JSON.parse(run.stdout.toString()) as Array<{
  errors?: string[];
  warnings?: string[];
  counts?: Record<string, number>;
  raised?: string;
}>;

/** Divergences that are understood, each pinned by the issue that holds it. */
const KNOWN: ReadonlyMap<string, string> = new Map([]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
// A recorded divergence that quietly stopped diverging is a stale note about
// the port, and the next reader would believe it.
const stillDiverging = new Set<string>();

/** Both folds, in the one place a whole-instance diagnostic passes through. */
const spell = (text: string): string => foldParserProse(foldQuotes(text));

const shape = (report: {
  errors?: string[];
  warnings?: string[];
  counts?: Record<string, number>;
}): string =>
  JSON.stringify({
    errors: (report.errors ?? []).map(spell),
    warnings: (report.warnings ?? []).map(spell),
    counts: report.counts ?? {},
  });

cases.forEach((item, index) => {
  const root = roots[index] as string;
  const oracle = theirs[index] as (typeof theirs)[number];
  let ours: InstanceReport;
  try {
    ours = validateInstance(root, ROOT);
  } catch (error) {
    console.error(
      `validate-instance: ${item.name}: raised ` +
        `${(error as Error).constructor.name} — oracle ` +
        `${oracle?.raised ?? "returned"}`,
    );
    diverged += 1;
    return;
  }
  if (oracle?.raised !== undefined) {
    console.error(
      `validate-instance: ${item.name}: the oracle raised ${oracle.raised}`,
    );
    diverged += 1;
    return;
  }
  const mineText = shape({ ...ours, counts: { ...ours.counts } });
  const theirsText = shape(oracle);
  if (mineText !== theirsText) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`validate-instance: ${item.name}`);
    console.error(`  mine:   ${mineText.replaceAll(workspace, "…")}`);
    console.error(`  oracle: ${theirsText.replaceAll(workspace, "…")}`);
    return;
  }
  // Agreement about a pass neither side reached is not evidence about the
  // pass. Checked against the oracle's report, since that is the authority.
  const errors = oracle.errors ?? [];
  const warnings = oracle.warnings ?? [];
  const said = [...errors, ...warnings];
  const complaints: string[] = [];
  if (item.silent === true && said.length > 0) {
    complaints.push("said something about an instance nothing may be said of");
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
  for (const [name, wanted] of Object.entries(item.counts ?? {})) {
    const got = (oracle.counts ?? {})[name];
    if (got !== wanted) {
      complaints.push(`counted ${got} ${name}, not ${wanted}`);
    }
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(
      `validate-instance: ${item.name}: the oracle ${complaints.join("; ")}`,
    );
    for (const message of said) {
      console.error(`  ${message.replaceAll(workspace, "…")}`);
    }
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(
    `validate-instance: ${name}: recorded as a divergence and no longer one`,
  );
}

fs.rmSync(workspace, { recursive: true, force: true });

const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `validate-instance [TZ=${zone}]: ${cases.length} cases compared, ` +
    `${diverged} unexplained, ${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
