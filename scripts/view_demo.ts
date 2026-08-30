#!/usr/bin/env bun
// Build and serve the invented Atlas demo without writing inside the repo.
//
//   bun scripts/view_demo.ts [--port PORT]
//
// The command line lives in scripts/src/boundary/demo-cli.ts; this file is only the
// entry point. The exit code is set rather than forced, so whatever the run
// printed is on its way out before the process ends.

import { existsSync } from "node:fs";
import { basename } from "node:path";

import { main } from "./src/boundary/demo-cli.ts";

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
