#!/usr/bin/env bun
/**
 * Lint the compact, vendorable selfos Decision Log format.
 *
 * Entries on or before `--baseline` keep parsing-critical checks but are exempt
 * from word, reference, stale-waiver, and missing-rejected-clause checks.
 *
 * This file is deliberately a single dependency-free script so a consuming
 * repository can vendor it (for example as `scripts/check_decision_log.ts`) and
 * lint a fresh checkout offline, with no plugin installed and no network
 * access.
 *
 * It is a port of `check_decision_log.py`, which remains the implementation for
 * repositories without a JavaScript runtime. The two are held to identical
 * observable behaviour — arguments, diagnostics, their order, and exit codes —
 * by `scripts/differential/decision-log.ts` in this repository.
 *
 * Almost every awkward line below is a regular expression. Python's `\s`, `\w`
 * and `\d` are Unicode classes and JavaScript's are not: a JavaScript `\d` is
 * ten ASCII characters, a Python one is every decimal digit in Unicode, and a
 * log written in another script would lint differently under a literal
 * translation. The classes are therefore spelled out once, at the top, and the
 * patterns are built from them.
 */

import fs from "node:fs";

export const CHECKER_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// The Python character classes these patterns are written in
// ---------------------------------------------------------------------------

/**
 * The characters `str.splitlines` breaks on.
 *
 * A vertical tab or a form feed starts a new line for Python and does not for
 * a JavaScript split on "\n", which would put two entries on one line and
 * report the second one's diagnostics against the first one's number.
 */
const BREAK = "\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]";

/** `str.splitlines()`: no trailing empty piece, and every break is a break. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  const finder = new RegExp(BREAK, "gu");
  let start = 0;
  for (let match = finder.exec(text); match !== null; match = finder.exec(text)) {
    lines.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * The characters Python calls whitespace — `\s`, `str.split()`, `str.strip()`.
 *
 * Wider than a JavaScript `\s` at the low end (the four information
 * separators) and narrower at the top (no byte-order mark), and both ends
 * decide whether a word is a word here.
 */
const SPACE =
  "\\t\\n\\v\\f\\r \\x1c\\x1d\\x1e\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** Python's `\s` and `\S`, as pattern fragments. */
const S = `[${SPACE}]`;
const NOT_S = `[^${SPACE}]`;

/**
 * Python's `\w`: alphanumeric by `str.isalnum`, plus the underscore.
 *
 * A JavaScript `\w` is `[A-Za-z0-9_]`, so a reference written next to a
 * Cyrillic letter would be a reference to the port and not to the oracle.
 */
const W = "[\\p{L}\\p{N}_]";

/** Python's `\d`: every decimal digit in Unicode, not the ten ASCII ones. */
const D = "\\p{Nd}";

const STRIP_RE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const SPLIT_RE = new RegExp(`[${SPACE}]+`, "u");

export const pyStrip = (text: string): string => text.replace(STRIP_RE, "");

/** `str.split()` with no argument: runs of whitespace, no empty pieces. */
export const pySplit = (text: string): string[] =>
  text.split(SPLIT_RE).filter((piece) => piece !== "");

/** `" ".join(text.split())`, which is how every compared text is normalised. */
const collapse = (text: string): string => pySplit(text).join(" ");

const SINGLE_SPACE_RE = new RegExp(`^${S}$`, "u");

/** `str.isspace()` for one character. */
const isSpace = (character: string): boolean => SINGLE_SPACE_RE.test(character);

/**
 * `str.casefold()`, for the characters that can fold into an ASCII heading.
 *
 * Only the title of a heading is compared, and only against "decision log", so
 * what matters is the folds that reach ASCII letters — `toLowerCase` leaves
 * those alone. The rest of the table cannot change the answer.
 */
const FOLDS: ReadonlyMap<string, string> = new Map([
  ["ſ", "s"],
  ["ẞ", "ss"],
  ["ß", "ss"],
  ["K", "k"],
]);

function casefold(text: string): string {
  let folded = "";
  for (const character of text) folded += FOLDS.get(character) ?? character;
  return folded.toLowerCase();
}

/**
 * Compare two strings by code point, the way Python compares `str`.
 *
 * JavaScript's `<` compares UTF-16 units, which orders an astral character
 * below U+E000 rather than above it — and the file names being sorted are
 * whatever a caller typed.
 */
