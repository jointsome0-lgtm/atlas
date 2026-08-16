#!/usr/bin/env bun
// Enforce the public Git-layer boundary for this repository.
//
//   bun scripts/check_public_hygiene.ts
//
// The check lives in scripts/src/hygiene.ts; this file is only the entry
// point, and the repository it inspects is the one it was run from — the
// directory above this script, as the oracle takes it.

import { checkHygiene } from "./src/hygiene.ts";

process.exitCode = checkHygiene(`${import.meta.dir}/..`, {
  out: process.stdout,
  err: process.stderr,
});
