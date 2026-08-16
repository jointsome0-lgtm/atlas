import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the grammar conformance suite against the oracle.
//
// The first case is the repository itself. That is the only case that runs the
// committed fixtures and every generated ceiling, and it is the one that
// proves the two grammars admit the same documents — twenty ceiling pairs, a
// quarter-megabyte document among them, all built from the limits rather than
// stored.
//
// The rest are small invented repositories broken on purpose, because the
// suite's own failure paths never run in a healthy tree. Without them the
// half of this module that reports a broken fixture would be ported, shipped,
// and never once executed on either side.
//
// The oracle reads its repository root from a module global, which is the
// whole reason this harness stands apart from the others: `run_conformance`
// takes no arguments, so each case has to point that global at its own tree.

import crypto from "node:crypto";
import fs from "node:fs";

import { GENERATORS, generatedCase, runConformance } from "../src/conformance.ts";
import { foldParserProse, foldQuotes } from "./spelling.ts";

const DIFFERENTIAL = import.meta.dir;
const REPOSITORY = `${DIFFERENTIAL}/../..`;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

const VALID = "---\nx: y\n---\n";
const EXPECTED = '{"x": "y"}\n';
const UNFENCED = "no fences here\n";

const manifest = (entries: readonly Record<string, string>[]): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

/**
 * The smallest tree the suite walks without complaining.
 *
 * The three generators named here are the cheap ones. A case about a missing
 * expected JSON has no business also building sixteen documents of a quarter
 * megabyte each, and the ceilings themselves are covered where they belong —
 * by the repository's own manifest, in the first case.
 */
const BASE: Readonly<Record<string, string>> = {
  "fixtures/grammar/accept/basic.fm": VALID,
  "fixtures/grammar/accept/basic.json": EXPECTED,
  "fixtures/grammar/reject/unfenced.fm": UNFENCED,
  "fixtures/grammar/generated.json": manifest([
    { generator: "bom", mode: "reject" },
    { generator: "depth-at-limit", mode: "accept" },
    { generator: "depth-over-limit", mode: "reject" },
  ]),
};

/**
 * What a case claims, so that agreement is never agreement about nothing.
 *
 * `says` names the sentence the case exists for. `count` is how many fixtures
 * the suite is supposed to have walked, and it is the only claim a case with
 * nothing to say can make: a pass that quietly walked an empty tree agrees
 * with a pass that quietly walked an empty tree, and the number is what tells
 * the two apart. `grows` is for the repository itself, whose suite has no
 * fixed size — it only has to be non-empty.
 */
interface Case {
  readonly name: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly says: readonly string[];
  readonly count?: number;
  readonly grows?: boolean;
  readonly raises?: boolean;
  readonly symlink?: boolean;
}

const cases: Case[] = [];

function add(
  name: string,
  files: Record<string, string | null>,
  expect: {
    says?: readonly string[];
    count?: number;
    grows?: boolean;
    raises?: boolean;
    symlink?: boolean;
  },
): void {
  const claims =
    (expect.says?.length ?? 0) > 0 ||
    expect.count !== undefined ||
    expect.grows === true ||
    expect.raises === true;
  if (!claims) throw new Error(`${name}: a case must claim something`);
  cases.push({ name, files, says: expect.says ?? [], ...expect });
}

// The repository itself, and never a copy of it: the shipped fixtures are the
// thing being agreed about, and a copy of them would agree about a copy. It
// is first because its claim is the grammar's, and every case after it is
// about the suite that reports on the grammar.
add("the suite this repository actually ships", {}, { grows: true });

add("a tree with nothing wrong in it", {}, { count: 5 });

add(
  "an accept fixture with no expected JSON beside it",
  { "fixtures/grammar/accept/basic.json": null },
  { says: ["accept fixture has no expected JSON"], count: 5 },
);

add(
  "an accept fixture that parses to something else",
  { "fixtures/grammar/accept/basic.json": '{"x": "z"}\n' },
  { says: ["basic.fm: parsed "], count: 5 },
);

