import { oracleAnswer } from "./oracle.ts";
// Differential harness: the builder's command line against the oracle.
//
// Every other harness in this directory calls a function. This one runs the
// two programs, because the command line is not a function: its answer is an
// exit code, two streams, a lock that has to be gone afterwards, and whatever
// is or is not left in the instance. A port that returned the right graph and
// left a lock behind would pass any of the others.
//
// Each case is built twice, once per side, in its own tree — the two must not
// write over each other, and the tree afterwards is half of what is compared.
//
// Two spellings are folded before comparison and nothing else is. The program
// names itself in its usage line, and the two programs are two files; and an
// I/O refusal carries the platform's own words after the place it happened,
// which §24.4 makes the contract while the sentence after it is not one.

import fs from "node:fs";

const ROOT = `${import.meta.dir}/..`;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** A minimal curated tree that builds cleanly, as the base of most cases. */
const CONCEPT = `---
id: concept:alpha
title: Alpha
kind: concept
field: study
---

Alpha.
`;

const RELATED = `---
id: concept:beta
title: Beta
kind: concept
field: study
related_concepts:
  - concept:alpha
---

Beta.
`;

/** A frontmatter refusal: the grammar stops the build before it starts. */
const MALFORMED = `---
id: concept:gamma
title: [unclosed
---

Gamma.
`;

/** A curated document whose reference no living record answers. */
const DANGLING = `---
id: concept:delta
title: Delta
kind: concept
field: study
related_concepts:
  - concept:nowhere
---

Delta.
`;

interface Case {
  readonly name: string;
  /** Arguments, with `{root}` standing for this case's own tree. */
  readonly args: readonly string[];
  /** Where the run starts, relative to the tree; its own root by default. */
  readonly cwd?: string;
  /** Files to write under the tree, by path relative to it. */
  readonly files?: Readonly<Record<string, string>>;
  /** Directories to create empty, which `files` alone cannot say. */
  readonly dirs?: readonly string[];
  /** Symlinks to create, as link path → target. */
  readonly links?: Readonly<Record<string, string>>;
  /** Modes to apply after everything else is in place, last write wins. */
  readonly modes?: Readonly<Record<string, number>>;
  /** The exit code this case is about, checked against the oracle's. */
  readonly exit: number;
  /** Phrases the oracle must say on stderr, so agreement is never empty. */
  readonly says?: readonly string[];
  /** That the oracle said nothing at all on stderr. */
  readonly silent?: boolean;
  /** Whether a graph is at the canonical path afterwards. */
  readonly emits?: boolean;
}

const BASE: Readonly<Record<string, string>> = {
  "atlas/concepts/alpha.md": CONCEPT,
  "atlas/concepts/beta.md": RELATED,
};

