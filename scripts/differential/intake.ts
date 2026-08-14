// Differential harness: the intake command line against the oracle.
//
// Like the builder's, this one runs the two programs rather than calling a
// function, because a delivery's answer is not a return value: it is an exit
// code, a report on stdout, diagnostics on stderr, and — the part no unit test
// reaches — the journals, receipts and preserved original left behind.
//
// Unlike the builder's, a case here is a *sequence* of runs over one tree. The
// properties §33.2 is actually about only exist across runs: a batch delivered
// twice must replay rather than duplicate, a run interrupted between its two
// receipts must leave the next run able to say so, and an edited redelivery
// must conflict instead of quietly applying. A single-run harness would agree
// with the oracle about everything except what the module is for.
//
// One spelling is folded before comparison and nothing else is: the program
// names itself in its usage line, and the two programs are two files.

import fs from "node:fs";

const ROOT = `${import.meta.dir}/..`;

// ---------------------------------------------------------------------------
// The curated tree every case starts from
// ---------------------------------------------------------------------------

const CONCEPT = `---
id: concept:alpha
title: Alpha
kind: concept
field: study
---

Alpha.
`;

const MATERIAL = `---
id: material:book
type: material
title: A Book
kind: docs
url: ""
status: active
overall_concepts:
  - concept:alpha
parts:
  - id: part:book/one
    title: Chapter One
    concept_edges:
      - to: concept:alpha
        role: explains
        weight: high
---

A book.
`;

/** A concept that used to be called something else (§34.4). */
const RENAMED = `---
id: concept:beta
title: Beta
kind: concept
field: study
formerly:
  - concept:old-beta
---

Beta.
`;

const BASE: Readonly<Record<string, string>> = {
  "atlas/concepts/alpha.md": CONCEPT,
  "atlas/concepts/beta.md": RENAMED,
  "atlas/materials/book.md": MATERIAL,
};

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const batch = (records: unknown[], extra: Json = {}): string =>
  `${JSON.stringify({
    format: "atlas-intake",
    version: 1,
    source: "vera",
    batch: "b1",
    records,
    ...extra,
  })}\n`;

const ARTIFACT: Json = {
  kind: "artifact",
  date: "2026-01-01",
  type: "note",
  text: "wrote a thing",
  refs: [{ id: "concept:alpha" }],
  evidence_strength: "read",
};

const ENCOUNTER: Json = {
  kind: "encounter",
  date: "2026-01-02",
  target: { id: "part:book/one" },
  depth: "read",
};

const QUESTION: Json = {
  kind: "question",
  date: "2026-01-03",
  text: "why?",
  refs: [{ id: "concept:alpha" }, { id: "artifact:vera-b1-0-1" }],
};

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface Run {
  /** Arguments, with `{root}` standing for this case's own tree. */
  readonly args: readonly string[];
  /** Extra environment for this run, for the §33.2 crash injections. */
  readonly env?: Readonly<Record<string, string>>;
  /** The exit code this run is about, checked against the oracle's. */
  readonly exit: number;
  /** Phrases the oracle must say on stderr, so agreement is never empty. */
  readonly says?: readonly string[];
  /** That the oracle said nothing at all on stderr. */
  readonly silent?: boolean;
  /** The `class` of each report record, in order; `[]` means no report. */
  readonly classes?: readonly string[];
  /** The `reason` of each report record, in order. */
  readonly reasons?: readonly string[];
}

interface Case {
  readonly name: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly links?: Readonly<Record<string, string>>;
  readonly modes?: Readonly<Record<string, number>>;
  readonly runs: readonly Run[];
  /** Journal rows in the tree afterwards, counted across every state file. */
  readonly rows?: number;
}

const INSTANCE: Readonly<Record<string, string>> = {
  ...BASE,
  "intake/vera/b1.json": batch([ARTIFACT]),
};

/**
 * A record that fits and whose derived row does not.
 *
 * The two ceilings are the same number, and the row is the larger of the pair —
 * it carries the minted id, the canonical path and the receipt key the record
 * did not. So the gap this record has to land in is about ninety bytes wide,
 * and both of its strings still sit under the §25.8 string ceiling.
 */
const HUGE: Json = {
  ...ARTIFACT,
  type: "y".repeat(8_100),
  text: "x".repeat(8_100),
};

