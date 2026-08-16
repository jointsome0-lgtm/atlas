import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the `validate_atlas` command line against the oracle.
//
// Three commands and no argument parser, which makes the dispatch itself worth
// comparing: the shapes that are refused are as much of the contract as the
// shapes that run. Each case is one invocation — the argument vector, the exit
// status, everything printed to either stream.
//
// Two things are folded before comparison and nothing else. The program names
// itself in its usage line and the two programs are two files. And a Python
// `set` has no order — CPython derives it from the hash of the members, and it
// varies between interpreter runs — so the members of every set literal in a
// drift diagnostic are sorted on both sides. That fold moves nothing but the
// order: a name in one set and not the other still diverges.
//
// Like the conformance harness, this one calls both sides in process rather
// than spawning them, because the oracle reads its repository root from a
// module global and each case has to point that global at its own tree.

import fs from "node:fs";

import { sortedByCodePoint } from "../src/ordering.ts";
import { main } from "../src/validate-cli.ts";
import { foldParserProse } from "./spelling.ts";

const DIFFERENTIAL = import.meta.dir;
const REPOSITORY = `${DIFFERENTIAL}/../..`;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * What a case claims, so that agreement is never agreement about nothing.
 *
 * `exit` is the status the case says both sides reach, and every case makes
 * that claim — a case that agreed only about the text of a diagnostic would
 * still pass if both sides had stopped refusing. `says` names phrases the
 * diagnostics must carry, `prints` a phrase the summary line must carry.
 */
interface Case {
  readonly name: string;
  readonly argv: readonly string[];
  /** Overlaid on a copy of the repository's canon; null deletes. */
  readonly files?: Readonly<Record<string, string | null>>;
  /** The repository itself, for the cases whose subject is what it ships. */
  readonly shipped?: boolean;
  readonly exit: number;
  readonly says?: readonly string[];
  readonly prints?: string;
  readonly raises?: boolean;
}

const cases: Case[] = [];

function add(item: Case): void {
  if (item.raises !== true && item.prints === undefined && (item.says?.length ?? 0) === 0) {
    throw new Error(`${item.name}: a case must claim something beyond its exit status`);
  }
  cases.push(item);
}

const USAGE = "usage: «program» validate INSTANCE_ROOT | check-constants | conformance";

// The three healthy answers, over the repository itself and never a copy of
// it: what the gate is worth is what it says about the canon this ships.
add({
  name: "the constants this repository actually ships",
  argv: ["check-constants"],
  shipped: true,
  exit: 0,
  prints: "checked constants: 0 errors",
});

add({
  name: "the grammar fixtures this repository actually ships",
  argv: ["conformance"],
  shipped: true,
  exit: 0,
  prints: "cases, 0 errors",
});

add({
  name: "the demo instance this repository actually ships",
  argv: ["validate", `${REPOSITORY}/fixtures/demo-instance`],
  shipped: true,
  exit: 0,
  prints: "0 errors, 0 warnings",
});

// The dispatch. Three fixed shapes and a usage line, which means every other
// shape is a refusal — including the ones that look like a near miss.
add({ name: "no arguments at all", argv: [], exit: 2, says: [USAGE] });

add({ name: "a command nobody wrote", argv: ["lint"], exit: 2, says: [USAGE] });

add({
  name: "validate with no instance root",
  argv: ["validate"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "validate with two instance roots",
  argv: ["validate", "a", "b"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "check-constants handed an argument it has no use for",
  argv: ["check-constants", "extra"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "conformance handed an argument it has no use for",
  argv: ["conformance", "--verbose"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "the help nobody implemented",
  argv: ["--help"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "a command spelled with a capital",
  argv: ["Check-Constants"],
  exit: 2,
  says: [USAGE],
});

add({
  name: "an empty first argument",
  argv: [""],
  exit: 2,
  says: [USAGE],
});

add({
  name: "the command after an option terminator, which nothing here reads",
  argv: ["--", "check-constants"],
  exit: 2,
  says: [USAGE],
});

// Drift. Every case below edits the schema rather than the code, because the
// code is imported by both sides from the same place — and drift is symmetric:
// what the diagnostic says is that the two disagree, not which one moved.
const schema = (name: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(`${REPOSITORY}/spec/schemas/${name}.schema.json`, "utf8"),
  ) as Record<string, unknown>;

const rewritten = (
  name: string,
  edit: (document: Record<string, unknown>) => void,
): string => {
  const document = schema(name);
  edit(document);
  return `${JSON.stringify(document, null, 2)}\n`;
};

const defs = (document: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  document["$defs"] as Record<string, Record<string, unknown>>;

add({
  name: "a node type the schema no longer knows",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const node = defs(document)["nodeType"] as { enum: string[] };
      node.enum = node.enum.filter((name) => name !== "probe");
    }),
  },
  exit: 1,
  says: ["NODE_TYPES=", "does not match schema $defs.nodeType=", "'probe'"],
  prints: "checked constants: 1 errors",
});

add({
  name: "an edge type the schema invented on its own",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const edge = defs(document)["edgeType"] as { enum: string[] };
      edge.enum = [...edge.enum, "annotates"];
    }),
  },
  exit: 1,
  says: ["EDGE_TYPES=", "'annotates'"],
  prints: "checked constants: 1 errors",
});

