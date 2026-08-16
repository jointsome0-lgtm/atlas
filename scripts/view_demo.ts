#!/usr/bin/env bun
// Build and serve the invented Atlas demo without writing inside the repo.
//
//   bun scripts/view_demo.ts [--port PORT]
//
// The command line lives in scripts/src/boundary/demo-cli.ts; this file is only the
// entry point. The exit code is set rather than forced, so whatever the run
// printed is on its way out before the process ends.

import { basename } from "node:path";

import { main } from "./src/boundary/demo-cli.ts";

process.exitCode = await main(process.argv.slice(2), basename(process.argv[1] ?? ""));
