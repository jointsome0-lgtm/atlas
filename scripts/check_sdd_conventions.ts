#!/usr/bin/env bun
/**
 * Sync or check the shared SDD-conventions block in a consuming repository.
 *
 * The canonical template lives next to this script in the sdd plugin
 * (`../conventions/SDD-CONVENTIONS.md`). A consuming repository embeds the
 * template body in one of its Markdown files (typically `AGENTS.md` or
 * `SDD.md`) between two markers that record the template version and a sha256
 * of the block body:
 *
 *     <!-- BEGIN SDD-CONVENTIONS v1.0.0 sha256:<64 hex> -->
 *     ...template body...
 *     <!-- END SDD-CONVENTIONS -->
 *
 * `sync` inserts or refreshes the block and touches nothing outside the
 * markers. `check` always validates the local block offline (markers well
 * formed and unique, recorded sha256 matching the block body); when a template
 * is available — passed with --template, or found next to this script — it
 * also compares the block against the template and fails on a stale version or
 * a changed body.
 *
 * This file is deliberately a single dependency-free script so a consuming
 * repository can vendor it (for example as `scripts/check_sdd_conventions.ts`)
 * and validate a fresh checkout offline, with no plugin installed and no
 * network access.
 *
 * It is a port of `sync_conventions.py`, which remains the implementation for
 * repositories without a JavaScript runtime. The two are held to identical
 * observable behaviour — arguments, output text, exit codes and the bytes
 * written — by `scripts/differential/conventions.ts` in this repository. Where
 * the code below looks roundabout it is usually reproducing a CPython detail
 * that a JavaScript idiom would quietly get wrong; those places say so.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_VERSION = "1.0.1";

/** A failure to report on stderr before exiting with status 1. */
class ConventionsError extends Error {}

// ---------------------------------------------------------------------------
// The Python string and path operations this file depends on
// ---------------------------------------------------------------------------

/**
 * The characters `str.splitlines` breaks on, which are not the ones a
 * JavaScript split on "\n" would find.
 *
 * A vertical tab or a form feed inside a target file starts a new line for
 * Python and does not for JavaScript, which would shift every marker index
 * after it and splice the block into the wrong place.
 */
const BREAK = "\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]";

/** `str.splitlines()`: no trailing empty piece, and every break is a break. */
export function splitLines(text: string): string[] {
  return splitLinesKeepEnds(text).map((line) => line.replace(new RegExp(`(?:${BREAK})$`), ""));
}