export function comparePython(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    const one = (a[at] as string).codePointAt(0) as number;
    const other = (b[at] as string).codePointAt(0) as number;
    if (one !== other) return one < other ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

const ENTRY_RE = new RegExp(`^- (${D}{4}-${D}{2}-${D}{2}) — (.*)$`, "u");
const ATX_HEADING_RE = /^[ ]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const ATX_CLOSING_HASHES_RE = /[ \t]+#+[ \t]*$/u;
const FENCE_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/u;
const HTML_COMMENT_RE = /<!--.*?-->/gsu;
const MARKDOWN_LINK_START_RE = /(\[[^\]\n]*\])\(/gu;
const WAIVER_COMMENT_RE = /<!-- decision-log: allow-long(.*?)-->/gu;
const WAIVER_MARKER_RE = /<!-- decision-log: allow-long/gu;
const REJECTED_CANONICAL_RE = new RegExp(
  `(?<!${W})(?:Rejected:|Rejected alternative:|Rejected alternatives:)${S}+` +
    `(${NOT_S}(?:.*?${NOT_S})?)${S}+—${S}+` +
    `(${NOT_S}(?:.*?${NOT_S})?)\\.` +
    `(?=${S}|$)`,
  "u",
);
const REJECTED_BECAUSE_RE = new RegExp(
  `(?<!${W})Rejected${S}+` +
    `(${NOT_S}(?:.*?${NOT_S})?)${S}+because${S}+` +
    `(${NOT_S}(?:.*?${NOT_S})?)\\.` +
    `(?=${S}|$)`,
  "u",
);
const REFERENCE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_#])(?:PR${S}+#${D}+|#${D}+|GH-${D}+)(?!${W})` +
    `|(?<!${W})[0-9A-Fa-f]{7,40}(?!${W})`,
  "iu",
);
const SENTENCE_END_RE = new RegExp(`[.!?]+(?=${S}|$)`, "gu");
const DATE_TEXT_RE = new RegExp(`^${D}{4}-${D}{2}-${D}{2}$`, "u");

interface Diagnostic {
  readonly severity: "ERROR" | "WARNING";
  readonly filename: string;
  readonly line: number;
  readonly message: string;
}

interface EntryPart {
  readonly line: number;
  readonly text: string;
  readonly first: boolean;
}

interface Entry {
  readonly line: number;
  readonly dateText: string;
  readonly parts: readonly EntryPart[];
}

interface WaiverResult {
  readonly valid: boolean;
  readonly line: number | null;
  readonly diagnostics: readonly (readonly [number, string])[];
}

/** How many days each month has, in a year that is not a leap year. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * An exact YYYY-MM-DD date, or null when there is none.
 *
 * The date is kept as its own text: it is fixed width and ASCII by the time it
 * is stored, so comparing two of them as strings is comparing two dates. What
 * the regexp admits is wider than what `date.fromisoformat` parses — the
 * pattern's `\d` is every Unicode digit and the parser wants ASCII — so the
 * digits are checked again here.
 */
export function parseIsoDate(value: string): string | null {
  if (!DATE_TEXT_RE.test(value)) return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const length = (MONTH_LENGTHS[month - 1] as number) + (month === 2 && leap ? 1 : 0);
  if (day < 1 || day > length) return null;
  return value;
}

/** The ATX heading a line is, as [level, title], or null. */
export function headingAt(line: string): [number, string] | null {
  const match = ATX_HEADING_RE.exec(line);
  if (match === null) return null;
  const title = pyStrip((match[2] ?? "").replace(ATX_CLOSING_HASHES_RE, ""));
  return [(match[1] as string).length, title];
}

/** Zero-based [line, level, title] ATX headings outside fenced code. */
export function markdownHeadings(lines: readonly string[]): [number, number, string][] {
  const headings: [number, number, string][] = [];
  let fenceCharacter: string | null = null;
  let fenceLength = 0;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceCharacter === null) {
      if (fenceMatch !== null) {
        const fence = fenceMatch[1] as string;
        const rest = fenceMatch[2] as string;
        // An info string may not carry a backtick when the fence is backticks,
        // so ```a`b is not a fence at all and may still be a heading.
        if (!(fence.startsWith("`") && rest.includes("`"))) {
          fenceCharacter = fence[0] as string;
          fenceLength = fence.length;
          continue;
        }
      }
    } else {
      if (fenceMatch !== null) {
        const fence = fenceMatch[1] as string;
        const rest = fenceMatch[2] as string;
        if (
          fence.startsWith(fenceCharacter) &&
          fence.length >= fenceLength &&
          pyStrip(rest) === ""
        ) {
          fenceCharacter = null;
          fenceLength = 0;
        }
      }
      continue;
    }

    const heading = headingAt(line);
    if (heading !== null) headings.push([index, heading[0], heading[1]]);
  }

  return headings;
}

