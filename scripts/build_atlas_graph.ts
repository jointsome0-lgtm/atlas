#!/usr/bin/env bun
// §20: build a curated tree into one graph.
//
//   bun scripts/build_atlas_graph.ts [--check | --redact] [--as-of YYYY-MM-DD] \
//       CURATED_TREE OUTPUT_JSON
//
// The command line lives in scripts/src/boundary/build-cli.ts; this file is only the
// entry point. The exit code is set rather than forced, so whatever the run
// printed is on its way out before the process ends.

import { basename } from "node:path";

import { main } from "./src/boundary/build-cli.ts";

process.exitCode = main(process.argv.slice(2), basename(process.argv[1] ?? ""));
