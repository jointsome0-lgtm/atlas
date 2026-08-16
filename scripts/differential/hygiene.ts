// Differential harness: the public Git-layer check against the oracle.
//
// A checker whose only input is a repository has to be asked about
// repositories, so each case builds one in a temporary directory — files,
// index, .gitignore, and where the two disagree — and both sides are run
// against the *same* tree, one after the other. Neither writes to it.
//
// Both run as processes, not in process, because part of the answer is not
// theirs: git's own `fatal:` lines go straight to stderr, and a comparison
// that captured only what the checker wrote would miss them.
//
// The tree under test holds the oracle itself, copied to `scripts/` so it can
// find its root the way it does — which is what the oracle's own test does,
// and it means both runs see the same untracked file.

import fs from "node:fs";
import os from "node:os";

const SCRIPTS = `${import.meta.dir}/..`;
const ORACLE = `${SCRIPTS}/check_public_hygiene.py`;
const PORT = `${SCRIPTS}/src/hygiene.ts`;

/** The patterns a clean .gitignore carries, as the checker requires them. */
const REQUIRED = [
  "atlas/",
  "data/",
  "state/",
  "intake/",
  "graph/",
  "plans/",
  "runs/",
  "secrets/",
  "*.sqlite*",
  "*.db*",
  "*.jsonl",
  ".env",
  ".env.*",
  "engine.pin",
  "copies-manifest",
  "delivery-registry",
  ".claude/",
  ".codex/",
  ".agents/",
];

const ignoreHolding = (patterns: readonly string[]): string =>
  `${[...patterns].sort().join("\n")}\n`;

const without = (pattern: string): string[] => REQUIRED.filter((one) => one !== pattern);

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  /** Skip `git init`, so the checker is pointed at something that is not one. */
  readonly bare?: true;
  /** `.gitignore` content; the default is every required pattern, one per line. */
  readonly ignore?: string | null;
  /** Files written before staging. */
  readonly files?: Readonly<Record<string, string>>;
  /** Files whose *names* are bytes: the key is read one byte per code unit. */
  readonly bytePaths?: Readonly<Record<string, string>>;
  /**
   * A difference that is understood, pinned by an issue.
   *
   * The two sides are then required to differ, to differ only on stderr, and
   * for this side's stderr to be the shape named here — a recorded divergence
   * that stops reproducing, or reproduces as something else, fails the run.
   */
  readonly recorded?: { readonly issue: string; readonly mine: RegExp };
  /** A phrase this side's own answer carried, where the two do not agree. */
  readonly mineSays?: readonly string[];
  /** Paths staged with `git add --force`; the default is every written file. */
  readonly add?: readonly string[];
  /** Files rewritten after staging, so the index and the tree disagree. */
  readonly edits?: Readonly<Record<string, string>>;
  /** The status the oracle left with. */
  readonly exit: number;
  /** Phrases the oracle's output carried. */
  readonly says?: readonly string[];
}

const MARKED = "# Vera Example fixture\ninvented content\n";
const UNMARKED = "# invented fixture\nno marker here\n";

