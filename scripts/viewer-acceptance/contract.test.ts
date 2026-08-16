// The viewer's transcriptions, read against the canon they transcribe.
//
// The viewer has no config channel (§16.5), so every number and vocabulary it
// needs is copied into its source. A copy that drifts is the failure mode this
// suite exists for — and it is checked against the § prose and the schema, not
// against the other copy, because a matched pair can drift away together.

import { expect, test } from "bun:test";

import { FRESHNESS_DAYS as FOLD_FRESHNESS_DAYS } from "../src/core/domain.ts";

const ROOT = `${import.meta.dir}/../..`;
const VIEWER = `${ROOT}/viewer`;
// The canon transcriptions live in the TypeScript source, not the generated
// viewer/contract.js: the transpiler reprints object literals with unquoted
// keys, and scripts/build_viewer.ts --check is what binds output to source.
const CONTRACT = `${VIEWER}/src/contract.ts`;
const SCHEMA = `${ROOT}/spec/schemas/atlas-graph.schema.json`;
const NFR = `${ROOT}/spec/25-non-functional-requirements.md`;
const STATE_RULES = `${ROOT}/spec/14-state-update-rules.md`;

const text = async (path: string): Promise<string> => await Bun.file(path).text();

/** One `export const NAME = <json literal>;` from the contract source. */
function jsonConstant(source: string, name: string): unknown {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `export const ${escaped}(?:\\s*:[^=]+)? = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]);`,
  ).exec(source);
  if (match === null) throw new Error(`missing canonical JSON constant ${name}`);
  // The source is TypeScript, so a key may be bare and a trailing comma legal;
  // neither is JSON. Quoting the keys is a transport, not a reinterpretation.
  const literal = (match[1] as string)
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(literal) as unknown;
}

interface Schema {
  properties: Record<string, Dict>;
  $defs: Record<string, Dict>;
}
type Dict = Record<string, unknown>;

const source = await text(CONTRACT);
const schema = JSON.parse(await text(SCHEMA)) as Schema;

/** A `$defs` entry, named so a typo fails here rather than as `undefined`. */
function def(name: string): Dict {
  const found = schema.$defs[name];
  if (found === undefined) throw new Error(`the schema has no $defs/${name}`);
  return found;
}

/** A nested object, walked by key, refusing anything that is not there. */
function at(root: Dict, ...keys: string[]): Dict {
  let here: unknown = root;
  for (const key of keys) {
    if (typeof here !== "object" || here === null) {
      throw new Error(`the schema path ${keys.join("/")} runs through a non-object`);
    }
    here = (here as Dict)[key];
    if (here === undefined) throw new Error(`the schema has no ${keys.join("/")}`);
  }
  return here as Dict;
}

/** An `enum` array at a schema path. */
const enumAt = (root: Dict, ...keys: string[]): unknown => at(root, ...keys)["enum"];

test("the acceptance ceilings transcribe §25.8", async () => {
  const block = /Viewer acceptance ceilings[\s\S]*?Foreign-input acceptance ceilings/.exec(
    await text(NFR),
  );
  expect(block).not.toBeNull();
  const ceilings = (block as RegExpExecArray)[0];

  const number = (pattern: RegExp): number => {
    const match = pattern.exec(ceilings);
    expect(match, pattern.source).not.toBeNull();
    return Number(((match as RegExpExecArray)[1] as string).replace(/,/g, ""));
  };

  expect(jsonConstant(source, "CEILINGS")).toEqual({
    graph_file_bytes: number(/graph file\s*\n?\s*≤\s*([0-9,]+) bytes/),
    graph_nodes: number(/bytes,\s*≤\s*([0-9,]+) nodes/),
    graph_edges: number(/nodes,\s*≤\s*([0-9,]+) edges/),
    fragment_raw_bytes: number(/raw fragment\s*≤\s*([0-9,]+) bytes/),
    parameter_decoded_bytes: number(/decoded parameter value\s*\n?\s*≤\s*([0-9,]+) bytes/),
  });
});