export function mergeRegions(
  regions: readonly (readonly [number, number])[],
): [number, number][] {
  const merged: [number, number][] = [];
  const sorted = [...regions].sort((one, other) =>
    one[0] !== other[0] ? one[0] - other[0] : one[1] - other[1],
  );
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The half-open line ranges that hold decision entries. */
export function decisionLogRegions(lines: readonly string[]): [number, number][] {
  const headings = markdownHeadings(lines);
  const targets = headings.filter((heading) => casefold(heading[2]) === "decision log");
  // A file with no such heading is a decision log from end to end.
  if (targets.length === 0) return [[0, lines.length]];

  const regions: [number, number][] = [];
  for (const [targetLine, targetLevel] of targets) {
    let end = lines.length;
    for (const [headingLine, headingLevel] of headings) {
      if (headingLine > targetLine && headingLevel <= targetLevel) {
        end = headingLine;
        break;
      }
    }
    regions.push([targetLine + 1, end]);
  }
  return mergeRegions(regions);
}

const diagnostic = (
  severity: "ERROR" | "WARNING",
  filename: string,
  line: number,
  message: string,
): Diagnostic => ({ severity, filename, line, message });

export function parseRegion(
  lines: readonly string[],
  start: number,
  end: number,
  filename: string,
): [Entry[], Diagnostic[]] {
  const entries: Entry[] = [];
  const diagnostics: Diagnostic[] = [];
  let currentLine: number | null = null;
  let currentDate = "";
  let currentParts: EntryPart[] = [];

  const finish = (): void => {
    if (currentLine !== null) {
      entries.push({ line: currentLine, dateText: currentDate, parts: currentParts });
    }
    currentLine = null;
    currentDate = "";
    currentParts = [];
  };

  for (let index = start; index < end; index += 1) {
    const raw = lines[index] as string;
    const lineNumber = index + 1;
    if (pyStrip(raw) === "") continue;

    const entryMatch = ENTRY_RE.exec(raw);
    if (entryMatch !== null) {
      finish();
      currentLine = lineNumber;
      currentDate = entryMatch[1] as string;
      currentParts = [{ line: lineNumber, text: entryMatch[2] as string, first: true }];
      continue;
    }

    // A continuation is exactly two spaces and then something that is not
    // itself a list item or a heading; three spaces or a tab is ambiguous.
    const exactlyTwoSpaces =
      raw.startsWith("  ") && raw.length > 2 && !isSpace(raw[2] as string);
    const indentedEntry = exactlyTwoSpaces && raw.slice(2).startsWith("- ");
    const markdownHeading = headingAt(raw) !== null;
    if (exactlyTwoSpaces && currentLine !== null && !indentedEntry && !markdownHeading) {
      currentParts.push({ line: lineNumber, text: raw.slice(2), first: false });
      continue;
    }

    finish();
    const message = raw.startsWith("-")
      ? "entry does not begin with '- YYYY-MM-DD — '"
      : "malformed continuation indentation or multi-entry ambiguity";
    diagnostics.push(diagnostic("ERROR", filename, lineNumber, message));
  }

  finish();
  return [entries, diagnostics];
}

const entrySourceText = (entry: Entry): string =>
  entry.parts.map((part) => part.text).join(" ");

/** Remove balanced inline-link targets while preserving their labels. */
export function stripMarkdownLinkTargets(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    MARKDOWN_LINK_START_RE.lastIndex = cursor;
    const match = MARKDOWN_LINK_START_RE.exec(text);
    if (match === null) {
      pieces.push(text.slice(cursor));
      break;
    }

    pieces.push(text.slice(cursor, match.index));
    pieces.push(match[1] as string);
    let index = match.index + match[0].length;
    let depth = 1;
    let closed = false;
    while (index < text.length) {
      const character = text[index] as string;
      // A backslash escapes whatever follows it, parenthesis included.
      if (character === "\\" && index + 1 < text.length) {
        index += 2;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          cursor = index + 1;
          closed = true;
          break;
        }
      }
      index += 1;
    }
    // An unbalanced target is not a link: the text from its opening
    // parenthesis onwards is kept as it stands.
    if (!closed) {
      pieces.push(text.slice(match.index + match[0].length - 1));
      break;
    }
  }

  return pieces.join("");
}