add(
  "an accept fixture the grammar refuses",
  { "fixtures/grammar/accept/basic.fm": UNFENCED },
  { says: ["opening fence must be the exact line"], count: 5 },
);

add(
  "an expected JSON that is not JSON at all",
  { "fixtures/grammar/accept/basic.json": "{nope\n" },
  { says: ["basic.json:1: invalid JSON"], count: 5 },
);

add(
  "a reject fixture the grammar accepts",
  { "fixtures/grammar/reject/unfenced.fm": VALID },
  { says: ["reject fixture unexpectedly parsed"], count: 5 },
);

add(
  "a fixture whose whole name is its suffix",
  {
    // `PurePosixPath(".fm").with_suffix(".json")` appends rather than
    // replaces, because a dotfile has no suffix to replace. The expected JSON
    // this looks for is `.fm.json`, and finding it is the proof.
    "fixtures/grammar/accept/.fm": VALID,
    "fixtures/grammar/accept/.fm.json": EXPECTED,
  },
  { count: 6 },
);

add(
  "a fixture named for its suffix whose expected JSON was spelled `.json`",
  { "fixtures/grammar/accept/.fm": VALID, "fixtures/grammar/accept/.json": EXPECTED },
  { says: [".fm: accept fixture has no expected JSON"], count: 6 },
);

add(
  "no accept directory to walk at all",
  { "fixtures/grammar/accept/basic.fm": null, "fixtures/grammar/accept/basic.json": null },
  // A directory that is not there is not a complaint — the reader hands back
  // an empty scan and the suite is simply one case smaller.
  { count: 4 },
);

add(
  "no reject directory to walk at all",
  { "fixtures/grammar/reject/unfenced.fm": null },
  { count: 4 },
);

add(
  "an accept directory reached through a symlink",
  {},
  { says: ["fixtures/grammar/accept: unsafe-path"], count: 0, symlink: true },
);

add(
  "a repository with no fixtures directory at all",
  {
    "fixtures/grammar/accept/basic.fm": null,
    "fixtures/grammar/accept/basic.json": null,
    "fixtures/grammar/reject/unfenced.fm": null,
    "fixtures/grammar/generated.json": null,
    // Something has to exist or the root itself is missing, which is a
    // different question and the reader's, not this suite's.
    "README.md": "not a fixture\n",
  },
  { says: ["fixtures/grammar/generated.json: missing manifest"], count: 0 },
);

add(
  "no manifest of generated cases",
  { "fixtures/grammar/generated.json": null },
  { says: ["fixtures/grammar/generated.json: missing manifest"], count: 2 },
);

add(
  "a manifest that is not JSON",
  { "fixtures/grammar/generated.json": "[\n" },
  { says: ["generated.json:2: invalid JSON"], count: 2 },
);

add(
  "two generated cases declared the wrong way round",
  {
    "fixtures/grammar/generated.json": manifest([
      { generator: "bom", mode: "accept" },
      { generator: "depth-at-limit", mode: "reject" },
    ]),
  },
  {
    says: [
      "generated:bom: accept fixture was rejected",
      "generated:depth-at-limit: reject fixture unexpectedly parsed",
    ],
    count: 4,
  },
);

// The cases below put two complaints in flight at once. Everything above
// raises one, in one place, and one complaint cannot show whose turn it was
// or that a pass carried on after the pass before it had something to say.

add(
  "an accept fixture and a reject fixture both wrong at once",
  // The order is the evidence: swap the two loops and every case above still
  // passes, because none of them makes both groups complain. Here the two
  // messages come back in one list, and the list is compared against the
  // oracle's as it stands — position included.
  {
    "fixtures/grammar/accept/basic.fm": UNFENCED,
    "fixtures/grammar/reject/unfenced.fm": VALID,
  },
  {
    says: [
      "basic.fm: frontmatter line 1: opening fence must be the exact line",
      "unfenced.fm: reject fixture unexpectedly parsed",
    ],
    count: 5,
  },
);

