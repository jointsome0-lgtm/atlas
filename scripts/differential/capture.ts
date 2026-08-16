import { oracleAnswer } from "./oracle.ts";
// Differential harness: the manual capture command line against the oracle.
//
// Same shape as the intake harness and for the same reason — a case is a
// sequence of runs over one tree, because replay, interruption and the ids an
// interrupted run withholds are properties of what a run leaves behind, not of
// what it returns.
//
// What differs is what the two lanes are for. Intake translates a delivery
// somebody else wrote; this lane appends a row the user wrote by hand, and so
// it owes them a dry run that costs nothing, ids that are theirs rather than
// minted, and a header naming the instance before anything is written to it.
// The cases below are mostly about those three.

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

/** A concept whose new name is much longer than the one it answers to. */
const RELABELLED = `---
id: concept:renamed-to-something-much-longer
title: Long
kind: concept
field: study
formerly:
  - concept:s
---

Long.
`;

/** Alpha after a §34.4 rename, for a retirement that lands between two runs. */
const ALPHA_RETIRED = `---
id: concept:gamma
title: Gamma
kind: concept
field: study
formerly:
  - concept:alpha
---

Gamma.
`;

const BASE: Readonly<Record<string, string>> = {
  "atlas/concepts/alpha.md": CONCEPT,
  "atlas/concepts/beta.md": RENAMED,
  "atlas/concepts/long.md": RELABELLED,
  "atlas/materials/book.md": MATERIAL,
};

// ---------------------------------------------------------------------------
// Records, as a person would write them
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const record = (value: Json): string => `${JSON.stringify(value)}\n`;

const ENCOUNTER: Json = {
  id: "encounter:first",
  date: "2026-01-02",
  target: "part:book/one",
  depth: "read",
  mode: "background",
};

const ARTIFACT: Json = {
  id: "artifact:first",
  type: "note",
  path: "notes/first.md",
  observed_at: "2026-01-01",
  summary: "wrote a thing",
  touches: ["concept:alpha"],
  supports_state_updates: [],
  evidence_strength: "read",
};

const QUESTION: Json = {
  id: "question:first",
  type: "question",
  text: "why?",
  created_at: "2026-01-03",
  pulls: ["concept:alpha"],
  source: { artifact: "artifact:first" },
};

const FILES: Readonly<Record<string, string>> = {
  ...BASE,
  "rec.json": record(ENCOUNTER),
};

/**
 * A record that fits and whose derived row does not.
 *
 * The record ceiling and the row ceiling are the same number, and the row is
 * the larger of the pair — it carries the receipt key the record did not. So
 * the gap this record has to land in is about forty bytes wide, and both of its
 * strings stay under the §25.8 string ceiling.
 */
const HUGE: Json = {
  ...ARTIFACT,
  type: "y".repeat(8_000),
  summary: "x".repeat(8_190),
};

/**
 * A row measured twice, because resolution changes its size in both directions.
 *
 * A retired id and the id it resolves to are different lengths, so a row can
 * cross the journal ceiling on the way through resolution — either way. The
 * authored row is what the ceiling refuses first; the resolved row is what
 * would actually be written, so it is measured again.
 */
const SHRINKS: Json = {
  ...ARTIFACT,
  touches: ["concept:old-beta"],
  type: "y".repeat(8_000),
  summary: "x".repeat(8_180),
};