add({
  name: "an id prefix pointed at another node type",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const prefixes = defs(document)["idPrefixes"] as {
        properties: Record<string, { const: string }>;
      };
      (prefixes.properties["probe"] as { const: string }).const = "question";
    }),
  },
  exit: 1,
  says: ["ID_PREFIXES=", "'probe': 'question'"],
  prints: "checked constants: 1 errors",
});

// Every endpoint rule is a `$ref`, so reaching one means resolving it — which
// is the half of this gate that no other case exercises.
add({
  name: "an endpoint rule that admits a kind the builder never emits",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const rule = defs(document)["endPatternZone"] as {
        properties: { source: { enum: string[] } };
      };
      rule.properties.source.enum = [...rule.properties.source.enum, "zone"];
    }),
  },
  exit: 1,
  says: ["ENDPOINT_RULES=", "'loads': ({'pattern'}"],
  prints: "checked constants: 1 errors",
});

add({
  name: "an endpoint rule that overrides the definition it refers to",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const rules = defs(document)["endpointRules"] as {
        properties: Record<string, unknown>;
      };
      // The merge is shallow on both sides: the referring object's
      // `properties` replaces the definition's rather than joining it.
      rules.properties["loads"] = {
        $ref: "#/$defs/endPatternZone",
        properties: {
          source: { enum: ["pattern"] },
          target: { enum: ["zone", "concept"] },
        },
      };
    }),
  },
  exit: 1,
  says: ["ENDPOINT_RULES=", "'loads': ({'pattern'}, {'zone'})"],
  prints: "checked constants: 1 errors",
});

add({
  name: "a decision value the schema dropped",
  argv: ["check-constants"],
  files: {
    "spec/schemas/journal-decision.schema.json": rewritten(
      "journal-decision",
      (document) => {
        const values = defs(document)["confidenceValue"] as { enum: string[] };
        values.enum = values.enum.slice(1);
      },
    ),
  },
  exit: 1,
  says: ["DECISION_VALUES.confidence=", "$defs.confidenceValue="],
  prints: "checked constants: 1 errors",
});

add({
  name: "a role the run manifest no longer admits",
  argv: ["check-constants"],
  files: {
    "spec/schemas/run-manifest.schema.json": rewritten("run-manifest", (document) => {
      const properties = document["properties"] as Record<string, { enum: string[] }>;
      const role = properties["role"] as { enum: string[] };
      role.enum = role.enum.filter((name) => name !== "state-auditor");
    }),
  },
  exit: 1,
  // The manifest roster and the journal's proposer roster are the same roster,
  // so one edit is two findings — which is the point of keeping both checks.
  says: ["AGENT_ROLES=", "run-manifest schema properties.role="],
  prints: "checked constants: 1 errors",
});

add({
  name: "two constants adrift at once",
  argv: ["check-constants"],
  files: {
    "spec/schemas/atlas-graph.schema.json": rewritten("atlas-graph", (document) => {
      const weight = defs(document)["edgeWeight"] as { enum: string[] };
      weight.enum = [...weight.enum, "critical"];
      const material = defs(document)["materialKind"] as { enum: string[] };
      material.enum = material.enum.slice(1);
    }),
  },
  exit: 1,
  says: ["EDGE_WEIGHTS=", "MATERIAL_KINDS="],
  prints: "checked constants: 2 errors",
});

// The §25.8 ceilings, the one constant whose canon is prose.
const NFR = "spec/25-non-functional-requirements.md";
const nfrText = fs.readFileSync(`${REPOSITORY}/${NFR}`, "utf8");

