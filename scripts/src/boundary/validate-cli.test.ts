/**
 * Tests for the `validate_atlas` command line.
 *
 * A port of the CLI assertions in `test_validate_atlas.py`: the constants gate
 * over this repository, the usage line, and that each command answers for
 * itself. What the three passes conclude is tested where they live; this is
 * about the dispatch and the summary each one prints.
 *
 * That the Python and TypeScript implementations answer identically is a
 * separate question, asked in `scripts/differential/validate-cli.ts`.
 *
 * Run: bun test scripts/src
 */

import { expect, test } from "bun:test";

import { main } from "./validate-cli.ts";

const REPOSITORY = `${import.meta.dir}/../../..`;

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(...argv: string[]): Result {
  let stdout = "";
  let stderr = "";
  const code = main(argv, "validate_atlas.ts", {
    out: { write: (text) => void (stdout += text) },
    err: { write: (text) => void (stderr += text) },
  });
  return { code, stdout, stderr };
}

test("the constants this repository ships match its schemas", () => {
  const result = run("check-constants");
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("checked constants: 0 errors\n");
});

test("the grammar fixtures this repository ships all pass", () => {
  const result = run("conformance");
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^conformance: \d+ cases, 0 errors\n$/);
  expect(result.stderr).toBe("");
});

test("the demo instance this repository ships validates clean", () => {
  const result = run("validate", `${REPOSITORY}/fixtures/demo-instance`);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("0 errors, 0 warnings");
});

test("no arguments is the usage line and exit 2", () => {
  const result = run();
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.startsWith("ERROR: usage:")).toBe(true);
});

test("every shape but the three is the usage line", () => {
  for (const argv of [
    ["lint"],
    ["validate"],
    ["validate", "a", "b"],
    ["check-constants", "extra"],
    ["conformance", "--verbose"],
    ["--help"],
    [""],
  ]) {
    const result = run(...argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stdout, argv.join(" ")).toBe("");
    expect(result.stderr).toContain(
      "usage: validate_atlas.ts validate INSTANCE_ROOT | check-constants | conformance",
    );
  }
});
