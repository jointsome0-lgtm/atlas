// Differential harness: the demo viewer's command line against the oracle.
//
// Only the command line. What the demo serves once it has a port is the
// instance server's route table, compared over a socket in serve.ts, and the
// graph it builds is the builder's, compared in build.ts — mounting a second
// server here would compare neither of them twice.
//
// Both sides are asked the same question — parse this line, then say what a
// caller would see — and the answer is the exit status, stdout and stderr.
// The corpus is curated shapes with claims, then a generated sweep over an
// alphabet of tokens, because argparse's answer to a *combination* is where a
// hand-written parser goes wrong.
//
// Two recorded divergences: argparse names the arguments it could not place,
// which §24.4 forbids (#136) — the port answers with a count instead — and the
// two runtimes carry different editions of the Unicode table that decides
// which scripts write digits (#139).

import { oracleAnswer } from "./oracle.ts";

import { DEFAULT_PORT, parseArgs, report } from "../src/demo-cli.ts";

const PROGRAM = "view_demo.py";

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * What a curated case claims, so that agreement is never agreement about
 * nothing. `port` names the number the oracle parsed, `exit` the status it
 * left with, and `says` a phrase its diagnostics carried.
 */
interface Case {
  readonly name: string;
  readonly argv: readonly string[];
  readonly port?: number;
  readonly exit?: number;
  readonly says?: string;
}

const cases: Case[] = [];

function add(item: Case): void {
  if (item.port === undefined && item.exit === undefined) {
    throw new Error(`${item.name}: a case must claim an outcome`);
  }
  cases.push(item);
}

add({ name: "no arguments at all", argv: [], port: DEFAULT_PORT });
add({ name: "a port of its own", argv: ["--port", "9000"], port: 9000 });
add({ name: "a port attached with an equals", argv: ["--port=9000"], port: 9000 });
add({ name: "a port by unambiguous prefix", argv: ["--po", "9000"], port: 9000 });
// Port 0 asks the kernel for a free one, which the demo allows and the
// instance server does not — the demo pins no origin.
add({ name: "the port the kernel picks", argv: ["--port", "0"], port: 0 });
add({ name: "the top of the range", argv: ["--port", "65535"], port: 65535 });
add({ name: "a port written with a sign", argv: ["--port", "+8137"], port: 8137 });
add({
  name: "a port written with an underscore between digits",
  argv: ["--port", "8_137"],
  port: 8137,
});
add({
  name: "a port with the whitespace int() skips around it",
  argv: ["--port", " \t8137\n"],
  port: 8137,
});
add({
  name: "a port in digits from another script",
  argv: ["--port", "٨١٣٧"],
  port: 8137,
});
add({
  // Recorded as #139: digits this runtime's Unicode table has and the
  // oracle's does not. The claim is the oracle's refusal, which is what makes
  // the recording a recording rather than a name.
  name: "a port in digits the oracle's Unicode table has never heard of",
  argv: ["--port", "\u{10D49}\u{10D40}\u{10D40}\u{10D40}"],
  exit: 2,
  says: "port must be an integer",
});

add({ name: "help asked for the long way", argv: ["--help"], exit: 0, says: "" });
add({ name: "help asked for the short way", argv: ["-h"], exit: 0, says: "" });
add({ name: "help by prefix", argv: ["--he"], exit: 0, says: "" });
add({
  name: "help with more short options behind it",
  argv: ["-hx"],
  exit: 0,
  says: "",
});
add({
  name: "help handed a value it has no use for",
  argv: ["-h=x"],
  exit: 2,
  says: "ignored explicit argument",
});
add({
  // The refused value is quoted back by `repr`, which is a whole grammar of
  // its own: a line separator, a bell and the last code point there is each
  // come back as a different kind of escape.
  name: "help handed a value that repr has to spell out",
  argv: ["-h=\u2028\u0007\u{10ffff}"],
  exit: 2,
  says: "ignored explicit argument '\\u2028\\x07\\U0010ffff'",
});
add({
  name: "help asked for after a port",
  argv: ["--port", "9000", "--help"],
  exit: 0,
  says: "",
});

