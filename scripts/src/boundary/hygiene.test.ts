/**
 * Tests for the public Git-layer check.
 *
 * The question this file asks is the one the check exists for: does *this*
 * repository, as it stands right now, publish anything it should not. It is
 * the same question CI asks, asked again where a change is made rather than
 * after it is pushed.
 *
 * Whether the check reaches the same verdict as the oracle over repositories
 * built to break it — a secret nested three deep, a rule taken back by a
 * negation, a fixture marked in the tree and unmarked in the index — is a
 * separate question, answered over 24 constructed repositories by the
 * retired differential lane (git history, 3980cc3).
 *
 * Run: bun test scripts/src
 */

import { expect, test } from "bun:test";

import { checkHygiene } from "./hygiene.ts";

const REPOSITORY = `${import.meta.dir}/../../..`;

test("this repository publishes no denied path and no unmarked fixture", () => {
  let stdout = "";
  let stderr = "";
  const code = checkHygiene(REPOSITORY, {
    out: { write: (text) => void (stdout += text) },
    err: { write: (text) => void (stderr += text) },
  });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toBe(
    "OK: public Git layer has no denied paths or unmarked demo fixtures\n",
  );
});
