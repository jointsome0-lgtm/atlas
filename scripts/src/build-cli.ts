// §20.2/§25.6: the builder's command line.
//
// Everything here happens around a build rather than inside one: the argument
// grammar, the two shape checks that run before a single file is opened, the
// single-writer lock, and the one place a build becomes an exit code. The
// order is the point and is preserved exactly — a mis-mounted input is refused
// before the output-derived lock or any output path is touched, `--check`
// included, so a mistyped instance can never take a lock over someone else's.
//
// Ported from main, _print_usage, _release_lock, _valid_as_of and _run in
// scripts/build_atlas_graph.py.

import fs from "node:fs";

import { build, relativeToRoot } from "./build.ts";
import { CalendarError, parseDate } from "./calendar.ts";
import { CURATED_SUBDIRECTORIES } from "./domain.ts";
import { emitGraph, syncDir } from "./emit.ts";
import { FrontmatterError } from "./frontmatter.ts";
import { AtlasReader, ReaderError, ReasonCode } from "./reader.ts";
import { abspath, posixJoin, posixSplit, splitPath } from "./paths.ts";
import { redactGraph } from "./redact.ts";

type Dict = Record<string, unknown>;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const complain = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * `Path.resolve()` — which is emphatically not `path.resolve`.
 *
 * The one place in the builder where a path is resolved *through* symlinks
 * rather than only normalized, and it has to be: §25.6 gives one instance one
 * lock, and two spellings of the same instance that differ by a link would
 * otherwise take two locks and let two writers in. Node's `realpathSync`
 * cannot stand in — it refuses a path that does not exist yet, and the output
 * graph usually does not.
 *
 * So this walks the components the way `posixpath.realpath(strict=False)`
 * does: left to right, resolving each link against what has been resolved so
 * far, treating a component that is not there as itself, and giving up on a
 * link loop by leaving the rest of the path alone.
 */
function resolvePath(target: string): string {
  const seen = new Map<string, string | null>();

  const walk = (base: string, rest: string): { path: string; ok: boolean } => {
    let current = base;
    let remaining = rest;
    if (remaining.startsWith("/")) {
      remaining = remaining.slice(1);
      current = "/";
    }
    while (remaining !== "") {
      const cut = remaining.indexOf("/");
      const name = cut < 0 ? remaining : remaining.slice(0, cut);
      remaining = cut < 0 ? "" : remaining.slice(cut + 1);
      if (name === "" || name === ".") continue;
      if (name === "..") {
        if (current !== "") {
          const [head, tail] = posixSplit(current);
          current = tail === ".." ? posixJoin(posixJoin(head, ".."), "..") : head;
        } else {
          current = "..";
        }
        continue;
      }
      const candidate = posixJoin(current, name);
      let isLink = false;
      try {
        isLink = fs.lstatSync(candidate).isSymbolicLink();
      } catch {
        // Not there, or not readable: it stands for itself, as it does in the
        // oracle's non-strict mode.
        isLink = false;
      }
      if (!isLink) {
        current = candidate;
        continue;
      }
      if (seen.has(candidate)) {
        const resolved = seen.get(candidate) ?? null;
        if (resolved !== null) {
          current = resolved;
          continue;
        }
        // A loop. Non-strict resolution stops here and keeps what is left.
        return { path: posixJoin(candidate, remaining), ok: false };
      }
      seen.set(candidate, null);
      const inner = walk(current, fs.readlinkSync(candidate));
      if (!inner.ok) return { path: posixJoin(inner.path, remaining), ok: false };
      current = inner.path;
      seen.set(candidate, current);
    }
    return { path: current, ok: true };
  };

  return abspath(walk("", target).path);
}