add({
  name: "a port that is not a number",
  argv: ["--port", "nope"],
  exit: 2,
  says: "port must be an integer",
});
add({
  name: "a port above the range",
  argv: ["--port", "70000"],
  exit: 2,
  says: "port must be between 0 and 65535",
});
add({
  name: "a negative port",
  argv: ["--port", "-1"],
  exit: 2,
  says: "port must be between 0 and 65535",
});
add({
  name: "a port with nothing after it",
  argv: ["--port"],
  exit: 2,
  says: "expected one argument",
});
add({
  name: "a port whose value is another option",
  argv: ["--port", "--help"],
  exit: 2,
  says: "expected one argument",
});
add({
  name: "an empty port",
  argv: ["--port", ""],
  exit: 2,
  says: "port must be an integer",
});
add({
  name: "a float where a port belongs",
  argv: ["--port", "8137.0"],
  exit: 2,
  says: "port must be an integer",
});
add({
  name: "an ambiguous prefix",
  argv: ["--=1"],
  exit: 2,
  says: "ambiguous option",
});
add({
  name: "a word this parser has no place for",
  argv: ["extra"],
  exit: 2,
  says: "unrecognized",
});
add({
  name: "everything past the terminator is a word it has no place for",
  argv: ["--", "--port", "9000"],
  exit: 2,
  says: "unrecognized",
});
add({
  name: "the last port named wins",
  argv: ["--port", "9000", "--port", "9001"],
  port: 9001,
});
add({
  name: "a bad port refuses even behind a good one",
  argv: ["--port", "9000", "--port", "nope"],
  exit: 2,
  says: "port must be an integer",
});
add({
  name: "a lone dash is a word, not an option",
  argv: ["-"],
  exit: 2,
  says: "unrecognized",
});

// The sweep. argparse's answer to one token is easy to reproduce; its answer
// to a combination is where a hand-written parser goes wrong, so every
// arrangement of these up to three long is compared as well.
const ALPHABET = ["--port", "-h", "--", "9000", "-1", "--po", "-hx", "=", ""];
const swept: string[][] = [];
for (const first of ALPHABET) {
  swept.push([first]);
  for (const second of ALPHABET) {
    swept.push([first, second]);
    for (const third of ALPHABET) swept.push([first, second, third]);
  }
}

const shapes = [...cases.map((item) => item.argv), ...swept];

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const payload = JSON.stringify({ shapes });
interface Oracle {
  readonly code: number | null;
  readonly port: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** How many arguments the oracle could not place. */
  readonly extras: number;
}

const theirs = (
  oracleAnswer("demo-cli", payload) as { cases: Oracle[] }
).cases;

