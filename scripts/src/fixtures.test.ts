// The committed fixtures, read as bytes.
//
// These are not tests of a module: they are the standing claim that what is in
// the repository is canonical, so a fixture cannot drift into a shape the
// validator would refuse and take the suites that rest on it down with it.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";

import { parseStrict } from "./canonical-json.ts";
import { validateInstance } from "./validate.ts";

const ROOT = `${import.meta.dir}/../..`;
const FIXTURE = `${ROOT}/fixtures/demo-graph/atlas-graph.json`;
const VIEWER_ACCEPTANCE = `${ROOT}/fixtures/viewer-acceptance`;

const raw = fs.readFileSync(FIXTURE);
const text = raw.toString("utf8");
const graph = parseStrict(text) as Record<string, unknown>;

describe("the demo graph fixture", () => {
  test("the real validation path accepts it", () => {
    const directory = fs.mkdtempSync(`${os.tmpdir()}/atlas-demo-graph-`);
    try {
      fs.mkdirSync(`${directory}/graph`);
      fs.copyFileSync(FIXTURE, `${directory}/graph/atlas-graph.json`);
      expect(validateInstance(directory, ROOT).errors).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("its order and identity are canonical", () => {
    const nodes = graph["nodes"] as Array<Record<string, unknown>>;
    const nodeIds = nodes.map((node) => node["id"] as string);
    expect(nodeIds).toEqual([...nodeIds].sort());
    expect(new Set(nodeIds).size).toBe(nodeIds.length);

    const edges = graph["edges"] as Array<Record<string, unknown>>;
    const key = (edge: Record<string, unknown>): string =>
      JSON.stringify([
        edge["type"],
        edge["source"],
        edge["target"],
        edge["context"] ?? "",
        edge["order"] ?? 0,
        edge["step"] ?? "",
      ]);
    // Sorted by the emitted key rather than by a comparison on the objects:
    // §20.3 fixes the order, and the fixture is the persisted form of it.
    expect(edges.map(key)).toEqual([...edges.map(key)].sort());
    for (const edge of edges) {
      const provenance = edge["provenance"] as string[];
      expect(provenance).toEqual([...provenance].sort());
    }
  });

  test("its persisted bytes are canonical", () => {
    expect(raw.includes(0x0d)).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(typeof graph).toBe("object");
    expect(text).toContain("Vera Example");
  });
});

describe("the viewer acceptance fixtures", () => {
  test("their persisted bytes are canonical", () => {
    const walk = (directory: string): string[] =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(`${directory}/${entry.name}`)
            : entry.isFile()
              ? [`${directory}/${entry.name}`]
              : [],
        )
        .sort();

    const fixtures = walk(VIEWER_ACCEPTANCE);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const where = fixture.slice(VIEWER_ACCEPTANCE.length + 1);
      expect(fixture.endsWith(".json"), where).toBe(true);
      const bytes = fs.readFileSync(fixture);
      const body = bytes.toString("utf8");
      const parsed = parseStrict(body);
      expect(bytes.includes(0x0d), where).toBe(false);
      expect(body.endsWith("\n"), where).toBe(true);
      expect(body.endsWith("\n\n"), where).toBe(false);
      expect(typeof parsed, where).toBe("object");
      expect(body, where).toContain("Vera Example");
    }
  });
});