/** `str.splitlines(keepends=True)`: the same pieces, each keeping its break. */
export function splitLinesKeepEnds(text: string): string[] {
  const kept: string[] = [];
  const finder = new RegExp(BREAK, "g");
  let start = 0;
  for (let match = finder.exec(text); match !== null; match = finder.exec(text)) {
    kept.push(text.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  if (start < text.length) kept.push(text.slice(start));
  return kept;
}

/**
 * The characters `str.strip()` removes when called with no argument.
 *
 * Python's whitespace is wider than a JavaScript `\s` at the low end (the four
 * information separators, one of which is not a line break but is a space);
 * matching it exactly is what keeps `not body.strip()` answering the same
 * question on both sides.
 */
const SPACE =
  "\\t\\n\\v\\f\\r \\x1c\\x1d\\x1e\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

export const pyStrip = (text: string): string => text.replace(STRIP_RE, "");

/** `str.strip("\n")`: newlines only, from both ends. */
const stripNewlines = (text: string): string => text.replace(/^\n+|\n+$/g, "");

/**
 * `str(PurePosixPath(raw))`, which is what every message here interpolates.
 *
 * The script takes its paths as `type=Path`, so argparse hands the commands an
 * already-normalised path and `check ./AGENTS.md` complains about `AGENTS.md`.
 * Passing the raw argument through instead would change the text of every
 * diagnostic for any caller who writes a leading `./` or a trailing slash —
 * which CI invocations routinely do.
 */
export function pyPath(raw: string): string {
  if (raw === "") return ".";
  // POSIX leaves exactly two leading slashes implementation-defined and
  // pathlib preserves them; three or more collapse to one.
  const root =
    raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return root === "" ? "." : root;
  return root + parts.join("/");
}

const baseName = (normalised: string): string => {
  const cut = normalised.lastIndexOf("/");
  return cut === -1 ? normalised : normalised.slice(cut + 1);
};

/** `PurePosixPath.parent`, which is "." for a bare name rather than "". */
const parentOf = (normalised: string): string => {
  const cut = normalised.lastIndexOf("/");
  if (cut === -1) return ".";
  if (cut === 0) return "/";
  return normalised.slice(0, cut);
};

const universalNewlines = (text: string): string => text.replace(/\r\n|\r/g, "\n");

const bodyDigest = (body: string): string =>
  crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");

// ---------------------------------------------------------------------------
// Reading, and what a failure to read is called
// ---------------------------------------------------------------------------

/**
 * Read a file as UTF-8, or fail with the message the caller's role deserves.
 *
 * `preserveNewlines` skips universal-newline translation: sync must splice a
 * CRLF/mixed-endings target byte-for-byte, or content outside the markers gets
 * rewritten on the way through read → write.
 */
function readText(file: string, role: string, preserveNewlines = false): string {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConventionsError(`${file}: ${role} does not exist`);
    }
    throw new ConventionsError(`${file}: cannot read UTF-8 ${role}: ${osErrorText(error, file)}`);
  }
  // A decode failure is a read failure of the same shape: CPython raises
  // UnicodeDecodeError out of the same `with` block, and this script reports
  // both under the one message.
  const bad = firstDecodeError(raw);
  if (bad !== null) throw new ConventionsError(`${file}: cannot read UTF-8 ${role}: ${bad}`);
  const text = raw.toString("utf8");
  return preserveNewlines ? text : universalNewlines(text);
}

/**
 * CPython's `str(OSError)`, which is `[Errno N] strerror: <repr of the path>`.
 *
 * The path is repr'd, not quoted: a name with an apostrophe in it comes back in
 * double quotes, and one with a control character comes back escaped.
 */
function osErrorText(error: unknown, file: string): string {
  const failure = error as NodeJS.ErrnoException;
  const known = ERRNO.get(failure.code ?? "");
  const number = known?.[0] ?? (typeof failure.errno === "number" ? Math.abs(failure.errno) : 0);
  return `[Errno ${number}] ${known?.[1] ?? failure.message}: ${pythonRepr(file)}`;
}

/** Linux errno numbers and `strerror` text for the failures a read can meet. */
const ERRNO: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["EACCES", [13, "Permission denied"]],
  ["EISDIR", [21, "Is a directory"]],
  ["ELOOP", [40, "Too many levels of symbolic links"]],
  ["EMFILE", [24, "Too many open files"]],
  ["ENAMETOOLONG", [36, "File name too long"]],
  ["ENOENT", [2, "No such file or directory"]],
  ["ENOTDIR", [20, "Not a directory"]],
  ["EPERM", [1, "Operation not permitted"]],
]);

/**
 * `str(UnicodeDecodeError)` for the first byte run that is not UTF-8, or null.
 *
 * Node's TextDecoder reports that a buffer is invalid but neither where nor
 * why, and the position is the useful half of the message to anyone repairing
 * a file.
 */