const scenarios: Scenario[] = [
  {
    name: "a clean repository",
    files: { "README.md": "Clean fixture\n" },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "a tracked secret, nested where a shallow check would miss it",
    files: { "nested/secrets/key.txt": "invented test value\n" },
    exit: 1,
    says: ["denied path visible to the public Git layer: nested/secrets/key.txt"],
  },
  {
    name: "a required pattern missing from .gitignore",
    ignore: ignoreHolding(without("secrets/")),
    exit: 1,
    says: [".gitignore missing required pattern: secrets/"],
  },
  {
    name: "no .gitignore in the index at all",
    ignore: null,
    files: { "README.md": "Clean fixture\n" },
    exit: 1,
    says: [".gitignore must be tracked in the index"],
  },
  {
    name: "a .gitignore that exists but was never staged",
    ignore: ignoreHolding(REQUIRED),
    add: [],
    exit: 1,
    says: [".gitignore must be tracked in the index"],
  },
  {
    name: "a required pattern taken back by a negation",
    ignore: `${ignoreHolding(REQUIRED)}!data/\n`,
    exit: 1,
    says: [".gitignore negates required pattern: !data/"],
  },
  {
    name: "a required pattern written with a leading space",
    // git reads the space literally, so this is not the pattern it looks like.
    ignore: ignoreHolding(without("data/")).replace(/\n$/, "\n data/\n"),
    exit: 1,
    says: [".gitignore missing required pattern: data/"],
  },
  {
    name: "a required pattern written with trailing spaces",
    // The other end is trimmed, so this one counts.
    ignore: ignoreHolding(without("data/")).replace(/\n$/, "\ndata/  \t\n"),
    files: { "README.md": "Clean fixture\n" },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "a required pattern commented out",
    ignore: ignoreHolding(without("runs/")).replace(/\n$/, "\n#runs/\n"),
    exit: 1,
    says: [".gitignore missing required pattern: runs/"],
  },
  {
    name: "a .gitignore whose lines end the way Windows ends them",
    ignore: `${REQUIRED.join("\r\n")}\r\n`,
    files: { "README.md": "Clean fixture\n" },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "two patterns on one line, parted by a vertical tab",
    // git ends a line at a newline and nothing else, so it reads one pattern
    // here; the checker reads two, which is the stricter of the two readings.
    ignore: `${ignoreHolding(without("plans/").filter((one) => one !== "runs/"))}plans/\vruns/\n`,
    files: { "README.md": "Clean fixture\n" },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "a journal nobody staged, after its rule went missing",
    // The two halves of the check meeting: with the rule gone the file is no
    // longer ignored, so it reaches the check through --others rather than the
    // index, and both the absent rule and the visible file are reported. With
    // the rule in place there is nothing to see, which is the point of it.
    ignore: ignoreHolding(without("*.jsonl")),
    files: { "notes.jsonl": "{}\n" },
    add: [".gitignore"],
    exit: 1,
    says: [
      ".gitignore missing required pattern: *.jsonl",
      "denied path visible to the public Git layer: notes.jsonl",
    ],
  },
  {
    name: "a sidecar of a sidecar",
    files: { "backup/store.sqlite-wal": "invented\n" },
    exit: 1,
    says: ["denied path visible to the public Git layer: backup/store.sqlite-wal"],
  },
  {
    name: "a denied name standing in a directory position",
    files: { ".env/token": "invented-token\n" },
    exit: 1,
    says: ["denied path visible to the public Git layer: .env/token"],
  },
  {
    name: "a fixture without the marker",
    files: { "fixtures/thing.md": UNMARKED },
    exit: 1,
    says: ["fixture lacks required marker 'Vera Example': fixtures/thing.md"],
  },
  {
    name: "a fixture with the marker",
    files: { "fixtures/thing.md": MARKED },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "a fixture marked in the tree and unmarked in the index",
    // What a commit would publish is the staged blob, so the working copy
    // cannot vouch for it.
    files: { "fixtures/thing.md": UNMARKED },
    edits: { "fixtures/thing.md": MARKED },
    exit: 1,
    says: ["fixture lacks required marker 'Vera Example': fixtures/thing.md"],
  },
  {
    name: "a fixture marked in the index and unmarked in the tree",
    files: { "fixtures/thing.md": MARKED },
    edits: { "fixtures/thing.md": UNMARKED },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "an unstaged fixture, which only the tree can answer for",
    files: { "fixtures/loose.md": UNMARKED },
    add: [],
    exit: 1,
    says: ["fixture lacks required marker 'Vera Example': fixtures/loose.md"],
  },
  {
    name: "the allowlisted fixture, which is denied by name and let through",
    files: { "fixtures/intake/vera-example-batch.json": `{"note":"${"Vera Example"}"}\n` },
    exit: 0,
    says: ["OK: public Git layer"],
  },
  {
    name: "the allowlisted fixture without its marker",
    // The allowlist forgives the name, not the marker.
    files: { "fixtures/intake/vera-example-batch.json": '{"note":"invented"}\n' },
    exit: 1,
    says: [
      "fixture lacks required marker 'Vera Example': fixtures/intake/vera-example-batch.json",
    ],
  },
  {
    name: "a denied path that is not the allowlisted one, beside it",
    files: {
      "fixtures/intake/other-batch.json": `{"note":"${"Vera Example"}"}\n`,
    },
    exit: 1,
    says: ["denied path visible to the public Git layer: fixtures/intake/other-batch.json"],
  },
  {
    name: "several complaints at once",
    ignore: ignoreHolding(without("state/")),
    files: {
      "nested/secrets/key.txt": "invented test value\n",
      "fixtures/thing.md": UNMARKED,
    },
    exit: 1,
    says: [
      ".gitignore missing required pattern: state/",
      "denied path visible to the public Git layer: nested/secrets/key.txt",
      "fixture lacks required marker 'Vera Example': fixtures/thing.md",
    ],
  },
  {
    name: "somewhere that is not a repository",
    bare: true,
    ignore: ignoreHolding(REQUIRED),
    exit: 1,
    says: ["FAIL: cannot inspect the public Git layer:"],
    // git's own `fatal:` line reaches stderr from both runs and is compared as
    // it stands; only the summary after it is folded, because that half is
    // CPython's `CalledProcessError` prose. This says what stands in its place,
    // so the fold cannot cover an empty or shapeless reason.
    mineSays: ["FAIL: cannot inspect the public Git layer: git ls-files -z --cached exited 128"],
  },
  {
    name: "two fixtures whose names differ in bytes and not in characters",
    // One name holds a byte that is not UTF-8; the other holds the character
    // that a lossy decode turns the first into. The oracle keeps them apart
    // and reports the unmarked one. Reading the names as text cannot: both
    // arrive as one name, and asking git for it reads the marked file. The
    // port refuses the name instead of answering about the wrong file (#138).
    bytePaths: {
      // Latin-1 spellings: one code unit per byte. The first is the three
      // bytes UTF-8 writes U+FFFD with; the second is a lone 0xff.
      "fixtures/\u00ef\u00bf\u00bd.md": MARKED,
      "fixtures/\u00ff.md": UNMARKED,
    },
    add: ["."],
    exit: 1,
    says: ["fixture lacks required marker 'Vera Example'"],
    recorded: {
      issue: "#138",
      mine: /^FAIL: path is not UTF-8, so the file it names cannot be checked: /m,
    },
  },
];