const cases: Case[] = [
  // --- the argument grammar ------------------------------------------------
  {
    name: "no arguments at all",
    runs: [{ args: [], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an instance and nothing to do with it",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["{root}"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an option that is neither",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--batch-id", "vera/b1"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "a batch named without its source",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--batch", "b1"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "a batch named with a segment that is not a slug",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--batch", "Vera/b1"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "a batch named with three segments",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--batch", "vera/b1/x"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an empty instance argument",
    files: INSTANCE,
    dirs: ["state"],
    runs: [{ args: ["", "--batch", "vera/b1"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "a fourth argument",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/b1", "--commit"], exit: 2, says: ["usage:"] },
    ],
  },

  // --- the instance --------------------------------------------------------
  {
    name: "a root that is not an instance",
    files: { "notes.md": "not an instance\n" },
    runs: [{ args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["invalid-root"] }],
  },
  {
    name: "a root missing its state directory",
    files: INSTANCE,
    runs: [{ args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["invalid-root"] }],
  },
  {
    name: "a root reached through a symlink",
    files: INSTANCE,
    dirs: ["state"],
    links: { link: "." },
    runs: [
      { args: ["{root}/link", "--batch", "vera/b1"], exit: 1, says: ["invalid-root"] },
    ],
  },
  {
    name: "an instance whose lock is already held",
    files: { ...INSTANCE, ".atlas-lock": '{"pid": 1, "started_at": "x"}\n' },
    dirs: ["state"],
    runs: [{ args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["lock-held"] }],
  },

  // --- finding the delivery ------------------------------------------------
  {
    name: "a batch that is not in the instance",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/nope"], exit: 1, says: ["unsafe-path"] },
    ],
  },
  {
    name: "a batch file that is not there",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/intake/vera/nope.json"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
  },
  {
    name: "a batch file that is a directory",
    files: INSTANCE,
    dirs: ["state", "delivery"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/delivery"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
  },
  {
    name: "a batch file under an ignore root",
    files: { ...INSTANCE, "secrets/b1.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/secrets/b1.json"],
        exit: 1,
        says: ["ignored-path"],
      },
    ],
  },
  {
    name: "a batch file delivered from outside the instance",
    files: { ...BASE, "outside/b1.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/outside/b1.json"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    name: "a delivery that is not JSON at all",
    files: { ...BASE, "intake/vera/b1.json": "not json\n" },
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["invalid-json"] },
    ],
  },
  {
    name: "a delivery with a byte order mark, which a delivery may carry",
    files: { ...BASE, "intake/vera/b1.json": `﻿${batch([ARTIFACT])}` },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },

  // --- the envelope --------------------------------------------------------
  {
    name: "an envelope that is not one",
    files: { ...BASE, "intake/vera/b1.json": '{"records": []}\n' },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["missing-format-version"],
      },
    ],
  },
  {
    name: "an envelope of a version this build does not know",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([], { version: 2 }).replace('"version":1,', ""),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unsupported-version"],
      },
    ],
  },
  {
    name: "an envelope carrying a field the schema does not admit",
    files: { ...BASE, "intake/vera/b1.json": batch([ARTIFACT], { note: "hi" }) },
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["schema-invalid"] },
    ],
  },
  {
    name: "a delivery claiming a reserved direct-lane source",
    files: {
      ...BASE,
      "intake/manual/b1.json": batch([ARTIFACT], { source: "manual" }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "manual/b1"],
        exit: 1,
        says: ["reserved-source"],
        classes: ["rejected"],
        reasons: ["reserved-source"],
      },
    ],
    rows: 0,
  },
  {
    name: "a batch that calls itself something other than what was asked for",
    files: { ...BASE, "intake/vera/b2.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b2"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 0,
  },

  // --- the ceilings --------------------------------------------------------
  {
    name: "a record whose own bytes pass the ceiling",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, text: "x".repeat(20_000) },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["byte-ceiling-exceeded", "#0"],
      },
    ],
  },
  {
    name: "a string past the string ceiling but inside the record ceiling",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, text: "x".repeat(9_000) },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["byte-ceiling-exceeded"],
      },
    ],
  },
  {
    // The envelope is validated before the ceilings, and it says only that
    // `records` is an array — so a record can be nested arbitrarily deep and
    // still be a well-formed delivery. The depth ceiling is what stops it,
    // before any record is walked (§25.8).
    name: "a record nested past the depth ceiling",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { kind: "artifact", a: { b: { c: { d: { e: { f: {} } } } } } },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["count-ceiling-exceeded"],
        classes: [],
      },
    ],
    rows: 0,
  },
  {
    name: "a derived row that outgrows the journal ceiling",
    files: { ...BASE, "intake/vera/b1.json": batch([HUGE]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["derived-row-too-large"],
        classes: ["rejected"],
        reasons: ["derived-row-too-large"],
      },
    ],
    rows: 0,
  },

  // --- one record at a time ------------------------------------------------
  {
    name: "an encounter against a part of a material",
    files: { ...BASE, "intake/vera/b1.json": batch([ENCOUNTER]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    name: "an encounter against a concept, which is not a material",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ENCOUNTER, target: { id: "concept:alpha" } },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unsupported-target-kind"],
        classes: ["unsupported"],
      },
    ],
    rows: 0,
  },
  {
    name: "a reference to an id nothing answers",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ id: "concept:nowhere" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unresolved-reference", "/refs/0"],
        classes: ["unresolved"],
      },
    ],
    rows: 0,
  },
  {
    name: "a reference by url rather than id, which names no node",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ url: "https://example.test/x" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved"],
      },
    ],
    rows: 0,
  },
  {
    name: "a reference to a retired id, which resolves to its successor",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ id: "concept:old-beta" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    name: "an artifact touching a material, which is not a region",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ id: "material:book" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unsupported-reference-kind"],
        classes: ["unsupported"],
      },
    ],
    rows: 0,
  },
  {
    name: "an artifact with no evidence strength",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        Object.fromEntries(
          Object.entries(ARTIFACT).filter(([key]) => key !== "evidence_strength"),
        ),
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["missing-evidence-strength"],
        classes: ["unsupported"],
      },
    ],
    rows: 0,
  },
  {
    name: "a question citing only regions, with nothing that asked it",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...QUESTION, refs: [{ id: "concept:alpha" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["missing-question-source"],
        classes: ["unsupported"],
      },
    ],
    rows: 0,
  },
  {
    name: "a record of a kind the intake schema has no definition for",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([{ kind: "trail", date: "2026-01-01" }]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["schema-invalid", "/kind"],
        classes: ["rejected"],
      },
    ],
    rows: 0,
  },
  {
    name: "a record whose date is not one",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([{ ...ARTIFACT, date: "01/01/2026" }]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["schema-invalid", "/records/0/date"],
        classes: ["rejected"],
      },
    ],
    rows: 0,
  },
  {
    name: "a plan, which this lane does not import",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([{ kind: "plan", date: "2026-01-01" }]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["schema-invalid"],
        classes: ["rejected"],
      },
    ],
    rows: 0,
  },
  {
    name: "a record carrying a sensitivity class",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([{ ...ARTIFACT, sensitivity: "medical" }]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    name: "a delivery whose sensitivity every record inherits",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([ARTIFACT], { sensitivity: "medical" }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },

  // --- records that refer to one another -----------------------------------
  {
    name: "a question citing an artifact minted by the same delivery",
    files: { ...BASE, "intake/vera/b1.json": batch([ARTIFACT, QUESTION]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied", "applied"],
      },
    ],
    rows: 6,
  },
  {
    name: "the same two records delivered dependent-first",
    files: { ...BASE, "intake/vera/b1.json": batch([QUESTION, ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved", "applied"],
      },
    ],
    rows: 3,
  },
  {
    // The candidate set is every *other* pending record's minted id. A record
    // that cites the id it is about to be given is citing nothing that exists
    // yet, and resolving it would let one record vouch for itself.
    name: "a record citing the id it is itself about to be minted",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ id: "artifact:vera-b1-0-1" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved"],
        reasons: ["unresolved-reference"],
      },
    ],
    rows: 0,
  },
  {
    name: "a question whose in-batch dependency fails, taking the question with it",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        { ...ARTIFACT, refs: [{ id: "concept:nowhere" }] },
        { ...QUESTION, refs: [{ id: "artifact:vera-b1-0-1" }] },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved", "unresolved"],
      },
    ],
    rows: 0,
  },
  {
    name: "a question citing two sources of one kind",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([
        ARTIFACT,
        { ...ARTIFACT, text: "another" },
        {
          ...QUESTION,
          refs: [{ id: "artifact:vera-b1-0-1" }, { id: "artifact:vera-b1-1-1" }],
        },
      ]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["duplicate-question-source-kind"],
        classes: ["applied", "applied", "unsupported"],
      },
    ],
    rows: 6,
  },
  {
    name: "a record whose minted id an earlier delivery already took",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([ARTIFACT]),
      "state/artifacts.jsonl":
        `${JSON.stringify({
          id: "artifact:vera-b1-0-1",
          type: "note",
          path: "intake/vera/b1.json",
          observed_at: "2026-01-01",
          summary: "already here",
          touches: [],
          supports_state_updates: [],
          evidence_strength: "read",
        })}\n`,
    },
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["id-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 1,
  },

  // --- delivering the same batch twice -------------------------------------
  {
    name: "the same delivery, twice",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["replayed"],
        reasons: ["processed-receipt"],
      },
    ],
    rows: 3,
  },
  {
    name: "a delivery edited in place after it was applied",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 0, classes: ["applied"] },
      {
        args: ["{root}", "--rewrite", "intake/vera/b1.json"],
        exit: 0,
        silent: true,
        classes: [],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 3,
  },
  {
    name: "a delivery whose canonical original was removed after it applied",
    files: { ...INSTANCE, "outside/b1.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 0, classes: ["applied"] },
      { args: ["{root}", "--remove", "intake/vera/b1.json"], exit: 0, classes: [] },
      {
        args: ["{root}", "--batch-file", "{root}/outside/b1.json"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 3,
  },
  {
    name: "a file delivery preserved as the canonical original",
    files: { ...BASE, "outside/b1.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/outside/b1.json"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["replayed"],
      },
    ],
    rows: 3,
  },
  {
    name: "a second delivery of one batch id with different bytes",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([ARTIFACT]),
      "outside/b1.json": batch([{ ...ARTIFACT, text: "different" }]),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/outside/b1.json"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 0,
  },
  {
    name: "a delivery from inside intake under a name that is not its own",
    files: { ...BASE, "intake/vera/other.json": batch([ARTIFACT]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch-file", "{root}/intake/vera/other.json"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
      },
    ],
    rows: 0,
  },

  {
    // A batch id names one delivery, and receipts are the record of what that
    // delivery covered. A receipt past the current last record means the two
    // no longer describe the same thing — most plainly, the original was
    // truncated — so the whole batch fails closed rather than reporting a
    // clean partial replay over records that are simply gone.
    name: "a receipt recorded past the end of the delivery",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([ARTIFACT, ENCOUNTER]),
      "state/receipts.jsonl":
        '{"date":"2026-01-01","intake":"vera/b1#5","marker":"opened"}\n' +
        '{"date":"2026-01-01","intake":"vera/b1#5","marker":"processed"}\n',
    },
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict", "conflict"],
        reasons: ["batch-content-conflict", "batch-content-conflict"],
      },
    ],
    rows: 2,
  },

  // --- a run that stops in the middle --------------------------------------
  {
    name: "a crash between the opened receipt and the row",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        env: { ATLAS_INTAKE_CRASH: "after-opened:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["interrupted-receipt"],
        classes: ["interrupted"],
      },
    ],
    rows: 1,
  },
  {
    name: "a crash between the row and the processed receipt",
    files: INSTANCE,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        env: { ATLAS_INTAKE_CRASH: "before-processed:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["interrupted-receipt"],
        classes: ["interrupted"],
      },
    ],
    rows: 2,
  },
  {
    name: "a crash before the first receipt of the second record",
    files: { ...BASE, "intake/vera/b1.json": batch([ARTIFACT, QUESTION]) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        env: { ATLAS_INTAKE_CRASH: "before-opened:1" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 0,
        silent: true,
        classes: ["replayed", "applied"],
      },
    ],
    rows: 6,
  },
  {
    name: "a later delivery citing an id an interrupted record wrote",
    files: {
      ...BASE,
      "intake/vera/b1.json": batch([ARTIFACT]),
      "intake/vera/b2.json": batch(
        [{ ...QUESTION, refs: [{ id: "artifact:vera-b1-0-1" }] }],
        { batch: "b2" },
      ),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        env: { ATLAS_INTAKE_CRASH: "before-processed:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--batch", "vera/b2"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved"],
      },
    ],
    rows: 2,
  },

  // --- the tree the ids come from ------------------------------------------
  {
    name: "a curated tree the builder refuses",
    files: {
      ...INSTANCE,
      "atlas/concepts/broken.md": "---\nid: concept:broken\ntitle: [unclosed\n---\n",
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["instance-state-invalid"],
      },
    ],
    rows: 0,
  },
  {
    // Distinct from the case above: this tree parses. The builder reads every
    // file, finishes, and reports what is wrong with the result — so the
    // refusal has to come from the returned errors, not from an exception.
    name: "a curated tree that parses and still does not build",
    files: {
      ...INSTANCE,
      "atlas/concepts/alpha-again.md": CONCEPT,
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--batch", "vera/b1"],
        exit: 1,
        says: ["instance-state-invalid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a symlink under the curated tree",
    files: INSTANCE,
    dirs: ["state", "elsewhere"],
    links: { "atlas/link": "../elsewhere" },
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["unsafe-path"] },
    ],
    rows: 0,
  },
  {
    name: "a journal row that is not JSON",
    files: { ...INSTANCE, "state/artifacts.jsonl": "not json\n" },
    runs: [
      { args: ["{root}", "--batch", "vera/b1"], exit: 1, says: ["invalid-jsonl"] },
    ],
    rows: 1,
  },
];