const commentStrippedEntryText = (entry: Entry): string =>
  collapse(entrySourceText(entry).replace(HTML_COMMENT_RE, " "));

const visibleEntryText = (entry: Entry): string =>
  collapse(stripMarkdownLinkTargets(commentStrippedEntryText(entry)));

/** The dated line's own text: the grammar requires it there, not merely near. */
const visibleFirstLineText = (entry: Entry): string =>
  collapse(
    stripMarkdownLinkTargets((entry.parts[0] as EntryPart).text.replace(HTML_COMMENT_RE, " ")),
  );

const wordCount = (entry: Entry): number => pySplit(visibleEntryText(entry)).length;

/** Where a rejected-alternative clause ends, or null when there is none. */
export function findRejectedClause(text: string): number | null {
  const canonical = REJECTED_CANONICAL_RE.exec(text);
  const because = REJECTED_BECAUSE_RE.exec(text);
  if (canonical === null && because === null) return null;
  if (canonical === null) return (because as RegExpExecArray).index + (because as RegExpExecArray)[0].length;
  if (because === null) return canonical.index + canonical[0].length;
  // `min` keeps the first of two equal keys, and the canonical form is first.
  const winner = because.index < canonical.index ? because : canonical;
  return winner.index + winner[0].length;
}

/** Every match of a global pattern, rewound so the pattern stays reusable. */
function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push(match);
    if (match[0] === "") pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return found;
}

export function waiverResult(entry: Entry): WaiverResult {
  const validLines: number[] = [];
  const diagnostics: [number, string][] = [];
  const exactSyntax = "allow-long waiver must use the exact HTML comment syntax";

  for (const part of entry.parts) {
    const commentSpans = new Set(
      allMatches(HTML_COMMENT_RE, part.text).map(
        (match) => `${match.index}:${match.index + match[0].length}`,
      ),
    );
    const comments = allMatches(WAIVER_COMMENT_RE, part.text);
    const markerStarts = allMatches(WAIVER_MARKER_RE, part.text).map((match) => match.index);
    const coveredStarts = new Set(comments.map((match) => match.index));
    for (const markerStart of markerStarts) {
      if (!coveredStarts.has(markerStart)) diagnostics.push([part.line, exactSyntax]);
    }

    for (const match of comments) {
      const end = match.index + match[0].length;
      // A waiver that is not itself a whole HTML comment is a waiver that
      // some other comment has swallowed.
      if (!commentSpans.has(`${match.index}:${end}`)) {
        diagnostics.push([part.line, exactSyntax]);
        continue;
      }
      const body = match[1] as string;
      const reason = body.startsWith(" — ") && body.endsWith(" ") ? body.slice(3, -1) : "";
      if (pyStrip(reason) === "") {
        diagnostics.push([part.line, "allow-long waiver requires a non-empty reason"]);
        continue;
      }
      if (reason !== pyStrip(reason)) {
        diagnostics.push([part.line, exactSyntax]);
        continue;
      }

      let placedCorrectly: boolean;
      if (part.first) {
        const separated = match.index === 0 || part.text[match.index - 1] === " ";
        placedCorrectly = separated && pyStrip(part.text.slice(end)) === "";
      } else {
        placedCorrectly = pyStrip(part.text) === match[0];
      }
      if (!placedCorrectly) {
        diagnostics.push([
          part.line,
          "allow-long waiver must be at the end of the first line or on its own continuation line",
        ]);
        continue;
      }
      validLines.push(part.line);
    }
  }

  for (const duplicateLine of validLines.slice(1)) {
    diagnostics.push([duplicateLine, "entry must not contain multiple allow-long waivers"]);
  }

  return {
    valid: validLines.length > 0,
    line: validLines.length > 0 ? (validLines[0] as number) : null,
    diagnostics,
  };
}

