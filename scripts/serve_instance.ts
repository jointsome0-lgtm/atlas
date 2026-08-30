#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename } from "node:path";

import { main } from "./src/boundary/serve.ts";

const viewerDir = new URL("../viewer/", import.meta.url);
if (["viewer.js", "contract.js"].some((name) => !existsSync(new URL(name, viewerDir)))) {
  const build = Bun.spawnSync(["bun", new URL("build_viewer.ts", import.meta.url).pathname]);
  if (build.exitCode !== 0) {
    process.stderr.write(build.stderr);
    console.error("ERROR: the viewer emission is missing and its build failed; run `bun install` once, then retry");
    process.exit(1);
  }
}

process.exitCode = await main(process.argv.slice(2), basename(process.argv[1] ?? ""));
