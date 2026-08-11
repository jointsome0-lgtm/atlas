#!/usr/bin/env bun

import ts from "typescript";

const SRC = new URL("../viewer/src/", import.meta.url);
const OUT = new URL("../viewer/", import.meta.url);
const MODULES = ["contract", "viewer"] as const;

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

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
    console.error(
      "FAIL: decorators emit runtime code, which breaks the pure-erasure " +
        `floor (§25.8):\n  ${found.join("\n  ")}`,
    );
    process.exit(1);
  }
}

function emit(name: string, source: string): string {
  assertErasable(name, source);
  const stripped = transpiler.transformSync(source);
  return banner(name) + (stripped.endsWith("\n") ? stripped : stripped + "\n");
}

const check = process.argv.includes("--check");
const stale: string[] = [];

for (const name of MODULES) {
  const source = await Bun.file(new URL(`${name}.ts`, SRC)).text();
  const built = emit(name, source);
  const target = new URL(`${name}.js`, OUT);
  if (check) {
    const current = await Bun.file(target)
      .text()
      .catch(() => "");
    if (current !== built) stale.push(`viewer/${name}.js`);
  } else {
    await Bun.write(target, built);
  }
}

if (check && stale.length > 0) {
  console.error(
    `FAIL: built output is stale: ${stale.join(", ")}\n` +
      "Run `bun run build` and commit the result.",
  );
  process.exit(1);
}

console.log(
  check
    ? `built output matches source (${MODULES.length} modules)`
    : `emitted ${MODULES.map((name) => `viewer/${name}.js`).join(", ")}`,
);
