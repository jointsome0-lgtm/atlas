#!/usr/bin/env bun
// §25.7's preflight and the two canon gates beside it.
//
//   bun scripts/validate_atlas.ts validate INSTANCE_ROOT | check-constants | conformance
//
// The command line lives in scripts/src/boundary/validate-cli.ts; this file is only the
// entry point. The exit code is set rather than forced, so whatever the run
// printed is on its way out before the process ends.

import { basename } from "node:path";

import { main } from "./src/boundary/validate-cli.ts";

process.exitCode = main(process.argv.slice(2), basename(process.argv[1] ?? ""));
