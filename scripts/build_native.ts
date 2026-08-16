#!/usr/bin/env bun
// §25.8: build the POSIX boundary and stage it where a plain checkout finds it.
//
// The artifact ships committed, one directory per registered target, beside its
// source. `target/` is cargo's scratch and stays untracked; `lib/<triple>/` is
// the shipped thing, and the file this writes is the file `posix.ts` loads —
// there is no second copy that could drift from the one that ran.
//
// `--check` builds and compares instead of writing, which is what CI asks: the
// committed bytes have to be the bytes this toolchain produces, or the pinned
// engine revision does not contain what ran (§17.5).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Kept beside `REGISTERED_TARGETS` in scripts/src/posix.ts on purpose: a new
// triple lands in both, in the change that first builds it.
const TARGETS: ReadonlyMap<string, string> = new Map([
  ["linux:x64", "x86_64-unknown-linux-gnu"],
]);

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const CRATE = path.join(REPOSITORY, "native", "atlas-posix");

function fail(lines: readonly string[]): never {
  for (const line of lines) process.stderr.write(`ERROR: ${line}\n`);
  process.exit(1);
}

function main(argv: readonly string[]): number {
  const checkOnly = argv.includes("--check");
  const rest = argv.filter((word) => word !== "--check");
  if (rest.length > 0) {
    process.stderr.write("usage: build_native.ts [--check]\n");
    return 2;
  }

  const host = `${process.platform}:${process.arch}`;
  const triple = TARGETS.get(host);
  if (triple === undefined) {
    fail([
      `no registered target for ${host}; §25.8's platform list is exactly the`,
      `boundary's registered targets: ${[...TARGETS.keys()].join(", ")}`,
    ]);
  }
  const suffix = process.platform === "darwin" ? "dylib" : "so";
  const name = `libatlas_posix.${suffix}`;

  // `--target` explicitly, never the host default: §25.8 records the triple as
  // a floor value, so the recipe has to build the triple it files the result
  // under. Without it a host whose default ABI differs — x86-64 musl is the
  // live example, since `process.arch` cannot tell the two apart — would build
  // one library and commit it under the other's name. Naming the host's own
  // triple changes no bytes; it only stops the two from drifting silently.
  const built = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--offline",
      "--target",
      triple,
      "--manifest-path",
      path.join(CRATE, "Cargo.toml"),
    ],
    { stdio: "inherit" },
  );
  if (built.error !== undefined || built.status !== 0) {
    fail([
      `cargo build failed${built.error === undefined ? "" : `: ${built.error.message}`}`,
      "the toolchain §25.8 pins is in rust-toolchain.toml; rustup honours it",
    ]);
  }

  const fresh = path.join(CRATE, "target", triple, "release", name);
  const shipped = path.join(CRATE, "lib", triple, name);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(fresh);
  } catch (error) {
    fail([`cargo produced no ${fresh}: ${(error as Error).message}`]);
  }

  if (checkOnly) {
    let committed: Buffer;
    try {
      committed = fs.readFileSync(shipped);
    } catch {
      fail([
        `${path.relative(REPOSITORY, shipped)}: not committed`,
        "§25.8 ships the artifact per target, so a plain checkout runs",
        "everything. Run: bun run build:native",
      ]);
    }
    if (!committed.equals(bytes)) {
      fail([
        `${path.relative(REPOSITORY, shipped)}: does not match a fresh build`,
        `committed ${committed.length} bytes, rebuilt ${bytes.length}`,
        "the committed artifact is what runs, so it is what must be current.",
        "Run: bun run build:native",
      ]);
    }
    process.stdout.write(
      `${path.relative(REPOSITORY, shipped)}: matches a fresh build ` +
        `(${bytes.length} bytes)\n`,
    );
    return 0;
  }

  fs.mkdirSync(path.dirname(shipped), { recursive: true });
  const temporary = `${shipped}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o644 });
  fs.renameSync(temporary, shipped);
  process.stdout.write(
    `${path.relative(REPOSITORY, shipped)}: ${bytes.length} bytes\n`,
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