const GROWS: Json = {
  ...ARTIFACT,
  touches: ["concept:s"],
  type: "y".repeat(8_000),
  summary: "x".repeat(8_181),
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
  /** Phrases the oracle must say on stdout — the headers, mostly. */
  readonly prints?: readonly string[];
  /** That the oracle said nothing at all on stderr. */
  readonly silent?: boolean;
  /** The `class` of each report record; `[]` means no report was printed. */
  readonly classes?: readonly string[];
  /** The `reason` of each report record. */
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

const cases: Case[] = [
  // --- the argument grammar ------------------------------------------------
  {
    name: "no arguments at all",
    runs: [{ args: [], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an instance and nothing to append to it",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["{root}"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "the help text",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["--help"], exit: 0, silent: true, prints: ["usage:", "Dry-run"] }],
  },
  {
    name: "the help text by its short name",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["-h"], exit: 0, silent: true, prints: ["usage:"] }],
  },
  {
    name: "help asked for alongside a real instance",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--help"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an option that is not one",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--record", "{root}/rec.json"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an option given no value",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--record-file"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "an option whose value is another option",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["{root}", "--record-file", "--commit"], exit: 2, says: ["usage:"] }],
  },
  {
    name: "the record file named twice",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--record-file", "{root}/rec.json"],
        exit: 2,
        says: ["usage:"],
      },
    ],
  },
  {
    name: "the commit flag given twice",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit", "--commit"],
        exit: 2,
        says: ["usage:"],
      },
    ],
  },
  {
    // §34.6: the key is what makes a commit repeatable, so it is a slug and
    // the refusal names the shape rather than accepting a near miss.
    name: "a key that is not a slug",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "Key_1"],
        exit: 2,
        says: ["date-serial"],
      },
    ],
  },
  {
    name: "a commit with no key to make it repeatable",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--commit"],
        exit: 2,
        says: ["usage:"],
      },
    ],
    rows: 0,
  },
  {
    name: "an empty instance argument",
    files: FILES,
    dirs: ["state"],
    runs: [{ args: ["", "--record-file", "{root}/rec.json"], exit: 2, says: ["usage:"] }],
  },

  // --- the instance --------------------------------------------------------
  {
    name: "a root that is not an instance",
    files: { "notes.md": "not an instance\n", "rec.json": record(ENCOUNTER) },
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["invalid-root"],
      },
    ],
  },
  {
    // Caught before the path is resolved at all: a `..` in an argument is a
    // mistake worth naming, not a path worth following to see where it lands.
    name: "a root spelled with a traversal",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}/atlas/..", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["invalid-root"],
      },
    ],
  },
  {
    name: "a record file spelled with a traversal",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/atlas/../rec.json"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
  },
  {
    name: "a record file that is not there",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/absent.json"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
  },
  {
    name: "a record file reached through a symlink",
    files: FILES,
    dirs: ["state"],
    links: { "link.json": "rec.json" },
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/link.json"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
  },
  {
    // POSIX leaves a path with exactly two leading slashes implementation
    // defined, and CPython keeps the `//` anchor while walking it and then
    // resolves it away. The header names the resolved root, so both spellings
    // of one instance print as one instance.
    name: "a root spelled with two leading slashes",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["/{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["instance: «root»", "result: valid"],
      },
    ],
    rows: 0,
  },
  {
    // The header is printed before the lock and before anything is written,
    // because the one thing a person committing by hand needs to see is which
    // instance they are about to write to — and they need it either way.
    name: "an instance that is its own backup",
    files: FILES,
    dirs: ["state", ".git"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["backup: git"],
      },
    ],
  },
  {
    name: "an instance with no backup behind it",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["backup: none"],
      },
    ],
  },

  // --- what the record is ---------------------------------------------------
  {
    name: "a record file holding an array",
    files: { ...BASE, "rec.json": "[]\n" },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid"],
      },
    ],
  },
  {
    name: "a record with no id at all",
    files: { ...BASE, "rec.json": record({ date: "2026-01-02" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid", "/records/0/id"],
      },
    ],
  },
  {
    name: "a record whose id names no journal",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, id: "concept:alpha" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid", "/records/0/id"],
      },
    ],
  },
  {
    name: "a record whose id has no kind before it",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, id: "first" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid", "/records/0/id"],
      },
    ],
  },
  {
    name: "a record carrying a field its journal does not have",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, note: "extra" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid"],
      },
    ],
  },
  {
    // A float is read, not refused at the parse boundary: the schema is what
    // says a non-integer field is inadmissible, and it says so as a structured
    // rejection with the headers and the report around it. Refusing the whole
    // document as invalid JSON instead would turn a record the owner can see
    // the verdict on into a bare parse error (#119).
    name: "a record carrying a fractional number",
    files: {
      ...BASE,
      "rec.json":
        '{"id":"encounter:first","date":"2026-01-02","target":"part:book/one",' +
        '"depth":"read","mode":"background","x":1.5}\n',
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "b1"],
        exit: 1,
        says: ["schema-invalid"],
      },
    ],
  },
  {
    name: "a record missing a field its journal requires",
    files: { ...BASE, "rec.json": record({ id: "encounter:first", date: "2026-01-02" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid"],
      },
    ],
  },
  {
    // §33.2 provenance belongs to the lane that appended the row. A hand
    // written record claiming its own receipt key would be claiming to have
    // been applied by a run that never happened.
    name: "a record claiming its own provenance",
    files: {
      ...BASE,
      "rec.json": record({ ...ENCOUNTER, intake: "manual/k1#0" }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid", "/records/0/intake"],
      },
    ],
  },
  {
    name: "an encounter pointing at something that is not a material",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, target: "concept:alpha" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid", "/records/0/target"],
      },
    ],
  },

  // --- the ceilings --------------------------------------------------------
  {
    name: "a record file past the file ceiling",
    files: {
      ...BASE,
      "rec.json": record({ ...ARTIFACT, summary: "x".repeat(20_000) }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["byte-ceiling-exceeded"],
      },
    ],
  },
  {
    name: "a string past the string ceiling but inside the file ceiling",
    files: {
      ...BASE,
      "rec.json": record({ ...ARTIFACT, summary: "x".repeat(9_000) }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["byte-ceiling-exceeded", "record-file"],
      },
    ],
  },
  {
    name: "a record nested past the depth ceiling",
    files: {
      ...BASE,
      "rec.json": record({
        id: "artifact:first",
        a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } },
      }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["count-ceiling-exceeded", "record-file"],
      },
    ],
  },
  {
    // The record fits and the row it becomes does not, because the row carries
    // the receipt key the record did not. Only a keyed run can hit this: the
    // key is what pushes it over.
    name: "a record whose row outgrows the journal ceiling once keyed",
    files: { ...BASE, "rec.json": record(HUGE) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 1,
        says: ["derived-row-too-large"],
        classes: ["rejected"],
        reasons: ["derived-row-too-large"],
      },
    ],
    rows: 0,
  },
  {
    // The authored row is over and the resolved one would be under, because
    // the retired id it names is longer than the id it resolves to. The
    // refusal is the first measurement's: what the user wrote is what the
    // ceiling is about, not what resolution would have made of it.
    name: "a row over the ceiling as authored and under it once resolved",
    files: { ...BASE, "rec.json": record(SHRINKS) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 1,
        says: ["derived-row-too-large"],
        classes: ["rejected"],
        reasons: ["derived-row-too-large"],
      },
    ],
    rows: 0,
  },
  {
    // And the other way: what the user wrote fits, and what resolution makes
    // of it does not. Only the second measurement can refuse this one, and it
    // has to, because the resolved row is the row that would be written.
    name: "a row under the ceiling as authored and over it once resolved",
    files: { ...BASE, "rec.json": record(GROWS) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 1,
        says: ["derived-row-too-large"],
        classes: ["rejected"],
        reasons: ["derived-row-too-large"],
      },
    ],
    rows: 0,
  },

  // --- the ids a record refers to ------------------------------------------
  {
    name: "a target the instance has",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["result: valid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a target the instance does not have",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, target: "part:book/two" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["unresolved-reference", "/records/0/target"],
      },
    ],
  },
  {
    // §34.4: a renamed concept keeps answering to what it was called, and the
    // row that lands names the id it resolved to rather than the one written.
    name: "a reference to a name the instance has retired",
    files: {
      ...BASE,
      "rec.json": record({ ...QUESTION, pulls: ["concept:old-beta"], source: {} }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["schema-invalid"],
      },
    ],
  },
  {
    name: "a question pulling on a retired name, with a source it can cite",
    files: {
      ...BASE,
      "art.json": record(ARTIFACT),
      "rec.json": record({ ...QUESTION, pulls: ["concept:old-beta"] }),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/art.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k2", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 6,
  },
  {
    name: "a question citing a source the instance does not have",
    files: { ...BASE, "rec.json": record(QUESTION) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["unresolved-reference", "/records/0/source/artifact"],
      },
    ],
  },
  {
    name: "an id the instance already has",
    files: { ...BASE, "rec.json": record(ARTIFACT) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k2", "--commit"],
        exit: 1,
        says: ["id-conflict"],
        classes: ["conflict"],
        reasons: ["id-conflict"],
      },
    ],
    rows: 3,
  },

  // --- the dry run and the commit ------------------------------------------
  {
    name: "a dry run writes nothing and says so",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["result: valid"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 0,
        silent: true,
        prints: ["result: valid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a dry run with a key still prints no report when it is clean",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 0,
        silent: true,
        prints: ["key: manual/k1#0", "result: valid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a commit, and the row and its two receipts",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
        reasons: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    // The same key twice is the same append, not two of them.
    name: "the same record committed twice under one key",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["replayed"],
        reasons: ["processed-receipt"],
      },
    ],
    rows: 3,
  },
  {
    name: "a replay seen from a dry run",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 0,
        silent: true,
        classes: ["replayed"],
      },
    ],
    rows: 3,
  },
  {
    // A receipt says a key was applied; it does not say the file still holds
    // what it held. An edited record under a used key is a conflict, not a
    // second append and not a clean replay.
    name: "an edited record committed again under the same key",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      { args: ["--rewrite", "rec.json"], exit: 0 },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 1,
        says: ["batch-content-conflict"],
        classes: ["conflict"],
        reasons: ["batch-content-conflict"],
      },
    ],
    rows: 3,
  },
  {
    // §34.4: the durable row names what the id was called when it was
    // written, and the record still names it that too. Between the two runs
    // the instance renames it, so the two sides now resolve to a third name —
    // and a replay that compared them unresolved would call a rename a
    // conflict.
    name: "a replay across a rename that happened in between",
    files: { ...BASE, "rec.json": record(ARTIFACT) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      { args: ["--write", "atlas/concepts/alpha.md", "retired"], exit: 0 },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["replayed"],
        reasons: ["processed-receipt"],
      },
    ],
    rows: 3,
  },
  {
    // §24.4: a report echoes the id it is about only when that id is one of
    // the three a journal can hold. A record routed nowhere has an id the
    // report has no place for, so the report carries none.
    name: "a refusal whose id belongs to no journal",
    files: { ...BASE, "rec.json": record({ ...ENCOUNTER, id: "concept:alpha" }) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1"],
        exit: 1,
        says: ["schema-invalid", "/records/0/id"],
        classes: ["rejected"],
        reasons: ["schema-invalid"],
      },
    ],
    rows: 0,
  },
  {
    name: "two records under two keys",
    files: { ...BASE, "rec.json": record(ENCOUNTER), "art.json": record(ARTIFACT) },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
      {
        args: ["{root}", "--record-file", "{root}/art.json", "--key", "k2", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 6,
  },

  // --- a run that stops in the middle --------------------------------------
  {
    name: "a run interrupted before it opened anything",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        env: { ATLAS_MANUAL_CRASH: "before-opened:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 0,
        silent: true,
        classes: ["applied"],
      },
    ],
    rows: 3,
  },
  {
    // Opened and nothing after it: the next run says so rather than guessing,
    // and refuses to write the row a second time.
    name: "a run interrupted between its receipt and its row",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        env: { ATLAS_MANUAL_CRASH: "after-opened:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 1,
        says: ["interrupted-receipt"],
        classes: ["interrupted"],
        reasons: ["interrupted-receipt"],
      },
    ],
    rows: 1,
  },
  {
    name: "a run interrupted after the row and before the receipt closing it",
    files: FILES,
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        env: { ATLAS_MANUAL_CRASH: "before-processed:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 1,
        says: ["interrupted-receipt"],
        classes: ["interrupted"],
      },
    ],
    rows: 2,
  },
  {
    // §33.2: an interrupted row's id awaits the user's reconciliation, so a
    // later record must not quietly build on it.
    name: "a later record referring to an interrupted row's id",
    files: {
      ...BASE,
      "art.json": record(ARTIFACT),
      "rec.json": record(QUESTION),
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/art.json", "--key", "k1", "--commit"],
        env: { ATLAS_MANUAL_CRASH: "after-output:0" },
        exit: 1,
        says: ["injected-crash"],
      },
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k2", "--commit"],
        exit: 1,
        says: ["unresolved-reference"],
        classes: ["unresolved"],
        reasons: ["unresolved-reference"],
      },
    ],
    rows: 2,
  },

  // --- the tree the ids come from ------------------------------------------
  {
    name: "a curated tree the builder cannot parse",
    files: {
      ...FILES,
      "atlas/concepts/broken.md": "---\nid: concept:broken\ntitle: [unclosed\n---\n",
    },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["instance-state-invalid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a curated tree that parses and still does not build",
    files: { ...FILES, "atlas/concepts/alpha-again.md": CONCEPT },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["instance-state-invalid"],
      },
    ],
    rows: 0,
  },
  {
    name: "a symlink under the curated tree",
    files: FILES,
    dirs: ["state", "elsewhere"],
    links: { "atlas/link": "../elsewhere" },
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["unsafe-path"],
      },
    ],
    rows: 0,
  },
  {
    name: "a journal row that is not JSON",
    files: { ...FILES, "state/encounters.jsonl": "not json\n" },
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json"],
        exit: 1,
        says: ["invalid-jsonl"],
      },
    ],
    rows: 1,
  },
  {
    name: "an instance somebody else is already writing to",
    files: { ...FILES, ".atlas-lock": '{"pid":1,"started_at":"2026-01-01T00:00:00Z"}\n' },
    dirs: ["state"],
    runs: [
      {
        args: ["{root}", "--record-file", "{root}/rec.json", "--key", "k1", "--commit"],
        exit: 1,
        says: ["lock-held"],
      },
    ],
    rows: 0,
  },
];