// §14.7 owns the numbers; the fold and the viewer each transcribe them (#108).
// Neither copy is canon, so checking them against each other would let a
// matched pair drift away from the § together — both are read against the
// prose instead. Tuning is a version bump in canon, which starts here and
// fails both transcriptions at once.
test("the freshness boundaries transcribe §14.7", async () => {
  const block = /## §14\.7 Freshness Decay[\s\S]*?```text\n([\s\S]*?)```/.exec(
    await text(STATE_RULES),
  );
  expect(block).not.toBeNull();

  // Every line is consumed and every class named once: a block that grew a
  // fourth boundary, lost one, or repeated a class must not reach the
  // comparison below with three lucky matches. A regex that merely finds what
  // it expects would agree with a canon that had stopped being a partition.
  const lines = ((block as RegExpExecArray)[1] as string)
    .split("\n")
    .filter((line) => line.trim() !== "");
  const parsed = lines.map((line) => /^(fresh|aging|stale)\s+([≤>]) (\d+) days$/.exec(line));
  expect(parsed.includes(null), lines.join(" | ")).toBe(false);
  const rows = parsed as RegExpExecArray[];
  expect(rows.map((row) => [row[1], row[2]])).toEqual([
    ["fresh", "≤"],
    ["aging", "≤"],
    ["stale", ">"],
  ]);

  // Names, not values: pinning the numbers here would be a third copy of what
  // the § is supposed to own. This only proves the prose was actually read, so
  // an unparsed block cannot pass as agreement.
  const [fresh, aging, stale] = rows.map((row) => Number(row[3])) as [number, number, number];
  // The three lines are one partition, so `stale` opens where `aging` closes.
  // Nothing outside the § can catch a tuning that moved one line and not the
  // other — both transcriptions would faithfully copy a canon that had stopped
  // covering the days between them.
  expect(aging).toBe(stale);
  expect(fresh).toBeLessThan(aging);

  const boundaries = { fresh, aging };
  expect(jsonConstant(source, "FRESHNESS_DAYS")).toEqual(boundaries);
  expect(Object.fromEntries(FOLD_FRESHNESS_DAYS)).toEqual(boundaries);
});

test("the closed keys and enums transcribe the schema", () => {
  const state = at(schema.properties, "state", "additionalProperties");
  const shapes = state["oneOf"] as Dict[];
  const concept = at(shapes[0] as Dict, "properties");
  const material = at(shapes[1] as Dict, "properties");
  const question = at(shapes[2] as Dict, "properties");
  // §14.7 (#105): one class vocabulary across both contact shapes, so the
  // single FRESHNESS_VALUES transcription below covers both.
  expect(enumAt(concept, "freshness")).toEqual(enumAt(material, "freshness"));

  const comparisons: Record<string, unknown> = {
    ENVELOPE_KEYS: Object.keys(schema.properties),
    NODE_KEYS: Object.keys(at(def("node"), "properties")),
    EDGE_KEYS: Object.keys(at(def("edge"), "properties")),
    NODE_TYPES: def("nodeType")["enum"],
    EDGE_TYPES: def("edgeType")["enum"],
    AUTHORED_ROLES: def("authoredRole")["enum"],
    FIELDS: def("field")["enum"],
    MATERIAL_KINDS: def("materialKind")["enum"],
    EVIDENCE_STRENGTHS: def("evidenceStrength")["enum"],
    ENCOUNTER_DEPTHS: def("encounterDepth")["enum"],
    ENCOUNTER_MODES: enumAt(def("node"), "properties", "mode"),
    SENSITIVITY_CLASSES: enumAt(def("node"), "properties", "sensitivity"),
    EDGE_WEIGHTS: def("emittedEdgeWeight")["enum"],
    CONFIDENCE_VALUES: enumAt(def("edge"), "properties", "confidence"),
    CONCEPT_EXPOSURES: enumAt(concept, "exposure"),
    CLARITY_VALUES: enumAt(concept, "clarity"),
    COVERAGE_VALUES: enumAt(concept, "coverage"),
    FRESHNESS_VALUES: enumAt(concept, "freshness"),
    QUESTION_STATUSES: enumAt(question, "status"),
    LIFECYCLE_STATUSES: def("lifecycleStatus")["enum"],
    ROUTE_STATUSES: def("routeStatus")["enum"],
  };
  for (const [constant, expected] of Object.entries(comparisons)) {
    expect(jsonConstant(source, constant), constant).toEqual(expected);
  }

  const prefixes = Object.fromEntries(
    Object.entries(at(def("idPrefixes"), "properties")).map(
      ([name, definition]) => [name, (definition as Dict)["const"]],
    ),
  );
  expect(jsonConstant(source, "ID_PREFIXES")).toEqual(prefixes);
});