// ---------------------------------------------------------------------------
// Running one case on one side
// ---------------------------------------------------------------------------

// A workspace with its own links resolved: the instance root is resolved
// strictly, so a /tmp that is a symlink would make every path disagree with the
// tree this harness thinks it built.
const workspace = fs.realpathSync(fs.mkdtempSync("/tmp/atlas-intake-"));

function materialize(root: string, item: Case): void {
  fs.mkdirSync(root, { recursive: true });
  for (const directory of item.dirs ?? []) {
    fs.mkdirSync(`${root}/${directory}`, { recursive: true });
  }
  for (const [relative, content] of Object.entries(item.files ?? {})) {
    const cut = relative.lastIndexOf("/");
    if (cut > 0) fs.mkdirSync(`${root}/${relative.slice(0, cut)}`, { recursive: true });
    fs.writeFileSync(`${root}/${relative}`, content);
  }
  for (const [link, target] of Object.entries(item.links ?? {})) {
    fs.symlinkSync(target, `${root}/${link}`);
  }
  for (const [relative, mode] of Object.entries(item.modes ?? {})) {
    fs.chmodSync(relative === "." ? root : `${root}/${relative}`, mode);
  }
}

function unlock(root: string, item: Case): void {
  for (const relative of Object.keys(item.modes ?? {})) {
    try {
      fs.chmodSync(relative === "." ? root : `${root}/${relative}`, 0o755);
    } catch {
      /* the case may have failed before the path existed */
    }
  }
}

