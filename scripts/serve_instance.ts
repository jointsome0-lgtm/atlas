#!/usr/bin/env bun
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./src/boundary/serve.ts";

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