add(
  "a missing manifest with an accept fixture already complaining",
  // A missing manifest replaces what was found rather than adding to it. With
  // clean fixtures in front of it there is nothing to accumulate and the two
  // readings are the same answer, so the fixture has to be broken too for the
  // difference to exist at all.
  {
    "fixtures/grammar/accept/basic.json": null,
    "fixtures/grammar/generated.json": null,
  },
  { says: ["fixtures/grammar/generated.json: missing manifest"], count: 2 },
);

add(
  "a manifest that is not JSON, with an accept fixture already complaining",
  { "fixtures/grammar/accept/basic.json": null, "fixtures/grammar/generated.json": "[\n" },
  { says: ["generated.json:2: invalid JSON"], count: 2 },
);

add(
  "a manifest entry whose mode is a number",
  // Present and the wrong type is not absent. The oracle indexes the key, so
  // it finds the `0`, matches it against neither name, and the case passes —
  // a port that demanded a string here would refuse a manifest the oracle
  // reads. Whether canon should be stricter is a question for canon.
  {
    "fixtures/grammar/generated.json": `${JSON.stringify(
      [{ generator: "bom", mode: 0 }],
      null,
      2,
    )}\n`,
  },
  { count: 3 },
);

add(
  "a manifest naming a generator nobody wrote",
  { "fixtures/grammar/generated.json": manifest([{ generator: "no-such", mode: "accept" }]) },
  { raises: true },
);

add(
  "a manifest entry that names no mode",
  { "fixtures/grammar/generated.json": manifest([{ generator: "bom" }]) },
  { raises: true },
);

add(
  "a manifest entry that names no generator",
  { "fixtures/grammar/generated.json": manifest([{ mode: "reject" }]) },
  { raises: true },
);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const workspace = fs.mkdtempSync("/tmp/atlas-conformance-");