const cases: Case[] = [
  // --- the argument grammar ------------------------------------------------
  { name: "no arguments at all", args: [], exit: 2, says: ["usage:"] },
  {
    name: "one positional and no output",
    args: ["{root}/atlas"],
    files: BASE,
    exit: 2,
    says: ["usage:"],
  },
  {
    name: "three positionals",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json", "extra"],
    files: BASE,
    exit: 2,
    says: ["usage:"],
  },
  {
    name: "--check twice",
    args: ["--check", "--check", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 2,
    says: ["--check may be specified only once", "usage:"],
  },
  {
    name: "--redact twice",
    args: ["--redact", "--redact", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 2,
    says: ["--redact may be specified only once", "usage:"],
  },
  {
    name: "--as-of twice",
    args: [
      "--as-of", "2026-01-01", "--as-of", "2026-01-02",
      "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of may be specified only once", "usage:"],
  },
  {
    name: "--check and --redact together",
    args: ["--check", "--redact", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 2,
    says: ["--check and --redact cannot be combined", "usage:"],
  },
  {
    name: "--as-of with nothing after it",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json", "--as-of"],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "--as-of with a day that is not one",
    args: [
      "--as-of", "2026-02-30", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "--as-of with a month that is not one",
    args: [
      "--as-of", "2026-13-01", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "--as-of at year zero",
    args: [
      "--as-of", "0000-01-01", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "--as-of on a leap day that exists",
    args: [
      "--as-of", "2024-02-29", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "--as-of on a leap day that does not",
    args: [
      "--as-of", "2023-02-29", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "--as-of at the last day the calendar has",
    args: [
      "--as-of", "9999-12-31", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "--as-of with a year in Arabic-Indic digits",
    args: [
      "--as-of", "٢٠٢٦-01-01",
      "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "--as-of with one digit too few",
    args: [
      "--as-of", "2026-1-01", "{root}/atlas", "{root}/graph/atlas-graph.json",
    ],
    files: BASE,
    exit: 2,
    says: ["--as-of requires YYYY-MM-DD"],
  },
  {
    name: "a flag after the positionals",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json", "--check"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: false,
  },

  // --- the input shape -----------------------------------------------------
  {
    name: "a curated tree that is not there",
    args: ["{root}/nowhere", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 1,
    says: ["invalid-root"],
  },
  {
    name: "a curated tree that is a file",
    args: ["{root}/atlas/concepts/alpha.md", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 1,
    says: ["invalid-root"],
  },
  {
    name: "an instance whose atlas/ is missing",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { "notes.md": "not an instance\n" },
    exit: 1,
    says: ["invalid-root"],
  },
  {
    name: "a directory with content and no §8 subdirectory",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { "atlas/notes.md": "not curated\n" },
    exit: 1,
    says: ["not shaped like a curated tree"],
  },
  {
    name: "an empty curated tree, which is a fresh instance",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    dirs: ["atlas"],
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "a curated tree reached by a symlink",
    args: ["{root}/link", "{root}/graph/atlas-graph.json"],
    files: BASE,
    links: { link: "atlas" },
    exit: 1,
    says: ["invalid-root"],
  },
  {
    name: "a curated directory not named atlas",
    args: ["{root}/curated", "{root}/graph/atlas-graph.json"],
    files: { "curated/concepts/alpha.md": CONCEPT },
    exit: 0,
    silent: true,
    emits: true,
  },

  // --- the output shape ----------------------------------------------------
  {
    name: "an output that is not named atlas-graph.json",
    args: ["{root}/atlas", "{root}/graph/graph.json"],
    files: BASE,
    exit: 2,
    says: ["must end in graph/atlas-graph.json", "usage:"],
  },
  {
    name: "an output not under graph/",
    args: ["{root}/atlas", "{root}/out/atlas-graph.json"],
    files: BASE,
    exit: 2,
    says: ["must end in graph/atlas-graph.json", "usage:"],
  },
  {
    name: "an output spelled through a dot-dot segment",
    args: ["{root}/atlas", "{root}/atlas/../graph/atlas-graph.json"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "an output whose graph/ is a symlink elsewhere in the instance",
    args: ["{root}/atlas", "{root}/link/atlas-graph.json"],
    files: BASE,
    dirs: ["graph"],
    links: { link: "graph" },
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "an output deriving another instance than the input",
    args: ["{root}/atlas", "{root}/elsewhere/graph/atlas-graph.json"],
    files: BASE,
    dirs: ["elsewhere"],
    exit: 1,
    says: ["one instance, one lock"],
  },
  {
    // The case runs with the tree as its working directory, so this names the
    // same instance the input does — by a spelling only resolution can join.
    name: "a relative output, resolved against the working directory",
    args: ["{root}/atlas", "graph/atlas-graph.json"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    // The §25.6 check reads the curated tree the reader settled on, not the
    // argument that named it. Spelled as a bare dot from inside the curated
    // directory the two disagree: the argument's last component is nothing at
    // all, and the tree it means is an `atlas` belonging to another instance
    // than the output derives. Reading the argument here would wave it past.
    name: "a curated tree named by a dot, deriving another instance",
    args: [".", "{root}/elsewhere/graph/atlas-graph.json"],
    cwd: "atlas",
    files: BASE,
    dirs: ["elsewhere"],
    exit: 1,
    says: ["one instance, one lock"],
  },
  {
    // The one case that tells resolution from normalization: lexically this
    // output sits in a directory named `link`, which is not `graph` and would
    // be refused outright. Followed, it lands in another instance's graph/ —
    // and §25.6 is exactly the rule that a lock must guard the instance the
    // bytes reach, not the one the argument was spelled against.
    name: "an output whose graph/ is a symlink to another instance",
    args: ["{root}/atlas", "{root}/link/atlas-graph.json"],
    files: BASE,
    dirs: ["elsewhere/graph"],
    links: { link: "elsewhere/graph" },
    exit: 1,
    says: ["one instance, one lock"],
  },

  // --- the lock ------------------------------------------------------------
  {
    name: "an instance whose lock is already held",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { ...BASE, ".atlas-lock": '{"pid": 1, "started_at": "x"}\n' },
    exit: 1,
    says: ["is already held", "single-writer"],
  },
  {
    name: "an instance root that refuses a lock",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    modes: { ".": 0o555 },
    exit: 1,
    says: ["cannot acquire"],
  },
  {
    name: "--check over an instance whose lock is held, which never takes one",
    args: ["--check", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { ...BASE, ".atlas-lock": '{"pid": 1, "started_at": "x"}\n' },
    exit: 0,
    silent: true,
    emits: false,
  },

  // --- the build's own outcome ---------------------------------------------
  {
    name: "a document the frontmatter grammar refuses",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { ...BASE, "atlas/concepts/gamma.md": MALFORMED },
    exit: 1,
    says: ["ERROR:"],
    emits: false,
  },
  {
    name: "a reference no living record answers",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { ...BASE, "atlas/concepts/delta.md": DANGLING },
    exit: 1,
    says: ["concept:nowhere"],
    emits: false,
  },
  {
    name: "a refused build over a graph an earlier run emitted",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: {
      ...BASE,
      "atlas/concepts/delta.md": DANGLING,
      "graph/atlas-graph.json": '{"format": "atlas-graph", "version": 1}\n',
    },
    exit: 1,
    says: ["concept:nowhere"],
    emits: true,
  },
  {
    name: "a build whose graph directory cannot be written",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    dirs: ["graph"],
    modes: { graph: 0o555 },
    exit: 1,
    says: ["cannot emit"],
  },

  // --- what a run leaves behind --------------------------------------------
  {
    name: "a plain build",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "a build over the instance rather than its curated directory",
    args: ["{root}", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 1,
    says: ["not shaped like a curated tree"],
  },
  {
    name: "--redact, which emits the agent-facing variant too",
    args: ["--redact", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "a plain build over a redacted variant an earlier run emitted",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: {
      ...BASE,
      "graph/atlas-graph.redacted.json": '{"format": "atlas-graph"}\n',
    },
    exit: 0,
    silent: true,
    emits: true,
  },
  {
    name: "--check, which reads everything and writes nothing",
    args: ["--check", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: BASE,
    exit: 0,
    silent: true,
    emits: false,
  },
  {
    name: "--check over a curated tree it refuses",
    args: ["--check", "{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: { ...BASE, "atlas/concepts/delta.md": DANGLING },
    exit: 1,
    says: ["concept:nowhere"],
    emits: false,
  },
  {
    name: "a build that warns and still emits",
    args: ["{root}/atlas", "{root}/graph/atlas-graph.json"],
    files: {
      ...BASE,
      "atlas/concepts/alpha.md": CONCEPT.replace(
        "field: study",
        "field: study\nformerly:\n  - concept:old-alpha",
      ),
      "atlas/concepts/beta.md": RELATED.replace(
        "concept:alpha",
        "concept:old-alpha",
      ),
    },
    exit: 0,
    says: ["WARNING:", "§34.4"],
    emits: true,
  },
];

// ---------------------------------------------------------------------------
// Running one case on one side
// ---------------------------------------------------------------------------

// A workspace with its own links resolved: the oracle resolves the output path
// through symlinks, so a /tmp that is one would make every path in every
// diagnostic disagree with the tree this harness thinks it built.
const workspace = fs.realpathSync(fs.mkdtempSync("/tmp/atlas-build-cli-"));

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

/** Put every mode back, or the tree cannot be walked or removed. */
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

interface Outcome {
  readonly exit: number;
  readonly out: string;
  readonly err: string;
  readonly tree: Array<[string, string]>;
}

/**
 * The two spellings that are allowed to differ, folded away.
 *
 * The program names itself in its usage line and the two programs are two
 * files. And an I/O refusal ends in the platform's own sentence about it: the
 * place is the contract (§24.4), the words after it are the kernel's.
 */
function fold(text: string, root: string): string {
  return text
    .replaceAll(root, "«root»")
    .replaceAll(workspace, "«workspace»")
    .replaceAll(/build_atlas_graph\.(py|ts)/g, "«program»")
    .replaceAll(
      /^(ERROR: cannot (?:acquire|write|emit|remove stale) \S+):.*$/gm,
      "$1: «platform»",
    );
}

function once(side: string, index: number, item: Case, argv: string[]): Outcome {
  const root = `${workspace}/${side}-${index}`;
  materialize(root, item);
  const args = item.args.map((argument) => argument.replaceAll("{root}", root));
  const run = Bun.spawnSync([...argv, ...args], {
    cwd: item.cwd === undefined ? root : `${root}/${item.cwd}`,
  });
  unlock(root, item);
  return {
    exit: run.exitCode,
    out: fold(run.stdout.toString(), root),
    err: fold(run.stderr.toString(), root),
    tree: survey(root).map(([path, content]) => [path, fold(content, root)]),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Divergences with an issue behind them, counted apart rather than hidden. */
const KNOWN: ReadonlyMap<string, string> = new Map([
  // CPython's `\d` is Unicode-wide and its `%Y` field is spelled with it, so
  // the oracle accepts a year in Arabic-Indic digits and builds against an
  // as-of no date in the instance can be compared with. §20.1 says
  // YYYY-MM-DD. Recorded as #134.
  ["--as-of with a year in Arabic-Indic digits", "#134"],
]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const stillDiverging = new Set<string>();

cases.forEach((item, index) => {
  // `once` has already folded this run's root out of everything it
  // returns, so the answer is recorded as it stands; the question is the
  // case itself, which is what a corpus change has to invalidate.
  const theirs = oracleAnswer("build-cli", JSON.stringify([index, item]), () =>
    once("oracle", index, item, ["python3", `${ROOT}/build_atlas_graph.py`]),
  ) as Outcome;
  const mine = once("mine", index, item, ["bun", `${ROOT}/build_atlas_graph.ts`]);

  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`build-cli: ${item.name}`);
    console.error(`  mine:   ${JSON.stringify(mine)}`);
    console.error(`  oracle: ${JSON.stringify(theirs)}`);
    return;
  }

  // And what the case claims, read off the oracle's own answer.
  const complaints: string[] = [];
  if (theirs.exit !== item.exit) {
    complaints.push(`exited ${theirs.exit} against the claimed ${item.exit}`);
  }
  for (const phrase of item.says ?? []) {
    if (!theirs.err.includes(phrase)) complaints.push(`never said ${phrase}`);
  }
  if (item.silent === true && theirs.err !== "") {
    complaints.push("said something about a run claimed silent");
  }
  const emitted = theirs.tree.some(([path]) => path === "graph/atlas-graph.json");
  if (item.emits !== undefined && emitted !== item.emits) {
    complaints.push(emitted ? "emitted a graph" : "emitted no graph");
  }
  // §25.6: whatever the outcome, no run may leave the instance locked.
  if (theirs.tree.some(([path]) => path === ".atlas-lock")) {
    const held = (item.files ?? {})[".atlas-lock"] !== undefined;
    if (!held) complaints.push("left the instance locked");
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`build-cli: ${item.name}: the oracle ${complaints.join("; ")}`);
    if (theirs.err !== "") console.error(`  ${theirs.err.trimEnd()}`);
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`build-cli: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `build-cli: ${cases.length} runs compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
