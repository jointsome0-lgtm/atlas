// The public Git-layer boundary for this repository.
//
// The policy is canonical at
// https://github.com/jointsome0-lgtm/selfos/blob/main/docs/hygiene.md. This
// check rejects known private-data paths, requires the matching .gitignore
// rules, and requires the Vera Example marker in demo fixtures. If a legitimate
// public file matches a private-data pattern, add a narrow allowlist entry in
// the same change that adds the file.
//
// What is asked of git is asked of git: this reads the index and the untracked
// set through `git ls-files`, and a staged blob through `git show`, rather than
// deciding for itself what the public layer holds.
//
// Ported from scripts/check_public_hygiene.py.

import fs from "node:fs";

import { compareCodePoint } from "./ordering.ts";

const REQUIRED_GITIGNORE_PATTERNS: ReadonlySet<string> = new Set([
  "atlas/",
  "data/",
  "state/",
  "intake/",
  "graph/",
  "plans/",
  "runs/",
  "secrets/",
  "*.sqlite*",
  "*.db*",
  "*.jsonl",
  ".env",
  ".env.*",
  "engine.pin",
  "copies-manifest",
  "delivery-registry",
  ".claude/",
  ".codex/",
  ".agents/",
]);

// Directory names denied at any depth, matching gitignore's slash-free
// directory semantics ("state/" matches nested state/).
const DENIED_DIR_NAMES: ReadonlySet<string> = new Set([
  "atlas",
  "data",
  "state",
  "intake",
  "graph",
  "plans",
  "runs",
  "secrets",
  ".claude",
  ".codex",
  ".agents",
]);

// File patterns denied at any depth, matched against the basename —
// "*.sqlite*" also covers -journal/-shm/-wal sidecars.
const DENIED_BASENAME_PATTERNS = [
  "*.sqlite*",
  "*.db*",
  "*.jsonl",
  ".env",
  ".env.*",
  "engine.pin",
  "copies-manifest",
  "delivery-registry",
] as const;

const FIXTURE_PATH_PATTERNS = ["fixtures/**"] as const;

const DENIED_PATH_ALLOWLIST: ReadonlySet<string> = new Set([
  // Invented, marked public acceptance fixture for deterministic intake.
  "fixtures/intake/vera-example-batch.json",
]);

/** The marker every published fixture carries, compared as bytes. */
const MARKER = "Vera Example";

// ---------------------------------------------------------------------------
// The two borrowed vocabularies: shell globs, and how Python cuts a line
// ---------------------------------------------------------------------------

/**
 * `fnmatch.fnmatchcase`: a shell glob over a whole string, case kept.
 *
 * Not a path glob. `*` crosses `/` like any other character, which is what
 * makes `fixtures/**` mean "anything under fixtures" and `*.jsonl` mean
 * "anything ending in .jsonl" wherever it is applied.
 */
function fnmatchcase(name: string, pattern: string): boolean {
  return translate(pattern).test(name);
}

const translated = new Map<string, RegExp>();

function translate(pattern: string): RegExp {
  const known = translated.get(pattern);
  if (known !== undefined) return known;

  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] as string;
    index += 1;
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if (character === "[") {
      // The set ends at the first `]` that is not the first character of the
      // set, so `[]]` is a set holding one bracket. A set that never closes is
      // not a set: the `[` stands for itself.
      let end = index;
      if (pattern[end] === "!") end += 1;
      if (pattern[end] === "]") end += 1;
      while (end < pattern.length && pattern[end] !== "]") end += 1;
      if (end >= pattern.length) source += "\\[";
      else {
        const inside = pattern.slice(index, end).replaceAll("\\", "\\\\");
        index = end + 1;
        source += `[${inside.startsWith("!") ? `^${inside.slice(1)}` : inside}]`;
      }
    } else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // `s` so that `*` reaches a newline, as a glob over bytes does; `u` so the
  // string is walked in code points.
  const expression = new RegExp(`^(?:${source})$`, "su");
  translated.set(pattern, expression);
  return expression;
}

const matchesAny = (name: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => fnmatchcase(name, pattern));

/**
 * Where `str.splitlines` cuts, which is at more than a newline.
 *
 * Git ends a line at `\n` and nothing else, so a `.gitignore` carrying a
 * vertical tab is read as one pattern by git and as two lines here. That is
 * the oracle's reading and it errs towards refusing: a pattern that only looks
 * required after the cut is not counted as present.
 */
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;

/** Python's `str.isspace`, the set `str.rstrip()` takes off an end. */
const TRAILING_SPACE =
  /[ \t\n\r\f\v\x1c-\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;

function splitLines(text: string): string[] {
  // A non-global pattern still splits at every match it finds.
  const lines = text.split(LINE_BREAKS);
  // A trailing break ends the last line rather than opening an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// What the public layer holds
// ---------------------------------------------------------------------------

/** A run of git that failed, carrying the one-line detail a caller reports. */
class GitError extends Error {}

/**
 * Run git in the repository and hand back what it wrote to stdout.
 *
 * git's own stderr is left alone, exactly as the oracle leaves it: a `fatal:`
 * line from git goes straight to the caller's stderr, unwrapped and unprefixed,
 * and the message built here is only the summary that follows it.
 */
function git(root: string, ...args: string[]): Buffer {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "inherit" });
  if (run.exitCode !== 0) {
    throw new GitError(`git ${args.join(" ")} exited ${run.exitCode}`);
  }
  return Buffer.from(run.stdout);
}