// ---------------------------------------------------------------------------
// Building one repository, and asking both sides about it
// ---------------------------------------------------------------------------

/** git with nothing of the caller's own configuration in it. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(root: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, ...GIT_ENV },
  });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }
}

function build(scenario: Scenario): string {
  const root = fs.mkdtempSync(`${os.tmpdir()}/atlas-hygiene-`);
  fs.mkdirSync(`${root}/scripts`);
  fs.copyFileSync(ORACLE, `${root}/scripts/check_public_hygiene.py`);
  if (scenario.bare !== true) git(root, "init", "--quiet");

  const written: string[] = [];
  const ignore = scenario.ignore === undefined ? ignoreHolding(REQUIRED) : scenario.ignore;
  if (ignore !== null) {
    fs.writeFileSync(`${root}/.gitignore`, ignore);
    written.push(".gitignore");
  }
  for (const [path, content] of Object.entries(scenario.files ?? {})) {
    fs.mkdirSync(`${root}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(`${root}/${path}`, content);
    written.push(path);
  }
  for (const [path, content] of Object.entries(scenario.bytePaths ?? {})) {
    // A name that is bytes cannot be written as a string: the runtime would
    // encode it, which is the very step under test. It goes through as a
    // Buffer, one byte per code unit, and is staged with `.` rather than by
    // name for the same reason.
    fs.mkdirSync(`${root}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(Buffer.from(`${root}/${path}`, "latin1"), content);
  }

  if (scenario.bare !== true) {
    const staged = scenario.add ?? written;
    // --force so a path the .gitignore covers can still be staged: a rule
    // that is present and a file that slipped past it are different failures.
    if (staged.length > 0) git(root, "add", "--force", ...staged);
  }

  for (const [path, content] of Object.entries(scenario.edits ?? {})) {
    fs.writeFileSync(`${root}/${path}`, content);
  }
  return root;
}

interface Answer {
  readonly exit: number | null;
  readonly out: string;
  readonly err: string;
  /** Unfolded, so a claim can be made about what a fold covered. */
  readonly raw: string;
}

