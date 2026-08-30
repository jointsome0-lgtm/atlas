#!/usr/bin/env bun
// Build and serve the invented Atlas demo without writing inside the repo.
//
//   bun scripts/view_demo.ts [--port PORT]
//
// The command line lives in scripts/src/boundary/demo-cli.ts; this file is only the
// entry point. The exit code is set rather than forced, so whatever the run
// printed is on its way out before the process ends.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./src/boundary/demo-cli.ts";

const build = Bun.spawnSync([
  process.execPath,
  "--no-install",
  fileURLToPath(new URL("build_viewer.ts", import.meta.url)),
]);
if (build.stderr.length > 0) process.stderr.write(build.stderr);
if (build.exitCode !== 0) {
  console.error("ERROR: the viewer emission could not be built from viewer/src");
  process.exit(1);
}

process.exitCode = await main(process.argv.slice(2), basename(process.argv[1] ?? ""));