/** `Path.with_name`: the last component replaced, the rest untouched. */
function withName(path: string, name: string): string {
  const [head] = posixSplit(path);
  return posixJoin(head, name);
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

function printUsage(program: string): number {
  complain(
    `usage: ${program} [--check | --redact] ` +
      "[--as-of YYYY-MM-DD] CURATED_TREE " +
      "OUTPUT_JSON (graph/atlas-graph.json)",
  );
  return 2;
}

const AS_OF_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * Whether `--as-of` names a day that exists.
 *
 * The oracle asks the same two questions — the shape, then whether the
 * calendar admits it — and its answers agree with these for every ASCII date.
 * They part on one input: CPython's `\d` is Unicode-wide, so a year written in
 * Arabic-Indic digits passes its shape check and then its `%Y` field, and a
 * build runs with an as-of nothing else in the system can compare against.
 * §20.1 says YYYY-MM-DD, so that spelling is refused here. Recorded as #134.
 */
function validAsOf(value: string): boolean {
  if (!AS_OF_SHAPE.test(value)) return false;
  try {
    parseDate(value);
    return true;
  } catch (error) {
    if (error instanceof CalendarError) return false;
    throw error;
  }
}

/**
 * Remove the lock, but only the one this process made.
 *
 * §25.6: if another actor replaced the path in the meantime, its lock is not
 * this writer's to clean up, and unlinking by name would free an instance
 * somebody else is holding.
 */
export function releaseLock(lockFd: number, lock: string): void {
  try {
    const own = fs.fstatSync(lockFd, { bigint: true });
    let onDisk: fs.BigIntStats | null = null;
    try {
      onDisk = fs.statSync(lock, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      onDisk = null;
    }
    if (onDisk !== null && onDisk.dev === own.dev && onDisk.ino === own.ino) {
      fs.unlinkSync(lock);
    }
  } finally {
    fs.closeSync(lockFd);
  }
}

/** The build itself, and what its outcome does to the instance. */
function run(
  curated: string,
  output: string,
  checkOnly: boolean,
  asOf: string | null,
  redact: boolean,
): number {
  let graph: Dict;
  let errors: string[];
  let warnings: string[];
  try {
    ({ graph, errors, warnings } = build(curated, asOf));
  } catch (error) {
    if (!(error instanceof FrontmatterError)) throw error;
    complain(`ERROR: ${error.message}`);
    return 1;
  }
  for (const warning of warnings) complain(`WARNING: ${warning}`);
  if (errors.length > 0) {
    for (const error of errors) complain(`ERROR: ${error}`);
    return 1;
  }
  if (!checkOnly) {
    if (!emitGraph(output, graph)) return 1;
    const redactedOutput = withName(output, "atlas-graph.redacted.json");
    if (redact) {
      if (!emitGraph(redactedOutput, redactGraph(graph))) return 1;
    } else {
      // §32.6: a stale agent-facing variant must never outlive the build that
      // obsoleted it — content classed after the variant was emitted would
      // keep leaking through the old file.
      let removed = false;
      try {
        fs.unlinkSync(redactedOutput);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          complain(
            `ERROR: cannot remove stale ${redactedOutput}: ${(error as Error).message}`,
          );
          return 1;
        }
      }
      if (removed) {
        // §25.6: the removal is only durable once graph/'s entry is synced —
        // a crash before that could resurrect the stale variant next to a
        // newer full graph.
        try {
          syncDir(posixSplit(redactedOutput)[0]);
        } catch (error) {
          complain(
            `ERROR: cannot remove stale ${redactedOutput}: ${(error as Error).message}`,
          );
          return 1;
        }
      }
    }
  }
  const display = relativeToRoot(output);
  say(
    `${checkOnly ? "checked" : "built"}: ` +
      `${(graph["nodes"] as unknown[]).length} nodes, ` +
      `${(graph["edges"] as unknown[]).length} edges` +
      (checkOnly ? "" : ` -> ${display}`),
  );
  return 0;
}

export function main(args: readonly string[], program: string): number {
  let checkOnly = false;
  let redact = false;
  let asOf: string | null = null;
  const positional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === "--check") {
      if (checkOnly) {
        complain("ERROR: --check may be specified only once");
        return printUsage(program);
      }
      checkOnly = true;
    } else if (arg === "--redact") {
      if (redact) {
        complain("ERROR: --redact may be specified only once");
        return printUsage(program);
      }
      redact = true;
    } else if (arg === "--as-of") {
      if (asOf !== null) {
        complain("ERROR: --as-of may be specified only once");
        return printUsage(program);
      }
      index += 1;
      if (index >= args.length || !validAsOf(args[index] as string)) {
        complain("ERROR: --as-of requires YYYY-MM-DD");
        return printUsage(program);
      }
      asOf = args[index] as string;
    } else {
      positional.push(arg);
    }
    index += 1;
  }
  if (positional.length !== 2) return printUsage(program);
  if (checkOnly && redact) {
    complain("ERROR: --check and --redact cannot be combined");
    return printUsage(program);
  }

  let curated = positional[0] as string;

  // §20.2 (#60): reject a missing or mis-mounted input before the
  // output-derived lock or any output path is touched, including --check.
  let inputReader: AtlasReader;
  let curatedPrefix: string;
  let hasEntries: boolean;
  let hasCuratedDirectory: boolean;
  try {
    const named = splitPath(curated).name === "atlas";
    inputReader = new AtlasReader(named ? splitPath(curated).parent : curated);
    curatedPrefix = named ? "atlas" : ".";
    if (named && !inputReader.isDirectory("atlas")) {
      throw new ReaderError(ReasonCode.InvalidRoot);
    }
    hasEntries = inputReader.hasEntries(curatedPrefix);
    hasCuratedDirectory = CURATED_SUBDIRECTORIES.some((name) =>
      inputReader.isDirectory(
        curatedPrefix === "." ? name : `${curatedPrefix}/${name}`,
      ),
    );
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    complain(`ERROR: ${curated}: ${error.message}`);
    return 1;
  }
  // §20.1: an EMPTY curated tree is a valid fresh instance and still builds;
  // a mis-mount is a directory with content but none of the §8 curated
  // subdirectories.
  if (hasEntries && !hasCuratedDirectory) {
    complain(
      `ERROR: ${curated}: not shaped like a curated tree ` +
        "(expected at least one §8 curated subdirectory)",
    );
    return 1;
  }
  curated =
    curatedPrefix === "." ? inputReader.root : posixJoin(inputReader.root, "atlas");

  const output = resolvePath(positional[1] as string);
  const outputSplit = splitPath(output);
  if (
    outputSplit.name !== "atlas-graph.json" ||
    splitPath(outputSplit.parent).name !== "graph"
  ) {
    complain(
      `ERROR: ${output}: OUTPUT_JSON must end in graph/atlas-graph.json`,
    );
    return printUsage(program);
  }
  // §25.6: with the normal layout the curated tree is INSTANCE/atlas and its
  // journals are read from the same instance — the output-derived lock must
  // guard exactly that root, or a held input-instance lock would be bypassed
  // and the builder could race another writer.
  const curatedSplit = splitPath(curated);
  const instanceRoot = splitPath(outputSplit.parent).parent;
  if (curatedSplit.name === "atlas" && curatedSplit.parent !== instanceRoot) {
    complain(
      `ERROR: ${curated} belongs to instance ${curatedSplit.parent}, but ` +
        `OUTPUT_JSON derives instance ${instanceRoot} — one instance, one ` +
        "lock (§25.6)",
    );
    return 1;
  }

  // §25.6 (#36): the instance is single-writer — every writing flow takes
  // .atlas-lock at the output-derived instance root, acquire-if-absent
  // (O_CREAT|O_EXCL), and refuses when it is already held; stale locks are
  // removed by hand.
  let lockFd: number | null = null;
  // §20.2/§25.6 (#60): canonical output is INSTANCE/graph/atlas-graph.json,
  // so its grandparent owns the lock.
  const lock = posixJoin(instanceRoot, ".atlas-lock");
  if (!checkOnly) {
    try {
      lockFd = fs.openSync(
        lock,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        complain(
          `ERROR: ${lock} is already held — the instance is single-writer ` +
            "(§25.6); if its holder crashed, inspect and remove the lock by hand",
        );
        return 1;
      }
      complain(`ERROR: cannot acquire ${lock}: ${(error as Error).message}`);
      return 1;
    }
    try {
      // Written the way `json.dumps` writes it, because a reader elsewhere
      // parses this file rather than reading two fixed lines out of it.
      const started = new Date().toISOString().slice(0, 19);
      fs.writeSync(
        lockFd,
        `{"pid": ${process.pid}, "started_at": "${started}Z"}\n`,
      );
    } catch (error) {
      releaseLock(lockFd, lock);
      complain(`ERROR: cannot write ${lock}: ${(error as Error).message}`);
      return 1;
    }
  }
  try {
    return run(curated, output, checkOnly, asOf, redact);
  } finally {
    if (lockFd !== null) releaseLock(lockFd, lock);
  }
}