// ---------------------------------------------------------------------------
// Running one case on one side
// ---------------------------------------------------------------------------

// A workspace with its own links resolved: the instance root is resolved
// strictly, so a /tmp that is a symlink would make every path disagree with the
// tree this harness thinks it built.
const workspace = fs.realpathSync(fs.mkdtempSync("/tmp/atlas-capture-"));

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

// The program names itself in its usage line, and the two programs are two
// files; nothing else is folded.
function fold(text: string, root: string): string {
  return text
    .replaceAll(root, "«root»")
    .replaceAll(workspace, "«workspace»")
    .replaceAll(/append_record\.(py|ts)/g, "«program»");
}

/** What a pseudo-run may put in the tree, named so a case reads as prose. */
const CONTENTS: Readonly<Record<string, string>> = {
  edited: record({ ...ENCOUNTER, depth: "skim" }),
  retired: ALPHA_RETIRED,
};

/** Pseudo-runs that edit the tree between two real ones. */
function fixture(root: string, args: readonly string[]): RunOutcome | null {
  if (args[0] === "--rewrite") {
    fs.writeFileSync(`${root}/${args[1] as string}`, CONTENTS["edited"] as string);
    return { exit: 0, out: "", err: "" };
  }
  if (args[0] === "--write") {
    fs.writeFileSync(
      `${root}/${args[1] as string}`,
      CONTENTS[args[2] as string] as string,
    );
    return { exit: 0, out: "", err: "" };
  }
  return null;
}

