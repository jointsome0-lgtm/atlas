#!/usr/bin/env bun

const SRC = new URL("../viewer/src/", import.meta.url);
const OUT = new URL("../viewer/", import.meta.url);
const MODULES = ["contract", "viewer"] as const;

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

function banner(name: string): string {
  return `// Generated from viewer/src/${name}.ts by scripts/build_viewer.ts — do not edit.\n`;
}

function emit(name: string, source: string): string {
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