/** The tree afterwards: every path, and the bytes of everything readable. */
function survey(root: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        found.push([relative, `-> ${fs.readlinkSync(`${directory}/${entry.name}`)}`]);
      } else if (entry.isDirectory()) {
        found.push([relative, "/"]);
        walk(`${directory}/${entry.name}`, relative);
      } else {
        let content: string;
        try {
          content = fs.readFileSync(`${directory}/${entry.name}`, "utf8");
        } catch {
          content = "<unreadable>";
        }
        found.push([relative, content]);
      }
    }
  };
  walk(root, "");
  return found;
}

interface RunOutcome {
  readonly exit: number;
  readonly out: string;
  readonly err: string;
}

interface Outcome {
  readonly runs: RunOutcome[];
  readonly tree: Array<[string, string]>;
}

/**
 * The one spelling allowed to differ: the program names itself in its usage
 * line, and the two programs are two files.
 */
function fold(text: string, root: string): string {
  return text
    .replaceAll(root, "«root»")
    .replaceAll(workspace, "«workspace»")
    .replaceAll(/process_intake\.(py|ts)/g, "«program»");
}

/**
 * Two runs that are not the program: editing and removing a file mid-sequence.
 *
 * A replay conflict is only interesting if the delivery changed between the two
 * runs, and that change has to happen inside the sequence rather than before
 * it. Doing it here rather than as a third field on a case keeps a case one
 * list of runs read top to bottom.
 */