test("the endpoint rules transcribe the schema", () => {
  const expected: Record<string, unknown[]> = {};
  for (const [edgeType, reference] of Object.entries(at(def("endpointRules"), "properties"))) {
    const name = ((reference as Dict)["$ref"] as string).split("/").pop() as string;
    const endpoint = at(def(name), "properties");
    expected[edgeType] = [enumAt(endpoint, "source"), enumAt(endpoint, "target")];
  }
  expect(jsonConstant(source, "ENDPOINT_RULES")).toEqual(expected);
});

test("the index carries the exact CSP and referrer policy", async () => {
  const metas: Record<string, string>[] = [];
  const scripts: Record<string, string>[] = [];
  const styles: Record<string, string>[] = [];
  const links: Record<string, string>[] = [];
  const eventAttributes: string[] = [];

  const collect = (into: Record<string, string>[]) => ({
    element(element: HTMLRewriterTypes.Element): void {
      const attributes: Record<string, string> = {};
      for (const [name, value] of element.attributes) {
        attributes[name] = value;
        if (name.toLowerCase().startsWith("on")) eventAttributes.push(name);
      }
      into.push(attributes);
    },
  });
  await new HTMLRewriter()
    .on("meta", collect(metas))
    .on("script", collect(scripts))
    .on("style", collect(styles))
    .on("link", collect(links))
    .transform(new Response(await text(`${VIEWER}/index.html`)))
    .text();

  expect(
    metas.filter((meta) => meta["http-equiv"] === "Content-Security-Policy").map((m) => m["content"]),
  ).toEqual([
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
      "connect-src 'self'; img-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'none'",
  ]);
  expect(metas.filter((meta) => meta["name"] === "referrer").map((m) => m["content"])).toEqual([
    "no-referrer",
  ]);
  expect(scripts).toEqual([{ type: "module", src: "./viewer.js" }]);
  expect(links).toEqual([
    { rel: "icon", href: "./favicon.svg", type: "image/svg+xml" },
    { rel: "stylesheet", href: "./viewer.css" },
  ]);
  expect(styles).toEqual([]);
  expect(eventAttributes).toEqual([]);
});

test("the viewer sources keep the render and network floor", async () => {
  const external = /https?:\/\/[^\s"']+/;
  // Recursive: the floor binds the TypeScript sources under viewer/src/ as
  // well as the generated files served to the browser.
  const walk = async (directory: string): Promise<string[]> => {
    const { readdirSync } = await import("node:fs");
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) found.push(...(await walk(path)));
      else if (entry.isFile()) found.push(path);
    }
    return found.sort();
  };

  const files = await walk(VIEWER);
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const body = await text(path);
    const network = body.split('xmlns="http://www.w3.org/2000/svg"').join("");
    expect(body.includes("inner" + "HTML"), path).toBe(false);
    expect(network.includes("http" + "://"), path).toBe(false);
    expect(external.test(network), path).toBe(false);
  }
});