/** The temporary root, and the prose CPython puts after a failed subprocess. */
function fold(text: string, root: string): string {
  return text
    .replaceAll(root, "«root»")
    .replace(/^(FAIL: cannot (?:inspect the public Git layer|read \.gitignore): ).*$/gm, "$1«why»")
    .replace(/^(FAIL: cannot read fixture \S+: ).*$/gm, "$1«why»");
}

function ask(root: string, command: readonly string[]): Answer {
  const run = Bun.spawnSync([...command], {
    cwd: root,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = run.stdout.toString();
  const err = run.stderr.toString();
  return {
    exit: run.exitCode,
    out: fold(out, root),
    err: fold(err, root),
    raw: `${out}${err}`.replaceAll(root, "«root»"),
  };
}

/**
 * The port, run the way the oracle runs: its own process, its own stderr.
 *
 * The entry point takes no arguments and reads the repository above itself, so
 * the harness calls the check directly with the root it built rather than
 * copying the module tree into every temporary repository.
 */
const driver = (root: string): string =>
  `import { checkHygiene } from ${JSON.stringify(PORT)};\n` +
  `process.exitCode = checkHygiene(${JSON.stringify(root)}, ` +
  "{ out: process.stdout, err: process.stderr });\n";

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

let diverged = 0;
let recorded = 0;
let vacuous = 0;

for (const scenario of scenarios) {
  const root = build(scenario);
  try {
    const theirs = ask(root, ["python3", `${root}/scripts/check_public_hygiene.py`]);
    const mine = ask(root, ["bun", "-e", driver(root)]);

    const show = (why: string): void => {
      console.error(`hygiene: ${scenario.name}${why}`);
      if (mine.exit !== theirs.exit) {
        console.error(`  exit mine: ${mine.exit} oracle: ${theirs.exit}`);
      }
      if (mine.out !== theirs.out) {
        console.error(`  out mine:   ${JSON.stringify(mine.out)}`);
        console.error(`  out oracle: ${JSON.stringify(theirs.out)}`);
      }
      if (mine.err !== theirs.err) {
        console.error(`  err mine:   ${JSON.stringify(mine.err)}`);
        console.error(`  err oracle: ${JSON.stringify(theirs.err)}`);
      }
    };

    const comparable = (answer: Answer): string =>
      JSON.stringify({ exit: answer.exit, out: answer.out, err: answer.err });
    const same = comparable(mine) === comparable(theirs);
    if (scenario.recorded !== undefined) {
      // A recorded divergence has to still be one, and still be *that* one:
      // the same status and stdout, differing stderr, and this side saying
      // what the issue says it says.
      const asRecorded =
        !same &&
        mine.exit === theirs.exit &&
        mine.out === theirs.out &&
        scenario.recorded.mine.test(mine.err);
      if (asRecorded) recorded += 1;
      else {
        diverged += 1;
        show(same ? `: ${scenario.recorded.issue} no longer diverges` : `: not what ${scenario.recorded.issue} records`);
      }
    } else if (!same) {
      diverged += 1;
      show("");
    }

    // Every claim is read off the oracle's answer, never off the port's.
    const complaints: string[] = [];
    if (theirs.exit !== scenario.exit) {
      complaints.push(`the oracle exited ${theirs.exit}, not ${scenario.exit}`);
    }
    for (const phrase of scenario.says ?? []) {
      if (!theirs.out.includes(phrase) && !theirs.err.includes(phrase)) {
        complaints.push(`the oracle never said ${JSON.stringify(phrase)}`);
      }
    }
    // Where a fold covers prose, this side is asked what stands in its place,
    // so the fold cannot be covering an empty or shapeless reason.
    for (const phrase of scenario.mineSays ?? []) {
      if (!mine.raw.includes(phrase)) {
        complaints.push(`this side never said ${JSON.stringify(phrase)}`);
      }
    }
    if (complaints.length > 0) {
      vacuous += 1;
      console.error(`hygiene: ${scenario.name}: ${complaints.join("; ")}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  `hygiene: ${scenarios.length} repositories compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 ? 0 : 1);