export function validateEntry(
  entry: Entry,
  filename: string,
  baseline: string | null,
  maxWords: bigint,
  warnWords: bigint,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const parsedDate = parseIsoDate(entry.dateText);
  if (parsedDate === null) {
    diagnostics.push(
      diagnostic("ERROR", filename, entry.line, `calendar-invalid date '${entry.dateText}'`),
    );
  }

  const isHistorical = baseline !== null && parsedDate !== null && parsedDate <= baseline;

  const text = visibleEntryText(entry);
  if (visibleFirstLineText(entry) === "") {
    diagnostics.push(
      diagnostic("ERROR", filename, entry.line, "empty decision text on the dated entry line"),
    );
  }

  const rejectedEnd = findRejectedClause(text);
  if (rejectedEnd === null && !isHistorical) {
    diagnostics.push(
      diagnostic(
        "ERROR",
        filename,
        entry.line,
        "missing explicit rejected-alternative-with-reason clause",
      ),
    );
  }

  const waiver = waiverResult(entry);
  for (const [line, message] of waiver.diagnostics) {
    diagnostics.push(diagnostic("ERROR", filename, line, message));
  }

  const count = BigInt(wordCount(entry));
  if (!isHistorical) {
    if (count > maxWords && !waiver.valid) {
      diagnostics.push(
        diagnostic(
          "ERROR",
          filename,
          entry.line,
          `entry has ${count} words, above the ${maxWords}-word ceiling, without an allow-long waiver`,
        ),
      );
    }
    if (count > warnWords) {
      diagnostics.push(
        diagnostic(
          "WARNING",
          filename,
          entry.line,
          `entry has ${count} words, above the ${warnWords}-word warning threshold; target is about 40 words`,
        ),
      );
    }
    if (waiver.valid && count <= warnWords) {
      diagnostics.push(
        diagnostic(
          "WARNING",
          filename,
          waiver.line === null || waiver.line === 0 ? entry.line : waiver.line,
          `stale allow-long waiver: entry has ${count} words at or below the ${warnWords}-word warning threshold`,
        ),
      );
    }
    if (!REFERENCE_RE.test(commentStrippedEntryText(entry))) {
      diagnostics.push(
        diagnostic(
          "WARNING",
          filename,
          entry.line,
          "no issue/PR/SHA reference; detailed argument belongs in the issue, the commit body, or the SDD § edit, not in the log",
        ),
      );
    }
  }

  if (rejectedEnd !== null) {
    const trailing = text.slice(rejectedEnd);
    if (allMatches(SENTENCE_END_RE, trailing).length > 2) {
      diagnostics.push(
        diagnostic(
          "WARNING",
          filename,
          entry.line,
          "paragraph-style duplication heuristic: more than two sentences follow the rejected-alternative clause",
        ),
      );
    }
  }

  return diagnostics;
}