add({
  name: "the ceiling registry line struck out of the SDD",
  argv: ["check-constants"],
  files: { [NFR]: nfrText.replaceAll("intake batches", "intake bundles") },
  exit: 1,
  says: ["§25.8 intake ceiling registry line is missing or malformed"],
  prints: "checked constants: 1 errors",
});

add({
  name: "a ceiling the SDD raised and the code did not",
  argv: ["check-constants"],
  files: { [NFR]: nfrText.replace("16,384 records", "32,768 records") },
  exit: 1,
  says: ["process_intake.py intake ceilings do not match §25.8", "16384", "32768"],
  prints: "checked constants: 1 errors",
});

add({
  name: "a ceiling written without its thousands separators",
  argv: ["check-constants"],
  files: { [NFR]: nfrText.replace("16,777,216 total bytes", "16777216 total bytes") },
  exit: 0,
  prints: "checked constants: 0 errors",
});

// The registry underneath the gate. A schema that cannot be read is reported
// and the constant comparison never runs — there is nothing to compare against.
add({
  name: "a schema missing from the registry",
  argv: ["check-constants"],
  files: { "spec/schemas/probe.schema.json": null },
  exit: 1,
  says: ["schema inventory mismatch"],
  prints: "checked constants: 1 errors",
});

add({
  name: "a schema that is not JSON at all",
  argv: ["check-constants"],
  files: { "spec/schemas/probe.schema.json": "{\n" },
  exit: 1,
  says: ["invalid JSON"],
  prints: "checked constants: 1 errors",
});

// The other two commands, at the command line rather than under it: what is
// being agreed here is the wiring and the summary line, not the pass itself.
add({
  name: "conformance over a fixture the grammar refuses",
  argv: ["conformance"],
  files: {
    "fixtures/grammar/accept/minimal.fm": "no fences here\n",
    "fixtures/grammar/accept/minimal.json": "{}\n",
  },
  exit: 1,
  says: ["opening fence must be the exact line"],
  prints: "cases, 1 errors",
});

add({
  name: "validate over an instance that is not there",
  argv: ["validate", "/nonexistent-instance-root"],
  exit: 1,
  says: ["invalid-root"],
  prints: "validated: 0 frontmatter documents",
});

add({
  name: "validate over a curated tree with a broken document in it",
  argv: ["validate", "«root»/instance"],
  files: { "instance/concepts/broken.md": "---\nnot: [a, list]\n---\n" },
  exit: 1,
  says: ["flow-style collections are unsupported"],
  prints: "1 errors",
});

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