export function firstDecodeError(raw: Buffer): string | null {
  const complaint = (at: number, reason: string): string =>
    `'utf-8' codec can't decode byte 0x${(raw[at] as number).toString(16).padStart(2, "0")} ` +
    `in position ${at}: ${reason}`;

  // A sequence cut off by the end of the file is reported as the whole run of
  // bytes that survived, and only as a single byte when the run is one byte
  // long — so the plural form and the range are not cosmetic.
  const truncated = (start: number, end: number): string =>
    end === start
      ? complaint(start, "unexpected end of data")
      : `'utf-8' codec can't decode bytes in position ${start}-${end}: unexpected end of data`;

  for (let at = 0; at < raw.length; ) {
    const lead = raw[at] as number;
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    // Continuation bytes, and the two lead lengths UTF-8 retired, can never
    // open a sequence.
    if (lead < 0xc2 || lead > 0xf4) return complaint(at, "invalid start byte");
    const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    // The second byte carries the range restrictions that rule out both an
    // overlong encoding and a surrogate.
    const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    for (let step = 1; step < width; step += 1) {
      const next = raw[at + step];
      if (next === undefined) return truncated(at, raw.length - 1);
      const floor = step === 1 ? low : 0x80;
      const ceiling = step === 1 ? high : 0xbf;
      if (next < floor || next > ceiling) return complaint(at, "invalid continuation byte");
    }
    at += width;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The template and the block
// ---------------------------------------------------------------------------

const TEMPLATE_HEADER_RE = /^<!-- sdd-conventions-template v(\d+\.\d+\.\d+) -->$/;
const BEGIN_RE = /^<!-- BEGIN SDD-CONVENTIONS v(\d+\.\d+\.\d+) sha256:([0-9a-f]{64}) -->$/;
const BEGIN_PREFIX = "<!-- BEGIN SDD-CONVENTIONS";
const END_MARKER = "<!-- END SDD-CONVENTIONS -->";

/** Return [version, body] for the canonical template file. */
export function loadTemplate(file: string): [string, string] {
  const lines = splitLines(readText(file, "template"));
  if (lines.length === 0) throw new ConventionsError(`${file}: template is empty`);
  const header = TEMPLATE_HEADER_RE.exec(lines[0] as string);
  if (header === null) {
    throw new ConventionsError(
      `${file}:1: template must open with '<!-- sdd-conventions-template vX.Y.Z -->'`,
    );
  }
  const body = `${stripNewlines(lines.slice(1).join("\n"))}\n`;
  if (pyStrip(body) === "") throw new ConventionsError(`${file}: template body is empty`);
  for (const line of splitLines(body)) {
    if (line.startsWith(BEGIN_PREFIX) || pyStrip(line) === END_MARKER) {
      throw new ConventionsError(`${file}: template body must not contain the embed markers`);
    }
  }
  return [header[1] as string, body];
}

export function renderBlock(version: string, body: string): string {
  return `<!-- BEGIN SDD-CONVENTIONS v${version} sha256:${bodyDigest(body)} -->\n${body}${END_MARKER}\n`;
}

interface Block {
  readonly begin: number;
  readonly end: number;
  readonly version: string;
  readonly digest: string;
}

/** Locate the managed block, or say precisely how the file fails to hold one. */
export function findBlock(lines: readonly string[], where: string): Block {
  const begins: number[] = [];
  const ends: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith(BEGIN_PREFIX)) begins.push(index);
    if (pyStrip(line) === END_MARKER) ends.push(index);
  }
  if (begins.length > 1 || ends.length > 1) {
    throw new ConventionsError(`${where}: multiple SDD-CONVENTIONS markers; keep exactly one block`);
  }
  if (begins.length === 0 && ends.length === 0) {
    throw new ConventionsError(`${where}: no SDD-CONVENTIONS block found; run sync to insert it`);
  }
  if (begins.length === 0 || ends.length === 0 || (ends[0] as number) < (begins[0] as number)) {
    throw new ConventionsError(`${where}: SDD-CONVENTIONS markers are unpaired or out of order`);
  }
  const begin = begins[0] as number;
  const match = BEGIN_RE.exec(lines[begin] as string);
  if (match === null) {
    throw new ConventionsError(
      `${where}:${begin + 1}: malformed BEGIN marker; expected ` +
        `'<!-- BEGIN SDD-CONVENTIONS vX.Y.Z sha256:<64 hex> -->'`,
    );
  }
  return { begin, end: ends[0] as number, version: match[1] as string, digest: match[2] as string };
}

export function blockBody(lines: readonly string[], begin: number, end: number): string {
  if (end === begin + 1) return "";
  return `${lines.slice(begin + 1, end).join("\n")}\n`;
}

/**
 * Replace a file's contents without ever leaving a half-written one behind.
 *
 * The mode is carried over because a repository may have made its instruction
 * file executable or read-only, and a sync must not be the thing that changed
 * that.
 */
