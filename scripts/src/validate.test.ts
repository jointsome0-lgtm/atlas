import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { validateInstance } from "./validate.ts";

// The differential harness proves this driver reports what CPython reports,
// case by case. What is pinned here is what a comparison of two return values
// cannot show: that the oracle-shaped `PurePosixPath` join really is a path
// join and not string arithmetic that happens to agree on slug-shaped input,
// and that the two roots stay two roots.

const REPO = `${import.meta.dir}/../..`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/atlas-validate-test-");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** One delivered batch under `intake/<at>`, naming `<source>/<batch>`. */
function deliver(at: string, source: string, batch: string): void {
  const path = `${root}/intake/${at}`;
  fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(
    path,
    `${JSON.stringify({
      format: "atlas-intake",
      version: 1,
      source,
      batch,
      records: [],
    })}\n`,
  );
}

const complaints = (): string[] => validateInstance(root, REPO).errors;

const misplaced = (messages: readonly string[]): string[] =>
  messages.filter((message) => message.includes("(§33.2)"));

describe("§33.2: where a delivery sits against where its envelope says", () => {
  test("a plain slug pair matches the file it was delivered as", () => {
    deliver("watch-sync/2026-07-16-001.json", "watch-sync", "2026-07-16-001");
    expect(misplaced(complaints())).toEqual([]);
  });

  test("a source spelled with a trailing slash still matches", () => {
    // `PurePosixPath("watch-sync/") / "x.json"` is `watch-sync/x.json`; string
    // concatenation would produce `watch-sync//x.json` and complain. The
    // envelope is refused by the schema either way — this is about the two
    // implementations refusing it for the same reasons and no others.
    deliver("watch-sync/2026-07-16-001.json", "watch-sync/", "2026-07-16-001");
    expect(misplaced(complaints())).toEqual([]);
  });

  test("a source spelled with a leading `./` still matches", () => {
    deliver("watch-sync/2026-07-16-001.json", "./watch-sync", "2026-07-16-001");
    expect(misplaced(complaints())).toEqual([]);
  });

  test("an absolute batch name discards the source entirely", () => {
    // The join's left-hand side is dropped, so the delivery cannot match and
    // the complaint is the point — a concatenating join would have agreed.
    deliver("watch-sync/2026-07-16-001.json", "watch-sync", "/2026-07-16-001");
    expect(misplaced(complaints())).toHaveLength(1);
  });

  test("a `..` in the source is kept rather than resolved away", () => {
    deliver("watch-sync/2026-07-16-001.json", "a/../watch-sync", "2026-07-16-001");
    expect(misplaced(complaints())).toHaveLength(1);
  });
});

describe("the two roots", () => {
  test("an instance with no schemas of its own still validates", () => {
    // Schemas are the repository's canon and the instance is wherever the
    // caller points; a private instance has never carried a `spec/` directory
    // and must not have to.
    deliver("watch-sync/2026-07-16-001.json", "watch-sync", "2026-07-16-001");
    const report = validateInstance(root, REPO);
    expect(report.errors).toEqual([]);
    expect(report.counts.intake).toBe(1);
  });

  test("a repository root with no schemas reports that and stops", () => {
    const report = validateInstance(root, root);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.counts).toEqual({
      frontmatter: 0,
      rows: 0,
      intake: 0,
      emitted: 0,
    });
  });
});