/** The end of the Python string literal that starts at `at`. */
function endOfString(text: string, at: number): number {
  const quote = text[at];
  let index = at + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/** The index past the `}` that closes the `{` at `at`. */
function endOfGroup(text: string, at: number): number {
  let depth = 0;
  let index = at;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "'" || char === '"') {
      index = endOfString(text, index);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** Split on the commas that belong to this group and not to a nested one. */
function members(inner: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < inner.length) {
    const char = inner[index] as string;
    if (char === "'" || char === '"') {
      index = endOfString(inner, index);
      continue;
    }
    if ("{[(".includes(char)) depth += 1;
    if ("}])".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      found.push(inner.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  if (inner.length > 0) found.push(inner.slice(start));
  return found;
}

/** Whether a member is `key: value` at this group's own depth — a dict entry. */
function isEntry(member: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < member.length) {
    const char = member[index] as string;
    if (char === "'" || char === '"') {
      index = endOfString(member, index);
      continue;
    }
    if ("{[(".includes(char)) depth += 1;
    if ("}])".includes(char)) depth -= 1;
    if (char === ":" && depth === 0) return true;
    index += 1;
  }
  return false;
}

/**
 * Sort the members of every set literal, leaving every other order alone.
 *
 * A dict keeps its insertion order in both languages and so is walked but not
 * reordered; a tuple is a pair whose halves mean different things. Only the
 * set is unordered, and only its members move.
 */
function foldSets(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "'" || char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "{") {
      const end = endOfGroup(text, index);
      const parts = members(text.slice(index + 1, end - 1)).map(foldSets);
      out +=
        parts.length > 0 && !parts.some(isEntry)
          ? `{${sortedByCodePoint(parts.map((part) => part.trim())).join(", ")}}`
          : `{${parts.join(",")}}`;
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const workspace = fs.mkdtempSync("/tmp/atlas-validate-cli-");

const roots = cases.map((item, index) => {
  if (item.shipped === true) return REPOSITORY;
  const root = `${workspace}/case-${String(index).padStart(2, "0")}`;
  fs.mkdirSync(`${root}/spec`, { recursive: true });
  fs.cpSync(`${REPOSITORY}/spec/schemas`, `${root}/spec/schemas`, { recursive: true });
  fs.cpSync(`${REPOSITORY}/${NFR}`, `${root}/${NFR}`);
  fs.cpSync(`${REPOSITORY}/fixtures/grammar`, `${root}/fixtures/grammar`, {
    recursive: true,
  });
  for (const [relative, text] of Object.entries(item.files ?? {})) {
    const target = `${root}/${relative}`;
    if (text === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return root;
});

/** `«root»` in an argument names the case's own tree. */
const argvOf = (item: Case, index: number): string[] =>
  item.argv.map((word) => word.replaceAll("«root»", roots[index] as string));

const payload = JSON.stringify({
  cases: cases.map((item, index) => ({
    root: roots[index],
    argv: argvOf(item, index),
  })),
});
// The roots are this run's temporary directories, so they are folded out
// of both the question and the answer before either is written down, and
// folded back in for the comparison below.
const theirs = (
  JSON.parse(
    unfoldRoots(
      oracleAnswer("validate-cli", foldRoots(payload, roots)) as string,
      roots,
    ),
  ) as {
    cases: Array<{ code?: number; stdout: string; stderr: string; raised?: boolean }>;
  }
).cases;

/** Divergences that are understood, each pinned by the issue that holds it. */
const KNOWN: ReadonlyMap<string, string> = new Map();

const spell = (text: string, root: string): string =>
  foldSets(text)
    .replaceAll(/validate_atlas\.(py|ts)/g, "«program»")
    .replaceAll(root, "«root»")
    // Line by line, because the fold is written for one diagnostic: run over a
    // whole stream it would swallow every line after the last invalid-JSON
    // lead-in, and a divergence in one of those would fold into agreement.
    .split("\n")
    .map(foldParserProse)
    .join("\n");

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const stillDiverging = new Set<string>();

cases.forEach((item, index) => {
  const oracle = theirs[index] as (typeof theirs)[number];
  const root = roots[index] as string;
  let out = "";
  let err = "";
  let code = -1;
  let raised = false;
  try {
    code = main(argvOf(item, index), "validate_atlas.ts", {
      out: { write: (text) => void (out += text) },
      err: { write: (text) => void (err += text) },
    }, root);
  } catch {
    raised = true;
  }

  // A crash is not a diagnostic: §24.4 asks a failing tool for a place and an
  // exit code, and the exception class behind it is prose in a language the
  // port does not share. What is compared is that both sides refused to answer.
  if (raised || oracle.raised === true) {
    if (raised && oracle.raised === true && item.raises === true) return;
    diverged += 1;
    console.error(
      `validate-cli: ${item.name}: mine ${raised ? "raised" : "returned"}, ` +
        `oracle ${oracle.raised === true ? "raised" : "returned"}`,
    );
    return;
  }

  const mine = JSON.stringify({
    code,
    stdout: spell(out, root),
    stderr: spell(err, root),
  });
  const theirText = JSON.stringify({
    code: oracle.code,
    stdout: spell(oracle.stdout, root),
    stderr: spell(oracle.stderr, root),
  });
  if (mine !== theirText) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`validate-cli: ${item.name}`);
    console.error(`  mine:   ${mine}`);
    console.error(`  oracle: ${theirText}`);
    return;
  }

  // Every claim is read off the oracle's answer, never off ours: a case whose
  // claim the implementation being replaced contradicts is proving nothing.
  const complaints: string[] = [];
  if (oracle.code !== item.exit) {
    complaints.push(`exited ${oracle.code}, not ${item.exit}`);
  }
  const said = spell(oracle.stderr, root);
  for (const phrase of item.says ?? []) {
    if (!said.includes(phrase)) complaints.push(`never said ${JSON.stringify(phrase)}`);
  }
  if ((item.says?.length ?? 0) === 0 && said !== "") {
    complaints.push("complained about a tree the case calls sound");
  }
  if (item.prints !== undefined && !oracle.stdout.includes(item.prints)) {
    complaints.push(`never printed ${JSON.stringify(item.prints)}`);
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`validate-cli: ${item.name}: the oracle ${complaints.join("; ")}`);
    console.error(`  stdout: ${JSON.stringify(oracle.stdout)}`);
    console.error(`  stderr: ${JSON.stringify(said)}`);
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`validate-cli: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `validate-cli: ${cases.length} invocations compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