interface Ours {
  readonly code: number | null;
  readonly port: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Garay digits (U+10D40–U+10D49), decimal in Unicode 16.0 and not in 15.0. */
const UNICODE_16_DIGITS = /[\u{10D40}-\u{10D49}]/u;

/**
 * Divergences that are understood, each pinned by the issue that holds it.
 *
 * A recorded entry names the exact difference in both directions: when it
 * applies, and what this side must then say. `agrees` is the whole test — it
 * is asked to be as specific as the issue is, so that a regression cannot
 * shelter under a recording. Anything past that is a new divergence wearing
 * an old name.
 */
const RECORDED: ReadonlyArray<{
  readonly issue: string;
  readonly when: (oracle: Oracle, argv: readonly string[]) => boolean;
  readonly agrees: (ours: Ours, oracle: Oracle) => boolean;
}> = [
  {
    // §24.4: the values are withheld and only their number is given — so the
    // number is checked against the oracle's own count, and everything else
    // about the answer still has to agree as it stands.
    issue: "#136",
    when: (oracle) => oracle.stderr.includes("unrecognized arguments: "),
    agrees: (ours, oracle) => {
      const counted = /^ERROR: (\d+) unrecognized argument\(s\); values withheld\n/.exec(
        ours.stderr,
      );
      const rest = (text: string): string => text.split("\n").slice(1).join("\n");
      return (
        counted !== null &&
        Number(counted[1]) === oracle.extras &&
        ours.code === oracle.code &&
        ours.stdout === oracle.stdout &&
        rest(ours.stderr) === rest(oracle.stderr)
      );
    },
  },
  {
    // Which scripts have digits at all is a Unicode table, and the two
    // runtimes carry different editions of it: the oracle is CPython 3.12 and
    // knows Unicode 15.0, this runtime knows 16.0, where Garay gained digits.
    // So a port written in them is a number here and a refusal there. Named
    // by the block rather than by "any disagreement", so a *new* disagreement
    // is a divergence and not a second tenant of this record (#139).
    issue: "#139",
    when: (_oracle, argv) => argv.some((word) => UNICODE_16_DIGITS.test(word)),
    agrees: (ours, oracle) =>
      // The oracle refuses the value; this side reads it, and reads it right.
      oracle.code === 2 &&
      oracle.port === null &&
      oracle.stderr.includes("ERROR: argument --port: port must be an integer\n") &&
      ours.code === null &&
      ours.port === 9000 &&
      ours.stdout === "" &&
      ours.stderr === "",
  },
];

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const reproduced = new Set<string>();

/** What a caller sees of the oracle's answer, in the order `Ours` writes it. */
const seen = (oracle: Oracle): Ours => ({
  code: oracle.code,
  port: oracle.port,
  stdout: oracle.stdout,
  stderr: oracle.stderr,
});

const answer = (argv: readonly string[]): Ours => {
  let stdout = "";
  let stderr = "";
  const parsed = parseArgs(argv);
  const code = report(parsed, PROGRAM, {
    out: { write: (text) => void (stdout += text) },
    err: { write: (text) => void (stderr += text) },
  });
  return {
    code,
    port: code === null ? (parsed as { readonly port: number }).port : null,
    stdout,
    stderr,
  };
};

shapes.forEach((argv, index) => {
  const oracle = theirs[index] as (typeof theirs)[number];
  const ours = answer(argv);
  const shown = JSON.stringify(argv);

  const known = RECORDED.find((entry) => entry.when(oracle, argv));
  if (known !== undefined) {
    // The recording decides the whole comparison: what it does not pin down
    // it has to require to be equal, and that is its own business.
    if (known.agrees(ours, oracle)) {
      recorded += 1;
      reproduced.add(known.issue);
      return;
    }
    diverged += 1;
    console.error(`demo-cli: ${shown}: not what ${known.issue} records`);
    console.error(`  mine:   ${JSON.stringify(ours)}`);
    console.error(`  oracle: ${JSON.stringify(oracle)}`);
    return;
  }

  // `extras` is how the oracle was asked to count for the recordings above,
  // not something a caller sees, so it is not part of the answer compared.
  const mine = JSON.stringify(ours);
  const theirText = JSON.stringify(seen(oracle));
  if (mine !== theirText) {
    diverged += 1;
    console.error(`demo-cli: ${shown}`);
    console.error(`  mine:   ${mine}`);
    console.error(`  oracle: ${theirText}`);
  }
});

// Every claim is read off the oracle's answer, never off ours.
cases.forEach((item, index) => {
  const oracle = theirs[index] as (typeof theirs)[number];
  const complaints: string[] = [];
  if (item.port !== undefined && oracle.port !== item.port) {
    complaints.push(`parsed port ${oracle.port}, not ${item.port}`);
  }
  if (item.exit !== undefined && oracle.code !== item.exit) {
    complaints.push(`exited ${oracle.code}, not ${item.exit}`);
  }
  if (item.says !== undefined && item.says !== "" && !oracle.stderr.includes(item.says)) {
    complaints.push(`never said ${JSON.stringify(item.says)}`);
  }
  if (item.says === "" && oracle.stdout === "") {
    complaints.push("printed no help at all");
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`demo-cli: ${item.name}: the oracle ${complaints.join("; ")}`);
  }
});

// A sweep that never reaches an outcome class proves nothing about it.
const classes = new Set(
  theirs.map((entry) => (entry.code === null ? "args" : `exit ${entry.code}`)),
);
for (const wanted of ["args", "exit 0", "exit 2"]) {
  if (!classes.has(wanted)) {
    vacuous += 1;
    console.error(`demo-cli: no shape in the corpus reaches ${wanted}`);
  }
}

const stale = RECORDED.filter((entry) => !reproduced.has(entry.issue));
for (const entry of stale) {
  console.error(`demo-cli: ${entry.issue}: recorded as a divergence and no longer one`);
}

console.log(
  `demo-cli: ${shapes.length} lines compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
