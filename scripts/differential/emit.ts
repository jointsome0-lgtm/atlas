import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the durable graph emit against the oracle.
//
// What is compared is not a return value but what the directory looks like
// afterwards: whether the call claimed success, what bytes sit at the
// canonical path, and whether the temp file was left behind. A write that
// reports failure and leaves a half-written graph is the exact outcome the
// temp-and-rename dance exists to prevent, and only the third of those three
// would notice it.
//
// The failure cases are made by taking away write permission on the directory
// rather than by patching anything, so both sides meet the same refusal from
// the same kernel.

import fs from "node:fs";

import { emitGraph } from "../src/emit.ts";

const DIFFERENTIAL = import.meta.dir;

const ORACLE = `
import json, os, sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(`${DIFFERENTIAL}/..`)})
import build_atlas_graph as B

out = []
for case in json.load(sys.stdin):
    root = Path(case["root"])
    output = root / "graph" / "atlas-graph.json"
    if case["mode"] is not None:
        os.chmod(output.parent, case["mode"])
    try:
        ok = B._emit_graph(output, case["graph"])
    finally:
        if case["mode"] is not None:
            os.chmod(output.parent, 0o755)
    out.append({
        "ok": ok,
        "exists": output.exists(),
        "bytes": output.read_bytes().decode() if output.exists() else None,
        "temp": output.with_name(output.name + ".tmp").exists(),
    })
json.dump(out, sys.stdout)
`;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const GRAPH: Dict = {
  format: "atlas-graph",
  version: 1,
  nodes: [{ id: "concept:a", type: "concept", title: "A — ünïcode", fields: [] }],
  edges: [],
  trails: [],
  state: {},
  influence: {},
  frontier: [],
  projections: {},
};

const OTHER: Dict = { ...GRAPH, version: 2 };

interface Case {
  readonly name: string;
  readonly graph: Dict;
  /** What is already at the canonical path, if anything. */
  readonly previous?: string;
  /** Whether `graph/` exists before the call, and whether it can be written. */
  readonly noDirectory?: boolean;
  readonly readonly?: boolean;
  /**
   * A directory that can be written but not opened — write and execute, no
   * read. Everything up to and including the rename succeeds, and then the
   * directory sync cannot open it. This is the only way in from outside to
   * the path that puts the previous bytes back, and without it the restore
   * would be code no test on either side has ever run.
   */
  readonly unreadable?: boolean;
  /**
   * A temp file left behind by an earlier run that died, which this run cannot
   * open — the leftover is read-only, so the write fails with the temp already
   * on disk. That is the one ordinary way to reach the cleanup: everywhere
   * else the write either never creates the temp or the rename consumes it.
   */
  readonly staleTemp?: string;
  /** What the case claims about the answer, so agreement is never empty. */
  readonly emits: boolean;
}

const cases: Case[] = [
  { name: "a graph where nothing was before", graph: GRAPH, emits: true },
  {
    name: "a graph replacing one already there",
    graph: OTHER,
    previous: "old bytes\n",
    emits: true,
  },
  {
    name: "a graph whose directory does not exist yet",
    graph: GRAPH,
    noDirectory: true,
    emits: true,
  },
  {
    name: "a directory that refuses to be written",
    graph: GRAPH,
    readonly: true,
    emits: false,
  },
  {
    name: "a refused write with a previous graph to leave alone",
    graph: OTHER,
    previous: "old bytes\n",
    readonly: true,
    emits: false,
  },
  {
    name: "a temp file left behind by a run that died, and unwritable",
    graph: OTHER,
    previous: "old bytes\n",
    staleTemp: "half a graph",
    emits: false,
  },
  {
    name: "a rename that lands and a directory sync that cannot",
    graph: OTHER,
    previous: "old bytes\n",
    unreadable: true,
    emits: false,
  },
  {
    name: "the same, with no previous graph to put back",
    graph: OTHER,
    unreadable: true,
    emits: false,
  },
];

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const workspace = fs.mkdtempSync("/tmp/atlas-emit-");

