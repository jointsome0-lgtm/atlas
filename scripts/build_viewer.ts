#!/usr/bin/env bun

import ts from "typescript";

const SRC = new URL("../viewer/src/", import.meta.url);
const OUT = new URL("../viewer/", import.meta.url);
const MODULES = ["contract", "viewer"] as const;

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

// §25.8's CLI contract: exit 0 success, 1 failure, 2 usage; diagnostics to
// stderr, one per line, prefixed; stdout carries the result summary.
function fail(code: number, lines: readonly string[]): never {
  for (const line of lines) console.error(`ERROR: ${line}`);
  process.exit(code);
}

// Everything the build can throw — a source that will not parse, a missing
// file, a failed write — leaves as prefixed lines rather than as Bun's own
// multi-line dump. Covering the class beats naming the throw sites: the next
// failure mode nobody anticipated still reaches the caller in contract.
function diagnose(error: unknown): string[] {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function banner(name: string): string {
  return `// Generated from viewer/src/${name}.ts by scripts/build_viewer.ts — do not edit.\n`;
}

// The pure-erasure floor (§25.8) is a property of the source, not of the
// output: comparing emitted bytes only proves the committed file was
// regenerated. tsconfig's erasableSyntaxOnly bars enum, namespace, parameter
// properties, and import aliases; it does not bar decorators, which emit
// helper code of their own. Refuse them here, where the emission happens, so
// `bun run build` fails too — not only CI's typecheck step.
function assertErasable(name: string, source: string): void {
  const parsed = ts.createSourceFile(
    `${name}.ts`,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isDecorator(node)) {
      const at = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      found.push(`viewer/src/${name}.ts:${at.line + 1}:${at.character + 1}`);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(parsed, walk);
  if (found.length > 0) {
    fail(1, [
      ...found.map((at) => `${at}: decorator emits runtime code`),
      "decorators break the pure-erasure floor (§25.8); remove them",
    ]);
  }
}

function emit(name: string, source: string): string {
  assertErasable(name, source);
  const stripped = transpiler.transformSync(source);
  return banner(name) + (stripped.endsWith("\n") ? stripped : stripped + "\n");
}

// A misspelled flag must not fall through to write mode and overwrite the
// committed output: the only accepted forms are no argument and --check.
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0 || args.length > 1) {
  fail(2, [
    ...unknown.map((arg) => `unknown argument: ${arg}`),
    ...(unknown.length === 0 ? ["--check given more than once"] : []),
    "usage: bun scripts/build_viewer.ts [--check]",
  ]);
}

const check = args.includes("--check");
const stale: string[] = [];

let building = MODULES[0];

try {
  for (const name of MODULES) {
    building = name;
    const source = await Bun.file(new URL(`${name}.ts`, SRC)).text();
    const built = emit(name, source);
    const target = new URL(`${name}.js`, OUT);
    if (check) {
      const committed = await Bun.file(target)
        .text()
        .catch(() => "");
      if (committed !== built) stale.push(`viewer/${name}.js`);
    } else {
      await Bun.write(target, built);
    }
  }
} catch (error) {
  fail(1, [
    `viewer/src/${building}.ts: could not build`,
    ...diagnose(error),
  ]);
}

if (check && stale.length > 0) {
  fail(1, [
    ...stale.map((file) => `${file} does not match its source`),
    "run `bun run build` and commit the result",
  ]);
}

console.log(
  check
    ? `built output matches source (${MODULES.length} modules)`
    : `emitted ${MODULES.map((name) => `viewer/${name}.js`).join(", ")}`,
);