/**
 * One path git reported, and whether the name survived being read.
 *
 * A path is bytes, and git will hand back bytes that are not UTF-8. Decoding
 * those loses the name: every invalid byte becomes U+FFFD, so two different
 * files can arrive under one name, and asking git for that name gets the
 * *other* file's content. An unmarked fixture hiding behind its decodable twin
 * would leave the check saying nothing is wrong (§24.2, #138).
 */
interface Listed {
  readonly path: string;
  /** False when the decoded name is not the name on disk. */
  readonly exact: boolean;
}

/**
 * The paths one `git ls-files` reports.
 *
 * `-z` because a path is bytes and may hold anything but a NUL, newlines
 * included, and git quotes such a path when it is not asked for NUL endings.
 */
function gitPaths(root: string, ...args: string[]): Listed[] {
  const raw = git(root, "ls-files", "-z", ...args);
  const listed: Listed[] = [];
  let start = 0;
  for (let at = 0; at <= raw.length; at += 1) {
    if (at !== raw.length && raw[at] !== 0) continue;
    if (at > start) {
      const bytes = raw.subarray(start, at);
      const path = bytes.toString("utf8");
      // The decode is exact when it is reversible; a lossy one is caught here
      // rather than at the point where it would read the wrong file.
      listed.push({ path, exact: Buffer.from(path, "utf8").equals(bytes) });
    }
    start = at + 1;
  }
  return listed;
}

/**
 * What the public Git layer would publish for this path.
 *
 * For a cached path that is the staged blob, not the working tree — an
 * unstaged edit must not mask what a commit would publish (an unmarked staged
 * fixture, a staged .gitignore losing a pattern).
 */
function publishedContent(root: string, path: string, cached: ReadonlySet<string>): Buffer {
  if (cached.has(path)) return git(root, "show", `:${path}`);
  return fs.readFileSync(`${root}/${path}`);
}

/**
 * The published .gitignore, measured against the patterns it must carry.
 *
 * Lines are taken verbatim (a trailing trim only): git treats a leading space
 * literally, so an indented " data/" must not count as "data/". A negation
 * re-including a required pattern is an error too.
 */
function checkGitignore(root: string, cached: ReadonlySet<string>): string[] {
  if (!cached.has(".gitignore")) return [".gitignore must be tracked in the index"];

  const text = publishedContent(root, ".gitignore", cached).toString("utf8");
  const lines = splitLines(text).map((line) => line.replace(TRAILING_SPACE, ""));
  const patterns = new Set(lines.filter((line) => line !== "" && !line.startsWith("#")));

  const missing = [...REQUIRED_GITIGNORE_PATTERNS].filter(
    (pattern) => !patterns.has(pattern),
  );
  const errors = missing
    .sort(compareCodePoint)
    .map((pattern) => `.gitignore missing required pattern: ${pattern}`);
  for (const line of lines) {
    if (line.startsWith("!") && REQUIRED_GITIGNORE_PATTERNS.has(line.slice(1))) {
      errors.push(`.gitignore negates required pattern: ${line}`);
    }
  }
  return errors;
}

export interface Sinks {
  readonly out: { write(text: string): void };
  readonly err: { write(text: string): void };
}

const oneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replaceAll("\n", " ");

export function checkHygiene(root: string, sinks: Sinks): number {
  const errors: string[] = [];

  const cached = new Set<string>();
  // Name to whether that name is the one on disk. Two paths can arrive under
  // one name; if either of them was read lossily the name is not trusted.
  const candidates = new Map<string, boolean>();
  try {
    for (const entry of gitPaths(root, "--cached")) {
      if (entry.exact) cached.add(entry.path);
      candidates.set(entry.path, (candidates.get(entry.path) ?? true) && entry.exact);
    }
    for (const entry of gitPaths(root, "--others", "--exclude-standard")) {
      candidates.set(entry.path, (candidates.get(entry.path) ?? true) && entry.exact);
    }
  } catch (error) {
    sinks.err.write(`FAIL: cannot inspect the public Git layer: ${oneLine(error)}\n`);
    return 1;
  }

  try {
    errors.push(...checkGitignore(root, cached));
  } catch (error) {
    sinks.err.write(`FAIL: cannot read .gitignore: ${oneLine(error)}\n`);
    return 1;
  }

  for (const path of [...candidates.keys()].sort(compareCodePoint)) {
    if (candidates.get(path) !== true) {
      // Refused rather than guessed at: under this name is a file whose real
      // name is something else, and every question below — is it denied, does
      // it carry the marker — would be answered about the wrong file.
      errors.push(`path is not UTF-8, so the file it names cannot be checked: ${path}`);
      continue;
    }
    // Every component counts, the last one included: a gitlink or directory
    // named like a denied root ("atlas") or a denied file pattern
    // (".env/token") is denied too. A legitimate exception goes through the
    // allowlist.
    const parts = path.split("/").filter((part) => part !== "");
    const denied = parts.some(
      (part) => DENIED_DIR_NAMES.has(part) || matchesAny(part, DENIED_BASENAME_PATTERNS),
    );
    if (denied && !DENIED_PATH_ALLOWLIST.has(path)) {
      errors.push(`denied path visible to the public Git layer: ${path}`);
    }

    if (matchesAny(path, FIXTURE_PATH_PATTERNS)) {
      let fixture: Buffer;
      try {
        fixture = publishedContent(root, path, cached);
      } catch (error) {
        errors.push(`cannot read fixture ${path}: ${oneLine(error)}`);
        continue;
      }
      if (!fixture.includes(MARKER)) {
        errors.push(`fixture lacks required marker '${MARKER}': ${path}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) sinks.err.write(`FAIL: ${error}\n`);
    return 1;
  }

  sinks.out.write("OK: public Git layer has no denied paths or unmarked demo fixtures\n");
  return 0;
}