function writeAtomically(file: string, content: string): void {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : 0o644;
  const temporary = makeTemp(parentOf(file), `.${baseName(file)}.`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8" });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** `tempfile.mkstemp`: an exclusive create at mode 0600 under a random name. */
function makeTemp(directory: string, prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const noise = Array.from(
      crypto.randomBytes(8),
      (byte) => alphabet[byte % alphabet.length] as string,
    ).join("");
    const candidate = `${directory}/${prefix}${noise}`;
    try {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR;
      fs.closeSync(fs.openSync(candidate, flags, 0o600));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("No usable temporary file name found");
}

// ---------------------------------------------------------------------------
// The two commands
// ---------------------------------------------------------------------------

function commandSync(target: string, templatePath: string | null, out: Sink): number {
  if (templatePath === null) {
    throw new ConventionsError(
      "sync requires a template: pass --template pointing at a selfos-skills " +
        "checkout's skills/sdd-conventions/conventions/SDD-CONVENTIONS.md",
    );
  }
  const [version, body] = loadTemplate(templatePath);
  const block = renderBlock(version, body);

  if (!fs.existsSync(target)) {
    writeAtomically(target, block);
    out.write(`Created ${target} with conventions block v${version}.\n`);
    return 0;
  }

  const text = readText(target, "target", true);
  const lines = splitLines(text);
  const hasAnyMarker = lines.some(
    (line) => line.startsWith(BEGIN_PREFIX) || pyStrip(line) === END_MARKER,
  );
  let updated: string;
  if (!hasAnyMarker) {
    const prefix = text.endsWith("\n") ? text : `${text}\n`;
    updated = pyStrip(prefix) !== "" ? `${prefix}\n${block}` : block;
  } else {
    const { begin, end } = findBlock(lines, target);
    // Splice into the marker span only: keepends yields the same indices as
    // the plain split while keeping every line ending outside the block
    // exactly as it was on disk.
    const kept = splitLinesKeepEnds(text);
    updated = kept.slice(0, begin).join("") + block + kept.slice(end + 1).join("");
  }

  if (updated === text) {
    out.write(`${target} is already up to date (conventions block v${version}).\n`);
    return 0;
  }
  writeAtomically(target, updated);
  out.write(`Updated ${target} to conventions block v${version}.\n`);
  return 0;
}

function commandCheck(target: string, templatePath: string | null, out: Sink): number {
  const lines = splitLines(readText(target, "target"));
  const { begin, end, version, digest } = findBlock(lines, target);
  if (bodyDigest(blockBody(lines, begin, end)) !== digest) {
    throw new ConventionsError(
      `${target}:${begin + 1}: block body does not match its recorded sha256 — ` +
        "local edits inside the markers? rerun sync to regenerate the block",
    );
  }

  if (templatePath === null) {
    out.write(
      `OK: ${target}: conventions block v${version} intact (local check only; no template available).\n`,
    );
    return 0;
  }

  const [templateVersion, templateBody] = loadTemplate(templatePath);
  if (version !== templateVersion) {
    throw new ConventionsError(
      `${target}: conventions block v${version} is stale against template ` +
        `v${templateVersion}; rerun sync --template ${templatePath}`,
    );
  }
  if (digest !== bodyDigest(templateBody)) {
    throw new ConventionsError(
      `${templatePath}: template body changed without a version bump ` +
        `(both are v${version}); bump the template version`,
    );
  }
  out.write(`OK: ${target}: conventions block matches template v${templateVersion}.\n`);
  return 0;
}

/**
 * The template shipped beside this script, if this copy has one.
 *
 * Resolved through symlinks like `Path(__file__).resolve()`, so a script
 * reached through a symlinked bin directory still finds the conventions
 * directory of the checkout it actually lives in.
 */
function defaultTemplate(): string | null {
  try {
    const here = fs.realpathSync(fileURLToPath(import.meta.url));
    const candidate = `${parentOf(parentOf(here))}/conventions/SDD-CONVENTIONS.md`;
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The command line, in the shape argparse gives it
// ---------------------------------------------------------------------------

const COMMANDS = ["sync", "check"] as const;
type Command = (typeof COMMANDS)[number];

const usage = (program: string): string => `usage: ${program} [-h] [--version] {sync,check} ...`;
const subUsage = (program: string, command: string): string =>
  `usage: ${program} ${command} [-h] [--template TEMPLATE] target`;

/**
 * Help text at the width argparse falls back to when there is no terminal.
 *
 * argparse wraps to `COLUMNS`, or to 80 when it cannot see a terminal — which
 * is every CI job, every pipe and every test. That fallback is the one layout
 * reproduced here, so the port has a single help text rather than a
 * terminal-dependent one.
 */
const helpText = (program: string): string =>
  `${usage(program)}\n` +
  "\n" +
  "Sync or check the shared SDD-conventions block in a consuming repository.\n" +
  "\n" +
  "positional arguments:\n" +
  "  {sync,check}\n" +
  "    sync        insert or refresh the conventions block in TARGET\n" +
  "    check       validate the conventions block in TARGET\n" +
  "\n" +
  "options:\n" +
  "  -h, --help    show this help message and exit\n" +
  "  --version     show program's version number and exit\n";

const subHelpText = (program: string, command: string): string =>
  `${subUsage(program, command)}\n` +
  "\n" +
  "positional arguments:\n" +
  "  target\n" +
  "\n" +
  "options:\n" +
  "  -h, --help           show this help message and exit\n" +
  "  --template TEMPLATE  canonical SDD-CONVENTIONS.md (default: the copy shipped\n" +
  "                       next to this script, if present)\n";

/** An argparse failure: a usage line, one error line, and status 2. */
class UsageError extends Error {
  readonly usageLine: string;
  readonly speaker: string;
  readonly complaint: string;

  constructor(usageLine: string, speaker: string, complaint: string) {
    super(complaint);
    this.usageLine = usageLine;
    this.speaker = speaker;
    this.complaint = complaint;
  }
}

interface Parsed {
  readonly command: Command;
  readonly target: string;
  readonly template: string | null;
}

/** Text argparse prints to stdout before exiting 0. */
interface Written {
  readonly stdout: string;
}

/**
 * Resolve a long option the way argparse's `allow_abbrev` does.
 *
 * Any unambiguous prefix of a long option is that option, so `--temp` and even
 * `--t` reach `--template`. A caller with one of those in a script would
 * otherwise meet "unrecognized arguments" from the port alone.
 */
function longOption(token: string, known: readonly string[]): string | null {
  if (known.includes(token)) return token;
  if (!token.startsWith("--")) return null;
  const matches = known.filter((name) => name.startsWith(token));
  return matches.length === 1 ? (matches[0] as string) : null;
}

/**
 * argparse's `_negative_number_matcher`, spelled the way Python spells it.
 *
 * Its `\d` is every Unicode decimal digit, and its `$` also matches in front of
 * one trailing newline — so `-١٢` and `-1\n` are numbers here, while `-1.` is
 * not: the fraction branch needs a digit after the point, and the integer
 * branch admits no point at all.
 */
const NEGATIVE_NUMBER = /^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u;

/**
 * Whether argparse would read this word as an option rather than a value.
 *
 * No option here looks like a negative number, so a word that does is a value;
 * so is a lone dash, and so is any word with a space in it.
 */
const looksLikeOption = (token: string): boolean =>
  token.startsWith("-") &&
  token !== "-" &&
  !NEGATIVE_NUMBER.test(token) &&
  !token.includes(" ");

/** An option that takes no value, by every spelling that reaches it. */
interface Flag {
  readonly spellings: readonly string[];
  /** What a refusal calls it: every spelling, joined the way argparse joins. */
  readonly label: string;
}

const HELP: Flag = { spellings: ["-h", "--help"], label: "-h/--help" };
const VERSION: Flag = { spellings: ["--version"], label: "--version" };

/** A word that addresses a valueless option, and any value it drags along. */
interface Addressed {
  readonly flag: Flag;
  readonly value: string | null;
  readonly short: boolean;
  readonly sep: "=" | "";
}

/**
 * Read a word that addresses one of these options, in argparse's order.
 *
 * An exact spelling first, then a spelling with `=value`, then a one-dash word
 * carrying its tail in the same characters, and only then an abbreviation. The
 * order is what makes `-h=x` a value and `-hx` a tail.
 */
function addressed(argument: string, flags: readonly Flag[]): Addressed | null {
  for (const flag of flags) {
    if (flag.spellings.includes(argument)) {
      return { flag, value: null, short: !argument.startsWith("--"), sep: "" };
    }
  }
  const equals = argument.indexOf("=");
  if (equals > 0) {
    const head = argument.slice(0, equals);
    for (const flag of flags) {
      if (longOption(head, flag.spellings) !== null) {
        return { flag, value: argument.slice(equals + 1), short: !head.startsWith("--"), sep: "=" };
      }
    }
  }
  if (argument.startsWith("-") && !argument.startsWith("--") && argument.length > 2) {
    const head = argument.slice(0, 2);
    for (const flag of flags) {
      if (flag.spellings.includes(head)) {
        return { flag, value: argument.slice(2), short: true, sep: "" };
      }
    }
  }
  for (const flag of flags) {
    if (longOption(argument, flag.spellings) !== null) {
      return { flag, value: null, short: false, sep: "" };
    }
  }
  return null;
}

/**
 * Refuse a value handed to an option that has no use for one.
 *
 * The exception is the shape that is not a value at all: a one-dash spelling
 * whose tail is more short options, written with nothing between them and not
 * opening with a dash of its own. `-hx` is `-h -x`, and help fires before the
 * tail is looked at; `-h=x`, `-h-x` and `-h=` are refusals.
 */
function refuseValue(word: Addressed, block: string, speaker: string): void {
  if (word.value === null) return;
  const tail = word.value !== "" && word.short && word.sep === "" && !word.value.startsWith("-");
  if (tail) return;
  throw new UsageError(
    block,
    speaker,
    `argument ${word.flag.label}: ignored explicit argument ${pythonRepr(word.value)}`,
  );
}

export function parseArgs(argv: readonly string[], program: string): Parsed | Written {
  const top = usage(program);
  let index = 0;
  const extras: string[] = [];
  // argparse resolves the top-level options before it has a subcommand, and
  // only these two exist there.
  for (; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    // `--` is never read as an option: the parser marks it and everything
    // after it as plain words before it looks at any of them. The subcommand
    // is handed the words from the `--` on and keeps the separator, so
    // `-- check x` asks for a command spelled `--` and is told there is no
    // such choice — but a trailing `--` names nothing at all, and the
    // subcommand is simply missing.
    if (argument === "--") {
      if (index === argv.length - 1) {
        throw new UsageError(top, program, "the following arguments are required: command");
      }
      break;
    }
    const word = addressed(argument, [HELP, VERSION]);
    if (word === null) {
      // An option the top level does not know is not fatal here: it waits with
      // the subparser's leftovers and is reported once parsing is over.
      if (!looksLikeOption(argument)) break;
      extras.push(argument);
      continue;
    }
    refuseValue(word, top, program);
    if (word.flag === HELP) return { stdout: helpText(program) };
    return { stdout: `sync_conventions ${SCRIPT_VERSION}\n` };
  }
  if (index >= argv.length) {
    throw new UsageError(top, program, "the following arguments are required: command");
  }
  const command = argv[index] as string;
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(
      top,
      program,
      `argument command: invalid choice: ${pythonRepr(command)} (choose from 'sync', 'check')`,
    );
  }
  index += 1;

  const sub = subUsage(program, command);
  const speaker = `${program} ${command}`;
  let target: string | null = null;
  let template: string | null = null;
  // Past the first `--` nothing is an option again — a later `--` is an
  // ordinary word — so the parser meets at most one of these in a run.
  let separated = false;
  /**
   * Place one run of words: everything between two options, or after the last.
   *
   * The single positional matches `-*A-*`, so it takes the first word of the
   * run together with a `--` directly on either side of it, and argparse then
   * drops one `--` from what it took. Everything else in the run is a leftover,
   * reported by the top-level parser once parsing has finished. A run the
   * positional has already been filled from is leftovers end to end.
   */
  const placeRun = (run: readonly (string | null)[]): void => {
    const words = run.map((word, at) => ({ word, at }));
    const first = words.find((entry) => entry.word !== null);
    if (target === null && first !== undefined) {
      target = first.word as string;
      const dropped =
        run[first.at - 1] === null ? first.at - 1 : run[first.at + 1] === null ? first.at + 1 : -1;
      for (const entry of words) {
        if (entry.at === first.at || entry.at === dropped) continue;
        extras.push(entry.word === null ? "--" : entry.word);
      }
      return;
    }
    for (const entry of words) extras.push(entry.word === null ? "--" : entry.word);
  };

  // `null` stands for the `--` itself: a word in the run that carries no name.
  let run: (string | null)[] = [];
  while (index < argv.length) {
    const argument = argv[index] as string;
    if (separated) {
      run.push(argument);
      index += 1;
      continue;
    }
    if (argument === "--") {
      separated = true;
      run.push(null);
      index += 1;
      continue;
    }
    const flag = addressed(argument, [HELP]);
    if (flag !== null) {
      refuseValue(flag, sub, speaker);
      return { stdout: subHelpText(program, command) };
    }
    const equals = argument.indexOf("=");
    const attached =
      equals > 0 && longOption(argument.slice(0, equals), ["--template"]) === "--template";
    const detached = !attached && longOption(argument, ["--template"]) === "--template";
    if (attached || detached || looksLikeOption(argument)) {
      placeRun(run);
      run = [];
    }
    if (attached) {
      template = argument.slice(equals + 1);
      index += 1;
      continue;
    }
    if (detached) {
      const value = argv[index + 1];
      // argparse refuses to swallow the next token as a value when it looks
      // like an option, and `--` is not a value either: an option's pattern
      // has no room for one. So `--template --foo` is a missing value.
      if (value === undefined || value === "--" || looksLikeOption(value)) {
        throw new UsageError(sub, speaker, "argument --template: expected one argument");
      }
      template = value;
      index += 2;
      continue;
    }
    // Whatever the subparser cannot place becomes an extra, in the order the
    // words were written.
    if (looksLikeOption(argument)) extras.push(argument);
    else run.push(argument);
    index += 1;
  }
  placeRun(run);
  if (target === null) {
    throw new UsageError(sub, speaker, "the following arguments are required: target");
  }
  if (extras.length > 0) {
    throw new UsageError(top, program, `unrecognized arguments: ${extras.join(" ")}`);
  }
  return { command: command as Command, target: pyPath(target), template };
}

/**
 * Everything `Py_UNICODE_ISPRINTABLE` calls unprintable: the separator and
 * "other" categories. ASCII space is the exception it carves out, and it
 * cannot reach this set anyway because the ASCII range is decided first.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * `repr()` of a str, for the messages that show an argument back to its author.
 *
 * An argument is whatever a caller typed, so it is not always something that
 * can be printed; CPython escapes what it cannot print rather than emitting it,
 * which is also what keeps a newline out of the middle of a diagnostic.
 */
export function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === quote || character === "\\") out += `\\${character}`;
    else if (character === "\t") out += "\\t";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x7f) out += character;
    else if (!UNPRINTABLE.test(character)) out += character;
    else if (code < 0x100) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

interface Sink {
  write(text: string): void;
}

export interface Streams {
  readonly out: Sink;
  readonly err: Sink;
}

export function main(argv: readonly string[], program: string, streams: Streams): number {
  let parsed: Parsed | Written;
  try {
    parsed = parseArgs(argv, program);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    streams.err.write(`${error.usageLine}\n${error.speaker}: error: ${error.complaint}\n`);
    return 2;
  }
  if ("stdout" in parsed) {
    streams.out.write(parsed.stdout);
    return 0;
  }

  try {
    const templatePath = parsed.template === null ? defaultTemplate() : pyPath(parsed.template);
    return parsed.command === "sync"
      ? commandSync(parsed.target, templatePath, streams.out)
      : commandCheck(parsed.target, templatePath, streams.out);
  } catch (error) {
    if (!(error instanceof ConventionsError)) throw error;
    streams.err.write(`ERROR: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), baseName(pyPath(process.argv[1] ?? "")), {
    out: { write: (text) => void process.stdout.write(text) },
    err: { write: (text) => void process.stderr.write(text) },
  });
}
