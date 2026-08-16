#!/usr/bin/env bun
// Deterministically apply one versioned Atlas intake batch (§33.2, #56).
//
// The exit code is set rather than forced, so whatever the run printed is on
// its way out before the process ends.

import { basename } from "node:path";

import { main } from "./src/intake-cli.ts";

process.exitCode = main(process.argv.slice(2), basename(process.argv[1] ?? ""));