function once(side: string, index: number, item: Case, argv: string[]): Outcome {
  const root = `${workspace}/${side}-${index}`;
  materialize(root, item);
  const runs: RunOutcome[] = [];
  for (const step of item.runs) {
    const edited = fixture(root, step.args);
    if (edited !== null) {
      runs.push(edited);
      continue;
    }
    const args = step.args.map((argument) => argument.replaceAll("{root}", root));
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
  return { runs, tree: survey(root).map(([path, content]) => [path, fold(content, root)]) };
}

// ---------------------------------------------------------------------------
// The comparison
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
  // `once` has already folded this run's root out of everything it
  // returns, so the answer is recorded as it stands; the question is the
  // case itself, which is what a corpus change has to invalidate.
  const theirs = oracleAnswer("capture", JSON.stringify([index, item]), () =>
    once("oracle", index, item, ["python3", `${ROOT}/append_record.py`]),
  ) as Outcome;
  const mine = once("mine", index, item, ["bun", `${ROOT}/append_record.ts`]);

  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`capture: ${item.name}`);
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
    for (const phrase of step.prints ?? []) {
      if (!actual.out.includes(phrase)) complaints.push(`run ${at} never printed ${phrase}`);
    }
    if (step.silent === true && actual.err !== "") {
      complaints.push(`run ${at} said something about a run claimed silent`);
    }
    if (step.classes !== undefined || step.reasons !== undefined) {
      let records: Array<Record<string, unknown>> = [];
      // The report is the last line of stdout; the headers precede it.
      const line = actual.out.trimEnd().split("\n").at(-1) ?? "";
      if (line.startsWith("{")) {
        try {
          records = (JSON.parse(line) as { records: Array<Record<string, unknown>> })
            .records;
        } catch {
          complaints.push(`run ${at} printed something that is not a report`);
        }
      }
      const classes = records.map((entry) => entry["class"]);
      if (
        step.classes !== undefined &&
        JSON.stringify(classes) !== JSON.stringify(step.classes)
      ) {
        complaints.push(`run ${at} classified ${JSON.stringify(classes)}`);
      }
      const reasons = records.map((entry) => entry["reason"]);
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
    console.error(`capture: ${item.name}: the oracle ${complaints.join("; ")}`);
    for (const step of theirs.runs) {
      if (step.err !== "") console.error(`  ${step.err.trimEnd()}`);
    }
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`capture: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `capture: ${cases.length} cases compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