/** One tree per side per case: the two must not write over each other. */
function build(side: string, index: number, item: Case): string {
  const root = `${workspace}/${side}-${index}`;
  if (item.noDirectory !== true) {
    fs.mkdirSync(`${root}/graph`, { recursive: true });
    if (item.previous !== undefined) {
      fs.writeFileSync(`${root}/graph/atlas-graph.json`, item.previous);
    }
    if (item.staleTemp !== undefined) {
      fs.writeFileSync(`${root}/graph/atlas-graph.json.tmp`, item.staleTemp);
      fs.chmodSync(`${root}/graph/atlas-graph.json.tmp`, 0o444);
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

const theirRoots = cases.map((item, index) => build("oracle", index, item));
const payload = JSON.stringify(
  cases.map((item, index) => ({
    root: theirRoots[index],
    graph: item.graph,
    mode: item.readonly === true ? 0o555 : item.unreadable === true ? 0o300 : null,
  })),
);
// This run's temporary roots are folded out of the question and the answer
// before either is written down, and folded back in for the comparison.
const theirs = JSON.parse(
  unfoldRoots(
    oracleAnswer("emit", foldRoots(payload, theirRoots), () => {
      const run = Bun.spawnSync(["python3", "-c", ORACLE], {
        stdin: Buffer.from(payload),
      });
      if (run.exitCode !== 0) {
        console.error("emit: the oracle failed");
        console.error(run.stderr.toString());
        process.exit(1);
      }
      return foldRoots(run.stdout.toString(), theirRoots);
    }) as string,
    theirRoots,
  ),
) as Array<{
  ok: boolean;
  exists: boolean;
  bytes: string | null;
  temp: boolean;
}>;

let diverged = 0;
let vacuous = 0;

cases.forEach((item, index) => {
  const root = build("mine", index, item);
  const output = `${root}/graph/atlas-graph.json`;
  const mode =
    item.readonly === true ? 0o555 : item.unreadable === true ? 0o300 : null;
  if (mode !== null) fs.chmodSync(`${root}/graph`, mode);
  // The diagnostic is captured rather than let through: a refusal here is the
  // case working, and an `ERROR:` line in a green run reads like the opposite.
  // Holding it also makes it checkable — §24.4 asks the message for the place,
  // and the place is the one part of it this port promises.
  const said: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    said.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  let ok: boolean;
  try {
    ok = emitGraph(output, item.graph);
  } finally {
    process.stderr.write = realWrite;
    if (mode !== null) fs.chmodSync(`${root}/graph`, 0o755);
  }
  const exists = fs.existsSync(output);
  const mine = {
    ok,
    exists,
    bytes: exists ? fs.readFileSync(output, "utf8") : null,
    temp: fs.existsSync(`${output}.tmp`),
  };
  const oracle = theirs[index] as (typeof theirs)[number];
  if (JSON.stringify(mine) !== JSON.stringify(oracle)) {
    diverged += 1;
    console.error(`emit: ${item.name}`);
    console.error(`  mine:   ${JSON.stringify(mine)}`);
    console.error(`  oracle: ${JSON.stringify(oracle)}`);
    return;
  }
  // And what the case says it is about, read off the oracle's own answer.
  const complaints: string[] = [];
  if (oracle.ok !== item.emits) {
    complaints.push(`${oracle.ok ? "emitted" : "refused"} against the claim`);
  }
  if (!item.emits && item.previous !== undefined && oracle.bytes !== item.previous) {
    complaints.push("did not leave the previous graph where it was");
  }
  if (item.emits && oracle.bytes === item.previous) {
    complaints.push("left the previous graph in place");
  }
  if (oracle.temp) complaints.push("left its temp file behind");
  const diagnostic = said.join("");
  if (!item.emits && !diagnostic.includes(`cannot emit ${output}`)) {
    complaints.push("said nothing about the file it could not write");
  }
  if (item.emits && diagnostic !== "") {
    complaints.push("complained about a write that succeeded");
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`emit: ${item.name}: the oracle ${complaints.join("; ")}`);
  }
});

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `emit: ${cases.length} writes compared, ${diverged} unexplained, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 ? 0 : 1);