export function lintText(
  text: string,
  filename: string,
  baseline: string | null,
  maxWords: bigint,
  warnWords: bigint,
): Diagnostic[] {
  const lines = splitLines(text);
  const diagnostics: Diagnostic[] = [];
  for (const [start, end] of decisionLogRegions(lines)) {
    const [entries, parseDiagnostics] = parseRegion(lines, start, end, filename);
    diagnostics.push(...parseDiagnostics);
    for (const entry of entries) {
      diagnostics.push(...validateEntry(entry, filename, baseline, maxWords, warnWords));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// The command line, in the shape argparse gives it
// ---------------------------------------------------------------------------

/** The width argparse lays a usage line out at when it cannot see a terminal. */
const TEXT_WIDTH = 78;

const OPTION_PARTS = ["[-h]", "[--baseline YYYY-MM-DD]", "[--max-words N]", "[--warn-words N]"];
const POSITIONAL_PARTS = ["FILE", "[FILE ...]"];

/** `HelpFormatter._format_usage`'s packer: parts onto lines of one width. */
function packLines(parts: readonly string[], indent: string, prefix?: string): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let length = (prefix ?? indent).length - 1;
  for (const part of parts) {
    if (length + 1 + part.length > TEXT_WIDTH && line.length > 0) {
      lines.push(indent + line.join(" "));
      line = [];
      length = indent.length - 1;
    }
    line.push(part);
    length += 1 + part.length;
  }
  if (line.length > 0) lines.push(indent + line.join(" "));
  if (prefix !== undefined && lines.length > 0) {
    lines[0] = (lines[0] as string).slice(indent.length);
  }
  return lines;
}

/**
 * The usage block, wrapped the way argparse wraps it.
 *
 * Not a fixed string: the program name is whatever a repository vendored this
 * script as, and it is on the first line — a longer name moves every wrap. The
 * usage block is printed with every usage error and not only with --help, so a
 * layout that only fitted one name would be wrong on most of them.
 */
const usage = (program: string): string => {
  const prefix = "usage: ";
  const parts = [...OPTION_PARTS, ...POSITIONAL_PARTS];
  const single = `${program} ${parts.join(" ")}`;
  if (prefix.length + single.length <= TEXT_WIDTH) return prefix + single;

  let lines: string[];
  if (prefix.length + program.length <= 0.75 * TEXT_WIDTH) {
    const indent = " ".repeat(prefix.length + program.length + 1);
    lines = packLines([program, ...OPTION_PARTS], indent, prefix);
    lines.push(...packLines(POSITIONAL_PARTS, indent));
  } else {
    const indent = " ".repeat(prefix.length);
    lines = packLines(parts, indent);
    if (lines.length > 1) {
      lines = packLines(OPTION_PARTS, indent);
      lines.push(...packLines(POSITIONAL_PARTS, indent));
    }
    lines = [program, ...lines];
  }
  return prefix + lines.join("\n");
};

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
  "Lint the compact, vendorable selfos Decision Log format. Entries on or before\n" +
  "``--baseline`` keep parsing-critical checks but are exempt from word,\n" +
  "reference, stale-waiver, and missing-rejected-clause checks.\n" +
  "\n" +
  "positional arguments:\n" +
  "  FILE\n" +
  "\n" +
  "options:\n" +
  "  -h, --help            show this help message and exit\n" +
  "  --baseline YYYY-MM-DD\n" +
  "                        exempt entries on or before this date from missing-\n" +
  "                        rejected-clause, threshold, stale-waiver, and\n" +
  "                        reference checks\n" +
  "  --max-words N         hard word ceiling (default: 80)\n" +
  "  --warn-words N        word warning threshold (default: 40)\n";

/** An argparse failure: a usage block, one error line, and status 2. */
class UsageError extends Error {
  readonly complaint: string;

  constructor(complaint: string) {
    super(complaint);
    this.complaint = complaint;
  }
}

interface Arguments {
  readonly files: readonly string[];
  readonly baseline: string | null;
  readonly maxWords: bigint;
  readonly warnWords: bigint;
}

/** Text argparse prints to stdout before exiting 0. */
interface Written {
  readonly stdout: string;
}

const INT_SPACE =
  "[\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const INT_STRIP = new RegExp(`^${INT_SPACE}+|${INT_SPACE}+$`, "gu");
const INT_RE = new RegExp(`^[+-]?(${D}(?:_?${D})*)$`, "u");

/**
 * The value of one decimal digit, in any script that writes them.
 *
 * `int()` reads every character Unicode gives a decimal value. Unicode encodes
 * each set of ten contiguously and in ascending order, so a digit's value is
 * its distance from the start of the run of digits it sits in — and the runs
 * that abut are whole sets end to end, hence the remainder.
 */
function decimalValue(digit: string): number {
  const isDigit = (code: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(code));
  const code = digit.codePointAt(0) as number;
  let start = code;
  while (start > 0 && isDigit(start - 1)) start -= 1;
  return (code - start) % 10;
}

/**
 * `int(value)`, or null when CPython would raise ValueError.
 *
 * The result is a bigint because Python's `int` is exact at every width: a
 * ceiling written past 2^53 would otherwise land on a neighbouring double and
 * decide a comparison the oracle decides the other way.
 */
export function pyInt(value: string): bigint | null {
  const text = value.replace(INT_STRIP, "");
  const match = INT_RE.exec(text);
  if (match === null) return null;
  const digits = [...(match[1] as string)]
    .filter((character) => character !== "_")
    .map((character) => decimalValue(character))
    .join("");
  return (text.startsWith("-") ? -1n : 1n) * BigInt(digits);
}

function positiveInteger(value: string, option: string): bigint {
  const parsed = pyInt(value);
  if (parsed === null || parsed <= 0n) {
    throw new UsageError(`argument ${option}: must be a positive integer`);
  }
  return parsed;
}

const OPTIONS = ["-h", "--help", "--baseline", "--max-words", "--warn-words"] as const;

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
 * Whether argparse would read this word as an option rather than a file name.
 *
 * There are no options here that look like negative numbers, so a word that
 * does is a path; so is a word with a space in it, and a lone dash.
 */
const looksLikeOption = (token: string): boolean =>
  token.startsWith("-") &&
  token !== "-" &&
  !NEGATIVE_NUMBER.test(token) &&
  !token.includes(" ");

/**
 * One argument as the parser reads it, before any of them is used.
 *
 * `sep` is how a value was attached to its option — through an `=` or through
 * nothing at all — and it is not bookkeeping: for an option that takes no
 * value it decides between printing help and refusing.
 */
interface Word {
  option: string | null;
  value: string | null;
  sep: "=" | "" | null;
  text: string;
  /**
   * The `--` that ends the options.
   *
   * It is a word in the pattern, not nothing: `FILE` may consume it along with
   * the names around it, and argparse then drops exactly one `--` from what it
   * consumed. A `--` the run never reaches is left over like any other stray
   * word, which is why `LOG --warn-words=4 --` is a refusal and `LOG --` is not.
   */
  separator: boolean;
}

export function parseArgs(argv: readonly string[], program: string): Arguments | Written {
  // `allow_abbrev=False`: a prefix of a long option is not that option, so
  // `--max` is an unrecognized argument and not a shorter `--max-words`.
  const words: Word[] = [];
  let separated = false;
  for (const argument of argv) {
    if (separated) {
      words.push({ option: null, value: null, sep: null, text: argument, separator: false });
      continue;
    }
    if (argument === "--") {
      separated = true;
      words.push({ option: null, value: null, sep: null, text: argument, separator: true });
      continue;
    }
    if ((OPTIONS as readonly string[]).includes(argument)) {
      words.push({ option: argument, value: null, sep: null, text: argument, separator: false });
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (equals > 0 && (OPTIONS as readonly string[]).includes(name)) {
      words.push({
        option: name,
        value: argument.slice(equals + 1),
        sep: "=",
        text: argument,
        separator: false,
      });
      continue;
    }
    // A one-dash word carries its value in the same word. Turning off
    // abbreviation does not turn this off: it is the short-option rule, not
    // the prefix rule, and it is why `-hx` is `-h` followed by an `x`.
    const head = argument.slice(0, 2);
    if (
      argument.startsWith("-") &&
      !argument.startsWith("--") &&
      argument.length > 2 &&
      (OPTIONS as readonly string[]).includes(head)
    ) {
      words.push({
        option: head,
        value: argument.slice(2),
        sep: "",
        text: argument,
        separator: false,
      });
      continue;
    }
    words.push({
      option: looksLikeOption(argument) ? "" : null,
      value: null,
      sep: null,
      text: argument,
      separator: false,
    });
  }

  const files: string[] = [];
  const extras: string[] = [];
  // `nargs="+"` takes one run of file names. Any option ends that run, so a
  // name after a later option has no action left to hold it.
  let filled = false;
  let baseline: string | null = null;
  let maxWords = 80n;
  let warnWords = 40n;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as Word;
    if (word.separator) {
      // Inside the run of names it is the one `--` argparse drops; past the
      // run there is no positional left to drop it, so it is unrecognized.
      if (filled) extras.push(word.text);
      continue;
    }
    if (word.option === null) {
      if (filled) extras.push(word.text);
      else files.push(word.text);
      continue;
    }
    if (files.length > 0) filled = true;
    if (word.option === "") {
      extras.push(word.text);
      continue;
    }
    if (word.option === "-h" || word.option === "--help") {
      // Help takes no value, so a value attached to it is refused — except in
      // the one shape that is not a value at all: a one-dash spelling whose
      // tail is more short options, written with nothing between them and not
      // opening with a dash of its own. `-hx` is `-h -x`, and help fires
      // before the tail is looked at; `-h=x`, `-h-x` and `-h=` are refusals.
      const tail =
        word.value !== null &&
        word.value !== "" &&
        !word.option.startsWith("--") &&
        word.sep === "" &&
        !word.value.startsWith("-");
      if (word.value !== null && !tail) {
        throw new UsageError(
          `argument -h/--help: ignored explicit argument ${pythonRepr(word.value)}`,
        );
      }
      return { stdout: helpText(program) };
    }
    let value = word.value;
    if (value === null) {
      const next = words[index + 1];
      // An option-looking word is not a value, so the option is left with
      // nothing rather than served the next option as its argument. Neither is
      // `--`: an option's pattern has no room for one, so `--max-words --` is
      // a missing value and not a value spelled `--`.
      if (next === undefined || next.option !== null || next.separator) {
        throw new UsageError(`argument ${word.option}: expected one argument`);
      }
      value = next.text;
      index += 1;
    }
    if (word.option === "--baseline") {
      const parsed = parseIsoDate(value);
      if (parsed === null) {
        throw new UsageError("argument --baseline: must be a calendar-valid YYYY-MM-DD date");
      }
      baseline = parsed;
    } else if (word.option === "--max-words") {
      maxWords = positiveInteger(value, "--max-words");
    } else {
      warnWords = positiveInteger(value, "--warn-words");
    }
  }

  if (files.length === 0) {
    throw new UsageError("the following arguments are required: FILE");
  }
  if (extras.length > 0) {
    throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  }
  if (warnWords >= maxWords) {
    throw new UsageError("--warn-words must be lower than --max-words");
  }
  return { files, baseline, maxWords, warnWords };
}

/**
 * Everything `Py_UNICODE_ISPRINTABLE` calls unprintable: the separator and
 * "other" categories. ASCII space is the exception it carves out, and it
 * cannot reach this set anyway because the ASCII range is decided first.
 *
 * This is the one place either side reads Unicode from its own tables rather
 * than from a rule, so a code point assigned in one release and not the other
 * would be rendered differently. The differential corpus pins the characters
 * that matter.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * `repr()` of a str, for the messages that show a name back to its author.
 *
 * A path is not always something that can be printed — it is whatever a caller
 * typed — and CPython escapes what it cannot print rather than emitting it.
 * Quoting follows the same rule: apostrophes normally, double quotes when the
 * value has an apostrophe of its own and no double quote to collide with.
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

/** `str(PurePosixPath(raw))`, which is the path an OSError names. */
export function pyPath(raw: string): string {
  if (raw === "") return ".";
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

/** CPython's `str(OSError)`, which is `[Errno N] strerror: 'path'`. */
function osErrorText(error: unknown, file: string): string {
  const failure = error as NodeJS.ErrnoException;
  const known = ERRNO.get(failure.code ?? "");
  const number = known?.[0] ?? (typeof failure.errno === "number" ? Math.abs(failure.errno) : 0);
  // `OSError.__str__` formats the filename with `%R`, so the path inside the
  // message is quoted and escaped by the same rules as the message around it.
  return `[Errno ${number}] ${known?.[1] ?? failure.message}: ${pythonRepr(pyPath(file))}`;
}

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
    if (lead < 0xc2 || lead > 0xf4) return complaint(at, "invalid start byte");
    const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
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

/** `Path(file).read_text(encoding="utf-8")`, translation included. */
function readText(file: string): string {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(pyPath(file));
  } catch (error) {
    throw new UsageError(`cannot read ${pythonRepr(file)}: ${osErrorText(error, file)}`);
  }
  const bad = firstDecodeError(raw);
  if (bad !== null) throw new UsageError(`cannot read ${pythonRepr(file)}: ${bad}`);
  return raw.toString("utf8").replace(/\r\n|\r/gu, "\n");
}

interface Sink {
  write(text: string): void;
}

export interface Streams {
  readonly out: Sink;
  readonly err: Sink;
}

export function main(argv: readonly string[], program: string, streams: Streams): number {
  const diagnostics: Diagnostic[] = [];
  try {
    const parsed = parseArgs(argv, program);
    if ("stdout" in parsed) {
      streams.out.write(parsed.stdout);
      return 0;
    }
    for (const filename of [...parsed.files].sort(comparePython)) {
      const text = readText(filename);
      diagnostics.push(
        ...lintText(text, filename, parsed.baseline, parsed.maxWords, parsed.warnWords),
      );
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    streams.err.write(`${usage(program)}\n${program}: error: ${error.complaint}\n`);
    return 2;
  }

  const ordered = [...diagnostics].sort((one, other) => {
    const byFile = comparePython(one.filename, other.filename);
    if (byFile !== 0) return byFile;
    if (one.line !== other.line) return one.line - other.line;
    const severity = (item: Diagnostic): number => (item.severity === "ERROR" ? 0 : 1);
    if (severity(one) !== severity(other)) return severity(one) - severity(other);
    return comparePython(one.message, other.message);
  });
  for (const item of ordered) {
    streams.err.write(`${item.severity}: ${item.filename}:${item.line}: ${item.message}\n`);
  }
  return ordered.some((item) => item.severity === "ERROR") ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), baseName(pyPath(process.argv[1] ?? "")), {
    out: { write: (text) => void process.stdout.write(text) },
    err: { write: (text) => void process.stderr.write(text) },
  });
}