function fixture(root: string, args: readonly string[]): RunOutcome | null {
  if (args[1] === "--rewrite") {
    fs.writeFileSync(
      `${root}/${args[2] as string}`,
      batch([{ ...ARTIFACT, text: "edited" }]),
    );
    return { exit: 0, out: "", err: "" };
  }
  if (args[1] === "--remove") {
    fs.rmSync(`${root}/${args[2] as string}`);
    return { exit: 0, out: "", err: "" };
  }
  return null;
}

function once(side: string, index: number, item: Case, argv: string[]): Outcome {
  const root = `${workspace}/${side}-${index}`;
  materialize(root, item);
  const runs: RunOutcome[] = [];
  for (const step of item.runs) {
    const args = step.args.map((argument) => argument.replaceAll("{root}", root));
    const edited = fixture(root, args);
    if (edited !== null) {
      runs.push(edited);
      continue;
    }
    const run = Bun.spawnSync([...argv, ...args], {
      cwd: root,
      env: { ...process.env, ...(step.env ?? {}) },
    });
    runs.push({
      exit: run.exitCode,
      out: fold(run.stdout.toString(), root),
      err: fold(run.stderr.toString(), root),
    });
  }
  unlock(root, item);
  return { runs, tree: survey(root).map(([path, content]) => [path, fold(content, root)]) };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Divergences with an issue behind them, counted apart rather than hidden. */
const KNOWN: ReadonlyMap<string, string> = new Map([]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const stillDiverging = new Set<string>();

/** Every journal row the tree holds afterwards, across every state file. */
function journalRows(tree: Array<[string, string]>): number {
  let rows = 0;
  for (const [path, content] of tree) {
    if (path.startsWith("state/") && path.endsWith(".jsonl")) {
      rows += content.split("\n").filter((line) => line !== "").length;
    }
  }
  return rows;
}

cases.forEach((item, index) => {
  const theirs = once("oracle", index, item, ["python3", `${ROOT}/process_intake.py`]);
  const mine = once("mine", index, item, ["bun", `${ROOT}/process_intake.ts`]);

  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`intake: ${item.name}`);
    for (const [at, step] of theirs.runs.entries()) {
      const other = mine.runs[at];
      if (JSON.stringify(step) !== JSON.stringify(other)) {
        console.error(`  run ${at} mine:   ${JSON.stringify(other)}`);
        console.error(`  run ${at} oracle: ${JSON.stringify(step)}`);
      }
    }
    if (JSON.stringify(mine.tree) !== JSON.stringify(theirs.tree)) {
      console.error(`  tree mine:   ${JSON.stringify(mine.tree)}`);
      console.error(`  tree oracle: ${JSON.stringify(theirs.tree)}`);
    }
    return;
  }

  // And what the case claims, read off the oracle's own answer.
  const complaints: string[] = [];
  item.runs.forEach((step, at) => {
    const actual = theirs.runs[at] as RunOutcome;
    if (actual.exit !== step.exit) {
      complaints.push(`run ${at} exited ${actual.exit} against the claimed ${step.exit}`);
    }
    for (const phrase of step.says ?? []) {
      if (!actual.err.includes(phrase)) complaints.push(`run ${at} never said ${phrase}`);
    }
    if (step.silent === true && actual.err !== "") {
      complaints.push(`run ${at} said something about a run claimed silent`);
    }
    if (step.classes !== undefined || step.reasons !== undefined) {
      let records: Array<Record<string, unknown>> = [];
      if (actual.out !== "") {
        try {
          records = (JSON.parse(actual.out) as { records: Array<Record<string, unknown>> })
            .records;
        } catch {
          complaints.push(`run ${at} printed something that is not a report`);
        }
      }
      const classes = records.map((record) => record["class"]);
      if (
        step.classes !== undefined &&
        JSON.stringify(classes) !== JSON.stringify(step.classes)
      ) {
        complaints.push(`run ${at} classified ${JSON.stringify(classes)}`);
      }
      const reasons = records.map((record) => record["reason"]);
      if (
        step.reasons !== undefined &&
        JSON.stringify(reasons) !== JSON.stringify(step.reasons)
      ) {
        complaints.push(`run ${at} reasoned ${JSON.stringify(reasons)}`);
      }
    }
  });
  if (item.rows !== undefined && journalRows(theirs.tree) !== item.rows) {
    complaints.push(`left ${journalRows(theirs.tree)} journal rows, not ${item.rows}`);
  }
  // §25.6: whatever the outcome, no run may leave the instance locked.
  if (theirs.tree.some(([path]) => path === ".atlas-lock")) {
    const held = (item.files ?? {})[".atlas-lock"] !== undefined;
    if (!held) complaints.push("left the instance locked");
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`intake: ${item.name}: the oracle ${complaints.join("; ")}`);
    for (const step of theirs.runs) {
      if (step.err !== "") console.error(`  ${step.err.trimEnd()}`);
    }
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`intake: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `intake: ${cases.length} cases compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