const roots = cases.map((item, index) => {
  if (index === 0) return REPOSITORY;
  const root = `${workspace}/case-${String(index).padStart(2, "0")}`;
  for (const [relative, text] of Object.entries({ ...BASE, ...item.files })) {
    if (text === null) continue;
    const target = `${root}/${relative}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, text);
  }
  if (item.symlink === true) {
    const accept = `${root}/fixtures/grammar/accept`;
    fs.rmSync(accept, { recursive: true, force: true });
    fs.symlinkSync("./reject", accept);
  }
  return root;
});

const payload = JSON.stringify({
  roots: roots.map((root) => ({ root })),
  generators: GENERATORS,
});
// The roots are this run's temporary directories, so they are folded out
// of both the question and the answer before either is written down, and
// folded back in for the comparison below.
const oracleOut = JSON.parse(
  unfoldRoots(
    oracleAnswer("conformance", foldRoots(payload, roots)) as string,
    roots,
  ),
) as {
  cases: Array<{ errors?: string[]; count?: number; raised?: boolean }>;
  fixtures: Record<
    string,
    { bytes: number; digest: string; expected: unknown }
  >;
};
const theirs = oracleOut.cases;

/** Divergences that are understood, each pinned by the issue that holds it. */
const KNOWN: ReadonlyMap<string, string> = new Map();

const spell = (text: string): string => {
  const folded = foldParserProse(foldQuotes(text));
  // `parsed X, expected Y` renders two mappings, and rendering a mapping is
  // where the two languages disagree over whitespace and nothing else:
  // CPython's `repr` puts a space after the colon, `JSON.stringify` puts
  // none. Squeezing that whitespace out of both sides leaves every character
  // of the contents in place, so a fixture that really did parse to something
  // else still diverges — only the punctuation stops counting.
  const at = folded.indexOf(": parsed ");
  return at === -1
    ? folded
    : folded.slice(0, at) + folded.slice(at).replaceAll(/([:,]) /g, "$1");
};

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const stillDiverging = new Set<string>();
const quiet = (text: string): string => text.replaceAll(workspace, "…");

cases.forEach((item, index) => {
  const oracle = theirs[index] as (typeof theirs)[number];
  let ours: { errors: readonly string[]; count: number } | null = null;
  let raised = false;
  try {
    ours = runConformance(roots[index] as string);
  } catch {
    raised = true;
  }
  // A crash is not a diagnostic. §24.4 asks a failing tool for a place and an
  // exit code, and the exception class behind it is prose in a language the
  // port does not share — so what is compared is only that both sides refused
  // to run, and that the case said they would.
  if (raised || oracle?.raised === true) {
    if (raised && oracle?.raised === true && item.raises === true) return;
    diverged += 1;
    console.error(
      `conformance: ${item.name}: mine ${raised ? "raised" : "returned"}, ` +
        `oracle ${oracle?.raised === true ? "raised" : "returned"}`,
    );
    return;
  }

  const mine = JSON.stringify({
    errors: (ours as { errors: readonly string[] }).errors.map(spell),
    count: (ours as { count: number }).count,
  });
  const theirsText = JSON.stringify({
    errors: (oracle?.errors ?? []).map(spell),
    count: oracle?.count ?? -1,
  });
  if (mine !== theirsText) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`conformance: ${item.name}`);
    console.error(`  mine:   ${quiet(mine)}`);
    console.error(`  oracle: ${quiet(theirsText)}`);
    return;
  }

  const said = oracle?.errors ?? [];
  const complaints: string[] = [];
  if (item.says.length === 0 && said.length > 0) {
    complaints.push("complained about a tree the case calls sound");
  }
  for (const phrase of item.says) {
    if (!said.some((message) => message.includes(phrase))) {
      complaints.push(`never said ${JSON.stringify(phrase)}`);
    }
  }
  const count = oracle?.count ?? -1;
  if (item.grows === true && count <= 0) {
    complaints.push("ran no fixtures at all");
  }
  if (item.count !== undefined && count !== item.count) {
    complaints.push(`walked ${count} fixtures, not ${item.count}`);
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`conformance: ${item.name}: the oracle ${complaints.join("; ")}`);
    for (const message of said) console.error(`  ${quiet(message)}`);
  }
});

// The cases above compare verdicts, and a verdict is a coarse instrument: two
// implementations that generate different documents can still agree that the
// at-limit one parses and the over-limit one does not. What the ceilings are
// actually worth is the bytes, so the bytes are compared directly — every
// generator, whether or not a manifest names it, and the mapping each one is
// supposed to parse to alongside them.
// Which ceilings exist is the manifest's to say, not this list's: a name
// quietly dropped from `GENERATORS` would shrink the comparison below and
// report a smaller number nobody reads as a failure.
const declared = new Set(
  (
    JSON.parse(
      fs.readFileSync(`${REPOSITORY}/fixtures/grammar/generated.json`, "utf8"),
    ) as Array<{ generator: string }>
  ).map((entry) => entry.generator),
);
const missing = [...declared].filter((name) => !GENERATORS.includes(name));
const invented = GENERATORS.filter((name) => !declared.has(name));
for (const name of missing) {
  diverged += 1;
  console.error(`conformance: the manifest declares ${name} and the port does not`);
}
for (const name of invented) {
  diverged += 1;
  console.error(`conformance: the port offers ${name} and the manifest does not`);
}

let fixtures = 0;
for (const name of GENERATORS) {
  const theirFixture = oracleOut.fixtures[name];
  if (theirFixture === undefined) {
    diverged += 1;
    console.error(`conformance: the oracle has no generator ${name}`);
    continue;
  }
  const [data, wanted] = generatedCase(name);
  const digest = crypto.createHash("sha256").update(data).digest("hex");
  if (data.length !== theirFixture.bytes || digest !== theirFixture.digest) {
    diverged += 1;
    console.error(
      `conformance: generated:${name}: ${data.length} bytes ${digest.slice(0, 12)}, ` +
        `oracle ${theirFixture.bytes} bytes ${theirFixture.digest.slice(0, 12)}`,
    );
    continue;
  }
  const mineExpected = JSON.stringify(wanted);
  const theirExpected = JSON.stringify(theirFixture.expected ?? null);
  if (mineExpected !== theirExpected) {
    diverged += 1;
    console.error(
      `conformance: generated:${name}: expects a different mapping than the oracle`,
    );
    continue;
  }
  fixtures += 1;
}

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`conformance: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `conformance: ${cases.length} suites and ${fixtures} generated fixtures ` +
    `compared, ${diverged} unexplained, ${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
