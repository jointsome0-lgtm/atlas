// Shared, lane-neutral I/O primitives for Atlas instance writers.
//
// Callers supply an explicit instance root and every acceptance ceiling. This
// module owns filesystem containment, schema checks, the single-writer lock,
// strict durable JSONL appends, and content-free receipt bookkeeping. It does
// not discover instances, choose business paths, or interpret record content.
//
// Ported from scripts/atlas_io.py. Every path-taking operation reaches the
// filesystem through the §25.8 boundary (posix.ts) rather than through Bun's
// path APIs: a path is a route, a descriptor is the thing, and the whole point
// of the walk below is to stop being able to tell the two apart (§24.2).

import fs from "node:fs";
import { constants as C } from "node:fs";

import {
  AT_SYMLINK_NOFOLLOW,
  O_CLOEXEC,
  PosixError,
  isRegularFile,
  mkdirat,
  openat,
  renameat,
  statat,
  unlinkat,
} from "./posix.ts";
import { parseStrict, stringifyRow, JsonDisciplineError } from "./canonical-json.ts";
import { SchemaSubsetError, SchemaValidator } from "./schema.ts";
import { AtlasReader, ReaderError } from "./reader.ts";

/** §25.8's ceiling on one journal row, before its terminating newline. */
export const JOURNAL_ROW_BYTES = 16_384;

const JOURNAL_READ_BYTES = 8_192;

export const RESERVED_RECEIPT_NAMESPACES: ReadonlySet<string> = new Set([
  "import",
  "manual",
  "observe",
]);

/** §8's registered journals: the only stems the fold and validator read. */
export const JOURNALS: ReadonlyMap<string, string> = new Map([
  ["artifacts", "journal-artifact"],
  ["encounters", "journal-encounter"],
  ["questions", "journal-question"],
  ["decisions", "journal-decision"],
  ["mapping-decisions", "journal-mapping-decision"],
  ["receipts", "journal-receipt"],
  ["purges", "journal-purge"],
]);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECEIPT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*#[0-9]+$/;

const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "secrets",
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".git",
]);

/** Stable, content-free failure codes exposed to callers. */
export const ReasonCode = {
  InvalidRoot: "invalid-root",
  UnsafePath: "unsafe-path",
  IgnoredPath: "ignored-path",
  UnboundedRead: "unbounded-read",
  InvalidCeiling: "invalid-ceiling",
  ByteCeilingExceeded: "byte-ceiling-exceeded",
  CountCeilingExceeded: "count-ceiling-exceeded",
  InvalidUtf8: "invalid-utf8",
  InvalidLineEnding: "invalid-line-ending",
  InvalidJson: "invalid-json",
  UnknownSchema: "unknown-schema",
  SchemaRegistryInvalid: "schema-registry-invalid",
  MissingFormatVersion: "missing-format-version",
  UnknownFormat: "unknown-format",
  UnsupportedVersion: "unsupported-version",
  SchemaInvalid: "schema-invalid",
  LockHeld: "lock-held",
  LockRequired: "lock-required",
  LockLost: "lock-lost",
  LockIo: "lock-io",
  AppendIo: "append-io",
  InvalidJournalPath: "invalid-journal-path",
  InvalidJsonl: "invalid-jsonl",
  InvalidReceiptKey: "invalid-receipt-key",
  InvalidReceiptTransition: "invalid-receipt-transition",
  InvalidReceiptJournal: "invalid-receipt-journal",
  ContentConflict: "content-conflict",
  PreserveIo: "preserve-io",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/** The two diagnostic levels permitted by the executable contract. */
export const DiagnosticLevel = { Error: "ERROR", Warning: "WARNING" } as const;
export type DiagnosticLevel =
  (typeof DiagnosticLevel)[keyof typeof DiagnosticLevel];

const EXPECTATIONS: Readonly<Record<ReasonCode, string>> = {
  [ReasonCode.InvalidRoot]: "an explicit real instance directory with atlas/ and state/",
  [ReasonCode.UnsafePath]: "a real contained path with no traversal, symlink, or special file",
  [ReasonCode.IgnoredPath]: "a path outside every Atlas ignore root",
  [ReasonCode.UnboundedRead]: "an explicit caller-supplied byte ceiling",
  [ReasonCode.InvalidCeiling]: "a non-negative integer ceiling and observed count",
  [ReasonCode.ByteCeilingExceeded]: "input at or below the caller-supplied byte ceiling",
  [ReasonCode.CountCeilingExceeded]: "input at or below the caller-supplied count ceiling",
  [ReasonCode.InvalidUtf8]: "strict UTF-8 JSON",
  [ReasonCode.InvalidLineEnding]: "LF-only Atlas-authored text",
  [ReasonCode.InvalidJson]: "one structurally valid JSON value with unique object keys",
  [ReasonCode.UnknownSchema]: "a registered persisted-format schema",
  [ReasonCode.SchemaRegistryInvalid]: "the complete valid canonical schema registry",
  [ReasonCode.MissingFormatVersion]: "string format and integer version fields",
  [ReasonCode.UnknownFormat]: "a registered format identifier",
  [ReasonCode.UnsupportedVersion]: "the version declared by the registered schema",
  [ReasonCode.SchemaInvalid]: "an object conforming to its closed registered schema",
  [ReasonCode.LockHeld]: "an absent .atlas-lock; stale locks are removed only by hand",
  [ReasonCode.LockRequired]: "the instance lock held across the complete writing flow",
  [ReasonCode.LockLost]: "the same .atlas-lock inode acquired by this writer",
  [ReasonCode.LockIo]: "an atomically created lock containing pid and started_at",
  [ReasonCode.AppendIo]: "one complete fsynced JSONL append",
  [ReasonCode.InvalidJournalPath]: "an instance-relative state/*.jsonl journal path",
  [ReasonCode.InvalidJsonl]: "strict UTF-8 LF-only JSONL with one complete value per row",
  [ReasonCode.InvalidReceiptKey]: "a content-free <source-slug>/<batch-slug>#<n> key",
  [ReasonCode.InvalidReceiptTransition]: "one opened row followed by one processed row",
  [ReasonCode.InvalidReceiptJournal]: "ordered schema-valid content-free receipt rows",
  [ReasonCode.ContentConflict]: "byte-identical content at the canonical path",
  [ReasonCode.PreserveIo]: "one durable byte-identical canonical original",
};

/** A privacy-safe diagnostic containing no rejected record value. */
export interface Diagnostic {
  readonly reason: ReasonCode;
  readonly level: DiagnosticLevel;
  readonly relativePath: string;
  readonly recordIndex: number | null;
}

/** Stable metadata returned after one durable journal append. */
export interface AppendResult {
  readonly relativePath: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}

/** Receipt keys observed in each marker state. */
export class ReceiptStatus {
  readonly opened: ReadonlySet<string>;
  readonly processed: ReadonlySet<string>;

  constructor(opened: ReadonlySet<string>, processed: ReadonlySet<string>) {
    this.opened = opened;
    this.processed = processed;
  }

  /** Keys with an opened row but no processed row. */
  get interrupted(): Set<string> {
    return new Set([...this.opened].filter((key) => !this.processed.has(key)));
  }
}

/** One bounded delivered JSON value and its byte-identical original. */
export interface DeliveredJSON {
  readonly value: unknown;
  readonly data: Uint8Array;
}

/**
 * A journal row that could not be read at all.
 *
 * Separate from AtlasIOError because the reason code depends on who was
 * reading: the same torn row is `invalid-receipt-journal` to the receipt fold
 * and something else to the next reader, and only the caller knows which.
 */
export class JournalReadError extends Error {
  readonly relativePath: string;
  readonly recordIndex: number | null;

  constructor(relativePath: string, recordIndex: number | null) {
    super(`${relativePath}: journal row cannot be read`);
    this.name = "JournalReadError";
    this.relativePath = relativePath;
    this.recordIndex = recordIndex;
  }
}

/** Fail-closed error whose text is always a no-echo diagnostic. */
export class AtlasIOError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(formatDiagnostics(diagnostic));
    this.name = "AtlasIOError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Whether a character is one CPython's `str.isprintable` would keep: anything
 * outside the Other and Separator general categories, plus ASCII space, which
 * is the single separator it makes an exception for.
 */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/** Format diagnostics as bounded ERROR:/WARNING: lines. */
export function formatDiagnostics(
  diagnostics: Diagnostic | readonly Diagnostic[],
): string {
  const items = Array.isArray(diagnostics)
    ? (diagnostics as readonly Diagnostic[])
    : [diagnostics as Diagnostic];
  return items
    .map((item) => {
      let location = item.relativePath;
      if (item.recordIndex !== null) location += `#${item.recordIndex}`;
      // POSIX filenames may carry control characters; a raw newline would
      // inject an unprefixed diagnostic line (§25.8 one-per-line contract).
      let safe = "";
      for (const character of location) {
        safe += character === " " || !UNPRINTABLE.test(character) ? character : "?";
      }
      return `${item.level}: ${safe}: ${item.reason}; expected ${EXPECTATIONS[item.reason]}`;
    })
    .join("\n");
}

function fail(
  reason: ReasonCode,
  relativePath = ".",
  recordIndex: number | null = null,
): never {
  throw new AtlasIOError({
    reason,
    level: DiagnosticLevel.Error,
    relativePath,
    recordIndex,
  });
}

/** Enforce one explicit byte or count ceiling without echoing values. */
export function enforceCeiling(
  actual: number,
  options: { maximum: number | null; kind: "bytes" | "count"; relativePath?: string },
): void {
  const { maximum, kind } = options;
  const relativePath = options.relativePath ?? ".";
  if (maximum === null) fail(ReasonCode.UnboundedRead, relativePath);
  if (
    !Number.isInteger(actual) ||
    !Number.isInteger(maximum) ||
    actual < 0 ||
    maximum < 0 ||
    (kind !== "bytes" && kind !== "count")
  ) {
    fail(ReasonCode.InvalidCeiling, relativePath);
  }
  if (actual > maximum) {
    fail(
      kind === "bytes"
        ? ReasonCode.ByteCeilingExceeded
        : ReasonCode.CountCeilingExceeded,
      relativePath,
    );
  }
}

/**
 * Build a mechanically valid content-free receipt key.
 *
 * Reserved namespaces remain valid here because direct import and observe
 * lanes own them; intake-specific refusal belongs to the intake caller.
 */
export function makeReceiptKey(source: string, batch: string, index: number): string {
  if (
    typeof source !== "string" ||
    typeof batch !== "string" ||
    !SLUG.test(source) ||
    !SLUG.test(batch) ||
    !Number.isInteger(index) ||
    index < 0
  ) {
    fail(ReasonCode.InvalidReceiptKey);
  }
  return `${source}/${batch}#${index}`;
}

function isIgnoredName(name: string): boolean {
  return (
    name === ".env" || name.startsWith(".env.") || IGNORED_DIRECTORY_NAMES.has(name)
  );
}

/**
 * Split a relative path the way the oracle's path type does.
 *
 * `pathlib.Path` drops empty and `.` components before anything looks at them,
 * so only `..` ever survives to be rejected; reproducing the drop here is what
 * keeps `a//b` and `a/./b` naming the same file in both implementations.
 */
function pathParts(relativePath: string): string[] {
  return relativePath.split("/").filter((part) => part !== "" && part !== ".");
}

function isAbsolute(relativePath: string): boolean {
  return relativePath.startsWith("/");
}

/**
 * The absolute form of a path, the way the oracle's `abspath` builds it:
 * joined to the working directory when relative, then `.` and `..` collapsed
 * lexically without touching the filesystem.
 *
 * Lexical is the point. A `..` resolved against the filesystem would follow a
 * symlink out of the tree; collapsed lexically it names a path that is then
 * walked component by component, and the walk is what refuses the link.
 */
function absoluteParts(supplied: string): string[] {
  const parts = isAbsolute(supplied)
    ? pathParts(supplied)
    : [...pathParts(process.cwd()), ...pathParts(supplied)];
  const collapsed: string[] = [];
  for (const part of parts) {
    // At the root `..` is the root — one component above `/` does not exist,
    // and the oracle's normpath keeps it there rather than erroring.
    if (part === "..") collapsed.pop();
    else collapsed.push(part);
  }
  return collapsed;
}

/** The display form of a path, or "." when the path itself is unsafe. */
function safeDisplayPath(relativePath: string): string {
  const parts = pathParts(relativePath);
  const joined = parts.join("/");
  if (
    isAbsolute(relativePath) ||
    parts.length === 0 ||
    parts.includes("..") ||
    isIgnoredName(parts[0] as string) ||
    UNPRINTABLE.test(joined.replaceAll(" ", ""))
  ) {
    return ".";
  }
  return joined;
}

const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | O_CLOEXEC;

/** Open the instance root itself, no-follow. */
function openRoot(root: string, onFailure: ReasonCode): number {
  // The root is the one path that cannot be reached through a descriptor:
  // something has to name it. It was lstat-walked component by component when
  // the instance was constructed, and it is reopened here rather than held so
  // that a root replaced between calls is caught rather than cached.
  try {
    return fs.openSync(root, DIR_FLAGS);
  } catch {
    fail(onFailure);
  }
}

/**
 * Open a validated root-relative path binding every component no-follow.
 *
 * Walks the already-checked component chain with directory descriptors, so a
 * directory swapped for a symlink after the check cannot redirect the open
 * (§24.2). Returns both descriptors; the caller closes both.
 */
function openUnderRoot(
  root: string,
  parts: readonly string[],
  flags: number,
  mode = 0o600,
): { fd: number; parentFd: number } {
  let dirFd = openRoot(root, ReasonCode.UnsafePath);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openat(dirFd, part, DIR_FLAGS);
      fs.closeSync(dirFd);
      dirFd = next;
    }
    const fd = openat(dirFd, parts[parts.length - 1] as string, flags, mode);
    return { fd, parentFd: dirFd };
  } catch (error) {
    fs.closeSync(dirFd);
    throw error;
  }
}

/** Open, and durably create when absent, a no-follow directory chain. */
function ensureDirectories(
  root: string,
  parts: readonly string[],
  display: string,
): number {
  let dirFd = openRoot(root, ReasonCode.PreserveIo);
  for (const component of parts) {
    let next: number;
    try {
      next = openat(dirFd, component, DIR_FLAGS);
    } catch (error) {
      if (error instanceof PosixError && error.code === "ENOENT") {
        try {
          mkdirat(dirFd, component, 0o700);
          fs.fsyncSync(dirFd);
          next = openat(dirFd, component, DIR_FLAGS);
        } catch {
          fs.closeSync(dirFd);
          fail(ReasonCode.PreserveIo, display);
        }
      } else {
        fs.closeSync(dirFd);
        fail(ReasonCode.UnsafePath, display);
      }
    }
    fs.closeSync(dirFd);
    dirFd = next;
  }
  return dirFd;
}

/** Read one already-open regular file after its fstat ceiling check. */
function readBoundedFd(fd: number, maximum: number | null, display: string): Uint8Array {
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) fail(ReasonCode.UnsafePath, display);
    enforceCeiling(info.size, { maximum, kind: "bytes", relativePath: display });

    // One byte past the ceiling: enough to tell "exactly at the limit" from
    // "grew between the fstat and the read", which the second check below
    // refuses. Reading only up to the ceiling would make the two look alike.
    const wanted = maximum === null ? 1 : maximum + 1;
    const buffer = Buffer.alloc(wanted);
    let filled = 0;
    while (filled < wanted) {
      const read = fs.readSync(fd, buffer, filled, wanted - filled, null);
      if (read === 0) break;
      filled += read;
    }
    const data = new Uint8Array(buffer.subarray(0, filled));
    enforceCeiling(data.length, { maximum, kind: "bytes", relativePath: display });
    return data;
  } catch (error) {
    if (error instanceof AtlasIOError) throw error;
    fail(ReasonCode.UnsafePath, display);
  } finally {
    fs.closeSync(fd);
  }
}

const BOM = [0xef, 0xbb, 0xbf];

function startsWithBom(data: Uint8Array): boolean {
  return BOM.every((byte, index) => data[index] === byte);
}

/** Decode one strict JSON value without echoing refused content. */
function decodeJson(
  data: Uint8Array,
  options: { delivered: boolean; display: string },
): unknown {
  const { delivered, display } = options;
  let body = data;
  if (startsWithBom(body)) {
    if (!delivered) fail(ReasonCode.InvalidUtf8, display);
    body = body.subarray(3);
  }
  if (!delivered && body.includes(0x0d)) {
    fail(ReasonCode.InvalidLineEnding, display);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    fail(ReasonCode.InvalidUtf8, display);
  }
  try {
    return parseStrict(text);
  } catch (error) {
    if (error instanceof JsonDisciplineError || error instanceof SyntaxError) {
      fail(ReasonCode.InvalidJson, display);
    }
    throw error;
  }
}

let cachedRegistry: ReadonlyMap<string, Record<string, unknown>> | null = null;

/**
 * The canonical schema registry, read once from `spec/schemas`.
 *
 * Cached because a registry that changed under a running writer would make two
 * appends in one locked flow answer to different rules.
 */
export function schemaRegistry(
  directory?: string,
): ReadonlyMap<string, Record<string, unknown>> {
  if (directory === undefined && cachedRegistry !== null) return cachedRegistry;
  const repository = directory ?? new URL("../..", import.meta.url).pathname;
  const registry = new Map<string, Record<string, unknown>>();
  let files: ReturnType<AtlasReader["scan"]>;
  try {
    files = new AtlasReader(repository).scan("spec/schemas");
  } catch {
    fail(ReasonCode.SchemaRegistryInvalid);
  }
  const schemas = files.filter((file) => file.name.endsWith(".schema.json"));
  if (schemas.length === 0) fail(ReasonCode.SchemaRegistryInvalid);
  for (const file of schemas) {
    let schema: unknown;
    try {
      schema = decodeJson(file.readBytes(), {
        delivered: false,
        display: file.relativePath,
      });
      // Constructing the validator is the subset check: a registry entry
      // reaching past the admitted keywords is refused at load, not at the
      // first record unlucky enough to exercise that branch.
      new SchemaValidator(schema as Record<string, unknown>);
    } catch {
      fail(ReasonCode.SchemaRegistryInvalid);
    }
    registry.set(
      file.name.slice(0, -".schema.json".length),
      schema as Record<string, unknown>,
    );
  }
  if (directory === undefined) cachedRegistry = registry;
  return registry;
}

/** Validated instance I/O with containment, locking, and durability. */
export class AtlasInstance {
  readonly root: string;
  private lockFd: number | null = null;
  // Valid only while the lock is held: the single-writer lock excludes every
  // other Atlas writer, so receipt state can only change through this
  // instance's own appendReceipt. Cleared on release.
  private receiptCache: { opened: Set<string>; processed: Set<string> } | null = null;

  constructor(root: string) {
    this.root = validateInstanceRoot(root);
  }

  /** Construct and lstat a safe path beneath the instance root. */
  path(relativePath: string, options: { allowMissing?: boolean } = {}): string {
    return safePath(this.root, relativePath, options.allowMissing ?? false);
  }

  /**
   * Read one bounded JSON value after checking total bytes by fstat.
   *
   * §25.8 scopes no-BOM to Atlas-authored files; a delivered original
   * (`delivered`) tolerates a BOM as the canonical readers do.
   */
  readJson(
    relativePath: string,
    options: { maxBytes: number | null; delivered?: boolean },
  ): unknown {
    const display = safeDisplayPath(relativePath);
    this.path(relativePath);
    const parts = pathParts(relativePath);
    // Re-open binding every component no-follow: the containment check above
    // cannot cover a swap in the gap before the open (§24.2).
    const flags = C.O_RDONLY | C.O_NOFOLLOW | O_CLOEXEC;
    let opened: { fd: number; parentFd: number };
    try {
      opened = openUnderRoot(this.root, parts, flags);
    } catch {
      fail(ReasonCode.UnsafePath, display);
    }
    // Quietly: the parent is a read-only directory descriptor whose close can
    // tell the caller nothing it could act on, and letting it throw here would
    // both leak the target descriptor and take an unhandled exception out of a
    // boundary whose whole contract is to refuse in the open (§24.2).
    closeQuietly(opened.parentFd);
    const data = readBoundedFd(opened.fd, options.maxBytes, display);
    return decodeJson(data, { delivered: options.delivered ?? false, display });
  }

  /**
   * Read an explicit external delivery no-follow, bounded by fstat.
   *
   * The caller still chooses the instance destination. Returning the original
   * bytes lets the lane preserve exactly what was decoded, without a second
   * path open or a check/copy race.
   */
  readDeliveredJson(
    absolutePath: string,
    options: { maxBytes: number | null; delivered?: boolean } = { maxBytes: null },
  ): DeliveredJSON {
    const delivered = options.delivered ?? true;
    if (typeof absolutePath !== "string") fail(ReasonCode.UnsafePath);
    const parts = absoluteParts(absolutePath);
    const rootParts = pathParts(this.root);
    const contained =
      parts.length > rootParts.length &&
      rootParts.every((part, index) => parts[index] === part);
    if (contained) {
      // An instance-contained delivery binds the instance's own containment
      // and ignore-root rules (§24.2) — a batch under INSTANCE/secrets/ or
      // .env* must refuse before any read.
      safePath(this.root, parts.slice(rootParts.length).join("/"), false);
    } else if (parts.some((part) => isIgnoredName(part))) {
      // §24: read no secrets, never scan .env — an external delivery under an
      // ignore-named component is refused before decoding or preservation.
      fail(ReasonCode.IgnoredPath);
    }
    if (parts.length === 0) fail(ReasonCode.UnsafePath);
    let opened: { fd: number; parentFd: number };
    try {
      opened = openUnderRoot(
        "/",
        parts,
        C.O_RDONLY | C.O_NOFOLLOW | O_CLOEXEC | C.O_NONBLOCK,
      );
    } catch {
      fail(ReasonCode.UnsafePath);
    }
    // Quietly: the parent is a read-only directory descriptor whose close can
    // tell the caller nothing it could act on, and letting it throw here would
    // both leak the target descriptor and take an unhandled exception out of a
    // boundary whose whole contract is to refuse in the open (§24.2).
    closeQuietly(opened.parentFd);
    const data = readBoundedFd(opened.fd, options.maxBytes, ".");
    return { value: decodeJson(data, { delivered, display: "." }), data };
  }

  /**
   * Durably preserve bytes at a canonical path without overwriting.
   *
   * Returns true when this call created the original and false for an
   * identical replay. Different existing bytes fail closed.
   */
  preserveBytes(relativePath: string, data: Uint8Array): boolean {
    this.requireLock();
    const display = safeDisplayPath(relativePath);
    const parts = pathParts(relativePath);
    if (
      isAbsolute(relativePath) ||
      parts.length === 0 ||
      parts.includes("..") ||
      isIgnoredName(parts[0] as string)
    ) {
      fail(ReasonCode.UnsafePath, display);
    }

    const parentFd = ensureDirectories(this.root, parts.slice(0, -1), display);
    const name = parts[parts.length - 1] as string;
    const readFlags = C.O_RDONLY | C.O_NOFOLLOW | O_CLOEXEC | C.O_NONBLOCK;

    let existingFd: number | null = null;
    try {
      existingFd = openat(parentFd, name, readFlags);
    } catch (error) {
      if (!(error instanceof PosixError) || error.code !== "ENOENT") {
        fs.closeSync(parentFd);
        fail(ReasonCode.UnsafePath, display);
      }
    }

    if (existingFd !== null) {
      let existing: Uint8Array;
      try {
        let size: number;
        try {
          size = fs.fstatSync(existingFd).size;
        } catch {
          fs.closeSync(existingFd);
          fail(ReasonCode.UnsafePath, display);
        }
        if (size !== data.length) {
          fs.closeSync(existingFd);
          fail(ReasonCode.ContentConflict, display);
        }
        // readBoundedFd closes the descriptor it is handed, on every path.
        existing = readBoundedFd(existingFd, data.length, display);
      } finally {
        fs.closeSync(parentFd);
      }
      if (!sameBytes(existing, data)) fail(ReasonCode.ContentConflict, display);
      return false;
    }

    let tempName: string | null = null;
    let tempFd: number | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `.${name}.tmp-${process.pid}-${attempt}`;
      try {
        tempFd = openat(
          parentFd,
          candidate,
          C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW | O_CLOEXEC,
          0o600,
        );
        tempName = candidate;
        break;
      } catch (error) {
        if (error instanceof PosixError && error.code === "EEXIST") continue;
        fs.closeSync(parentFd);
        fail(ReasonCode.PreserveIo, display);
      }
    }
    if (tempFd === null || tempName === null) {
      fs.closeSync(parentFd);
      fail(ReasonCode.PreserveIo, display);
    }

    try {
      // A short write here is fatal, not something to paper over: the rename
      // below would put a truncated file at the canonical path, which is the
      // one outcome this whole temp-file dance exists to prevent. The oracle
      // raises on it; the throw lands in the catch that unlinks the temp.
      if (!writeFully(tempFd, data)) throw new ShortWrite();
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = null;
      // The instance lock is the single-writer exclusion (§25.6), so this
      // same-directory rename cannot replace another Atlas write.
      renameat(parentFd, tempName, parentFd, name);
      tempName = null;
      fs.fsyncSync(parentFd);
    } catch {
      if (tempFd !== null) closeQuietly(tempFd);
      if (tempName !== null) {
        try {
          unlinkat(parentFd, tempName);
          fs.fsyncSync(parentFd);
        } catch {
          /* the temporary file outlives the failure; the canonical path is
             untouched, which is the property this call promises */
        }
      }
      fs.closeSync(parentFd);
      fail(ReasonCode.PreserveIo, display);
    }
    fs.closeSync(parentFd);
    return true;
  }

  /** Content-free canonical schema errors for one definition. */
  schemaErrors(
    value: unknown,
    schemaName: string,
    options: { definition?: string } = {},
  ): string[] {
    const schemas = schemaRegistry();
    const schema = schemas.get(schemaName);
    if (schema === undefined) fail(ReasonCode.UnknownSchema);
    let target: unknown = schema;
    if (options.definition !== undefined) {
      const defs = schema["$defs"];
      target =
        typeof defs === "object" && defs !== null
          ? (defs as Record<string, unknown>)[options.definition]
          : undefined;
      if (target === undefined) fail(ReasonCode.UnknownSchema);
    }
    try {
      return new SchemaValidator(schema)
        .validateAgainst(value, target)
        .map((error) => error.message);
    } catch (error) {
      if (error instanceof SchemaSubsetError) fail(ReasonCode.SchemaRegistryInvalid);
      throw error;
    }
  }

  /** Validate a parsed value against one canonical registered schema. */
  validateSchema(
    value: unknown,
    schemaName: string,
    options: { definition?: string } = {},
  ): void {
    if (this.schemaErrors(value, schemaName, options).length > 0) {
      fail(ReasonCode.SchemaInvalid);
    }
  }

  /** Check format/version and then the matching closed schema. */
  validateFormat(value: unknown, options: { definition?: string } = {}): string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(ReasonCode.MissingFormatVersion);
    }
    const record = value as Record<string, unknown>;
    const formatName = record["format"];
    const version = record["version"];
    if (typeof formatName !== "string" || !Number.isInteger(version)) {
      fail(ReasonCode.MissingFormatVersion);
    }
    const schema = schemaRegistry().get(formatName);
    const properties = schema?.["properties"] as Record<string, unknown> | undefined;
    const formatSchema = properties?.["format"] as Record<string, unknown> | undefined;
    if (schema === undefined || formatSchema?.["const"] !== formatName) {
      fail(ReasonCode.UnknownFormat);
    }
    const versionSchema = properties?.["version"];
    if (typeof versionSchema !== "object" || versionSchema === null) {
      fail(ReasonCode.SchemaRegistryInvalid);
    }
    const declared = versionSchema as Record<string, unknown>;
    let supported: unknown[];
    if (Object.hasOwn(declared, "const")) supported = [declared["const"]];
    else if (Array.isArray(declared["enum"])) supported = declared["enum"];
    else fail(ReasonCode.SchemaRegistryInvalid);
    if (supported.length === 0 || !supported.every((item) => Number.isInteger(item))) {
      fail(ReasonCode.SchemaRegistryInvalid);
    }
    if (!supported.includes(version)) fail(ReasonCode.UnsupportedVersion);
    this.validateSchema(value, formatName, options);
    return formatName;
  }

  /**
   * Hold the instance's acquire-if-absent single-writer lock across `body`.
   *
   * A callback rather than a pair of calls: the lock covers the complete
   * writing flow (§25.6), and a release that can be forgotten is a lock that
   * eventually is.
   */
  withLock<T>(body: () => T): T {
    if (this.lockFd !== null) fail(ReasonCode.LockHeld, ".atlas-lock");
    const lockPath = `${this.root}/.atlas-lock`;
    let lockFd: number;
    try {
      lockFd = fs.openSync(
        lockPath,
        C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      fail(code === "EEXIST" ? ReasonCode.LockHeld : ReasonCode.LockIo, ".atlas-lock");
    }
    this.lockFd = lockFd;

    const payload = new TextEncoder().encode(
      `${stringifyRow({ pid: process.pid, started_at: utcStamp() })}\n`,
    );
    try {
      const written = fs.writeSync(lockFd, payload, 0, payload.length, null);
      if (written !== payload.length) throw new Error("short write");
    } catch {
      releaseLock(lockFd, lockPath);
      this.lockFd = null;
      fail(ReasonCode.LockIo, ".atlas-lock");
    }

    let bodyFailed = false;
    try {
      return body();
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      const failure = releaseLock(lockFd, lockPath);
      this.lockFd = null;
      this.receiptCache = null;
      // A release failure inside an already-failing flow would replace the
      // caller's cause with a symptom; the original error wins.
      if (failure !== null && !bodyFailed) fail(failure, ".atlas-lock");
    }
  }

  /**
   * Schema-check and durably append exactly one strict JSONL row.
   *
   * Only §8's registered journal shapes are writable — state/<stem>.jsonl or a
   * one-level rotation state/<stem>/<file>.jsonl — because those are the only
   * paths the fold and the validator read; the row schema is the stem's own.
   * Receipts are excluded: their rows carry the §33.2 transition contract and
   * go through appendReceipt only.
   */
  appendRecord(relativePath: string, record: Record<string, unknown>): AppendResult {
    const display = safeDisplayPath(relativePath);
    const parts = pathParts(relativePath);
    let schemaName: string | undefined;
    if (
      (parts.length === 2 || parts.length === 3) &&
      parts[0] === "state" &&
      (parts[parts.length - 1] as string).endsWith(".jsonl")
    ) {
      const last = parts[parts.length - 1] as string;
      const stem =
        parts.length === 2 ? last.slice(0, -".jsonl".length) : (parts[1] as string);
      if (stem !== "receipts") schemaName = JOURNALS.get(stem);
    }
    if (schemaName === undefined) fail(ReasonCode.InvalidJournalPath);
    return this.append(relativePath, display, record, schemaName);
  }

  private append(
    relativePath: string,
    display: string,
    record: Record<string, unknown>,
    schemaName: string,
  ): AppendResult {
    this.requireLock();
    this.validateSchema(record, schemaName);
    let payload: Uint8Array;
    try {
      payload = new TextEncoder().encode(stringifyRow(record));
    } catch {
      fail(ReasonCode.SchemaInvalid, display);
    }
    enforceCeiling(payload.length, {
      maximum: JOURNAL_ROW_BYTES,
      kind: "bytes",
      relativePath: display,
    });

    const parts = pathParts(relativePath);
    this.path(relativePath, { allowMissing: true });
    this.path(parts.slice(0, -1).join("/"));
    const name = parts[parts.length - 1] as string;

    let before: { size: number } | null = null;
    {
      const rootFd = openRoot(this.root, ReasonCode.UnsafePath);
      let dirFd = rootFd;
      try {
        for (const part of parts.slice(0, -1)) {
          const next = openat(dirFd, part, DIR_FLAGS);
          fs.closeSync(dirFd);
          dirFd = next;
        }
        const info = statat(dirFd, name, AT_SYMLINK_NOFOLLOW);
        if (!isRegularFile(info.mode)) fail(ReasonCode.UnsafePath, display);
        before = { size: info.size };
      } catch (error) {
        if (error instanceof AtlasIOError) {
          fs.closeSync(dirFd);
          throw error;
        }
        if (!(error instanceof PosixError) || error.code !== "ENOENT") {
          fs.closeSync(dirFd);
          fail(ReasonCode.UnsafePath, display);
        }
      }
      fs.closeSync(dirFd);
    }

    const flags =
      C.O_APPEND | C.O_CREAT | C.O_RDWR | O_CLOEXEC | C.O_NOFOLLOW | C.O_NONBLOCK;
    let opened: { fd: number; parentFd: number };
    try {
      opened = openUnderRoot(this.root, parts, flags);
    } catch {
      fail(ReasonCode.AppendIo, display);
    }
    const { fd, parentFd } = opened;

    let size: number;
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile()) fail(ReasonCode.UnsafePath, display);
      size = info.size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) fail(ReasonCode.InvalidJsonl, display);
      }

      const line = new Uint8Array(payload.length + 1);
      line.set(payload);
      line[payload.length] = 0x0a;

      // The lock excludes other Atlas writers, so on any failure — short write
      // or post-write fsync — truncating back to the pre-append size cannot
      // lose foreign rows, while a torn or undurable tail would corrupt every
      // later append or retry.
      let durable: boolean;
      try {
        durable = writeFully(fd, line);
        if (durable) fs.fsyncSync(fd);
      } catch {
        durable = false;
      }
      if (!durable) {
        try {
          if (before === null) {
            // This call created the file: truncation would leave an empty
            // journal whose directory entry a retry never syncs — unlink it.
            unlinkat(parentFd, name);
            fs.fsyncSync(parentFd);
          } else {
            fs.ftruncateSync(fd, size);
            fs.fsyncSync(fd);
          }
        } catch {
          /* the append already failed; the rollback is best effort */
        }
        fail(ReasonCode.AppendIo, display);
      }

      if (before === null) {
        try {
          fs.fsyncSync(parentFd);
        } catch {
          // The row is not durable until its new file's directory entry is;
          // unlink the created file so a retry does not see a phantom row.
          try {
            unlinkat(parentFd, name);
            fs.fsyncSync(parentFd);
          } catch {
            /* best effort, as above */
          }
          fail(ReasonCode.AppendIo, display);
        }
      }
    } catch (error) {
      if (error instanceof AtlasIOError) throw error;
      fail(ReasonCode.AppendIo, display);
    } finally {
      closeQuietly(fd);
      fs.closeSync(parentFd);
    }

    return { relativePath: display, bytesWritten: payload.length, created: before === null };
  }

  /** Append one legal opened/processed receipt transition durably. */
  appendReceipt(key: string, marker: string, date: string): AppendResult {
    if (typeof key !== "string" || !RECEIPT_KEY.test(key)) {
      fail(ReasonCode.InvalidReceiptKey, "state/receipts.jsonl");
    }
    if (marker !== "opened" && marker !== "processed") {
      fail(ReasonCode.InvalidReceiptTransition, "state/receipts.jsonl");
    }
    this.requireLock();
    const current = this.receiptStatus();
    const legal =
      marker === "opened"
        ? !current.opened.has(key) && !current.processed.has(key)
        : current.opened.has(key) && !current.processed.has(key);
    if (!legal) fail(ReasonCode.InvalidReceiptTransition, "state/receipts.jsonl");

    const result = this.append(
      "state/receipts.jsonl",
      "state/receipts.jsonl",
      { intake: key, marker, date },
      "journal-receipt",
    );
    if (this.receiptCache !== null) {
      (marker === "opened"
        ? this.receiptCache.opened
        : this.receiptCache.processed
      ).add(key);
    }
    return result;
  }

  /**
   * Report opened, processed, and interrupted receipt keys.
   *
   * Reads the §8 concatenation — state/receipts.jsonl plus any rotated
   * state/receipts/*.jsonl — the same set the canonical validator folds.
   */
  receiptStatus(): ReceiptStatus {
    if (this.lockFd !== null && this.receiptCache !== null) {
      return new ReceiptStatus(
        new Set(this.receiptCache.opened),
        new Set(this.receiptCache.processed),
      );
    }
    // (chronological file rank, line): the direct file is the newest —
    // rotation moves old rows out — so rotated files rank first in sorted
    // order and state/receipts.jsonl last. §33.2's pair is ordered by this
    // position: opened must precede processed; duplicates are illegal.
    const opened = new Map<string, [number, number]>();
    const processed = new Map<string, [number, number, string]>();
    const validator = new SchemaValidator(
      schemaRegistry().get("journal-receipt") as Record<string, unknown>,
    );

    const files = this.journalPaths("receipts");
    for (const [index, relative] of files.entries()) {
      // A row this journal cannot even be read as is a broken receipt journal,
      // not a generic JSONL complaint: the caller asked about receipts, and
      // the reason code is what they branch on. The row number goes with it
      // only when the reader got far enough to have one.
      let rows: Array<[number, unknown]>;
      try {
        rows = this.readJsonl(relative);
      } catch (error) {
        if (error instanceof JournalReadError) {
          fail(ReasonCode.InvalidReceiptJournal, relative);
        }
        throw error;
      }
      for (const [number, row] of rows) {
        if (
          typeof row !== "object" ||
          row === null ||
          Array.isArray(row) ||
          validator.validate(row).length > 0
        ) {
          fail(ReasonCode.InvalidReceiptJournal, relative, number);
        }
        const record = row as Record<string, unknown>;
        const key = record["intake"] as string;
        const target = record["marker"] === "opened" ? opened : processed;
        if (target.has(key)) {
          fail(ReasonCode.InvalidReceiptJournal, relative, number);
        }
        if (record["marker"] === "opened") opened.set(key, [index, number]);
        else processed.set(key, [index, number, relative]);
      }
    }

    for (const [key, [rank, number, relative]] of processed) {
      const begun = opened.get(key);
      if (
        begun === undefined ||
        begun[0] > rank ||
        (begun[0] === rank && begun[1] >= number)
      ) {
        fail(ReasonCode.InvalidReceiptJournal, relative, number);
      }
    }

    if (this.lockFd !== null) {
      this.receiptCache = {
        opened: new Set(opened.keys()),
        processed: new Set(processed.keys()),
      };
    }
    return new ReceiptStatus(new Set(opened.keys()), new Set(processed.keys()));
  }

  /**
   * The journal files for one stem, oldest first.
   *
   * §20.1: rotated files are the older prefix and the direct journal is the
   * newest tail — the same order every order-sensitive check reads.
   */
  private journalPaths(stem: string): string[] {
    const reader = new AtlasReader(this.root);
    const found: string[] = [];
    try {
      for (const file of reader.scan(`state/${stem}`, { recursive: false })) {
        if (file.name.endsWith(".jsonl")) found.push(file.relativePath);
      }
      const direct = reader.optionalFile(`state/${stem}.jsonl`);
      if (direct !== null) found.push(direct.relativePath);
    } catch (error) {
      if (error instanceof ReaderError) {
        fail(ReasonCode.UnsafePath, error.relativePath ?? `state/${stem}.jsonl`);
      }
      throw error;
    }
    return found;
  }

  /** Rows of one journal file, without retaining more than the ceiling. */
  private readJsonl(relative: string): Array<[number, unknown]> {
    const display = relative;
    const parts = pathParts(relative);
    let opened: { fd: number; parentFd: number };
    try {
      opened = openUnderRoot(
        this.root,
        parts,
        C.O_RDONLY | C.O_NOFOLLOW | O_CLOEXEC | C.O_NONBLOCK,
      );
    } catch {
      throw new JournalReadError(display, null);
    }
    // Quietly: the parent is a read-only directory descriptor whose close can
    // tell the caller nothing it could act on, and letting it throw here would
    // both leak the target descriptor and take an unhandled exception out of a
    // boundary whose whole contract is to refuse in the open (§24.2).
    closeQuietly(opened.parentFd);

    const rows: Array<[number, unknown]> = [];
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let number = 1;
    let row: number[] = [];
    let discarding = false;
    let first = true;

    try {
      const info = fs.fstatSync(opened.fd);
      if (!info.isFile()) throw new JournalReadError(display, null);
      const chunk = Buffer.alloc(JOURNAL_READ_BYTES);
      for (;;) {
        const read = fs.readSync(opened.fd, chunk, 0, JOURNAL_READ_BYTES, null);
        if (read === 0) break;
        const view = chunk.subarray(0, read);
        if (first) {
          first = false;
          if (startsWithBom(view)) throw new JournalReadError(display, 1);
        }
        let offset = 0;
        while (offset < read) {
          const newline = view.indexOf(0x0a, offset);
          const end = newline < 0 ? read : newline;
          if (!discarding) {
            const room = JOURNAL_ROW_BYTES + 1 - row.length;
            for (let at = offset; at < Math.min(end, offset + room); at += 1) {
              row.push(view[at] as number);
            }
            if (end - offset > room || row.length > JOURNAL_ROW_BYTES) {
              // §25.8/§24.4: surface the ceiling immediately and discard the
              // refused remainder without echoing it.
              throw new JournalReadError(display, number);
            }
          }
          if (newline < 0) break;
          if (!discarding) rows.push([number, decodeRow(row, decoder, display, number)]);
          number += 1;
          row = [];
          discarding = false;
          offset = newline + 1;
        }
      }
      if (row.length > 0) rows.push([number, decodeRow(row, decoder, display, number)]);
    } catch (error) {
      if (error instanceof JournalReadError) throw error;
      throw new JournalReadError(display, null);
    } finally {
      closeQuietly(opened.fd);
    }
    return rows;
  }

  private requireLock(): void {
    if (this.lockFd === null) fail(ReasonCode.LockRequired, ".atlas-lock");
    let own: fs.Stats;
    let current: fs.Stats;
    try {
      own = fs.fstatSync(this.lockFd);
      current = fs.lstatSync(`${this.root}/.atlas-lock`);
    } catch {
      fail(ReasonCode.LockLost, ".atlas-lock");
    }
    if (own.dev !== current.dev || own.ino !== current.ino) {
      fail(ReasonCode.LockLost, ".atlas-lock");
    }
  }
}

/**
 * Release the held lock; null on success, else the failure code.
 *
 * A missing or replaced .atlas-lock means exclusivity was already lost
 * mid-flow (§25.6's lock covers the complete writing flow), so it is
 * `lock-lost`, never silent success.
 */
function releaseLock(lockFd: number, lockPath: string): ReasonCode | null {
  let failure: ReasonCode | null = null;
  try {
    const own = fs.fstatSync(lockFd);
    let current: fs.Stats | null = null;
    try {
      current = fs.lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== null && own.dev === current.dev && own.ino === current.ino) {
      fs.unlinkSync(lockPath);
    } else {
      failure = ReasonCode.LockLost;
    }
  } catch {
    failure = ReasonCode.LockIo;
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {
      failure = failure ?? ReasonCode.LockIo;
    }
  }
  return failure;
}

function decodeRow(
  row: readonly number[],
  decoder: TextDecoder,
  display: string,
  number: number,
): unknown {
  if (row.length === 0) throw new JournalReadError(display, number);
  if (row.includes(0x0d)) throw new JournalReadError(display, number);
  let text: string;
  try {
    text = decoder.decode(new Uint8Array(row));
  } catch {
    throw new JournalReadError(display, number);
  }
  try {
    return parseStrict(text);
  } catch {
    throw new JournalReadError(display, number);
  }
}

/** Write every byte, or report that it could not. */
/** A write that stopped making progress before the data ran out. */
class ShortWrite extends Error {}

function writeFully(fd: number, data: Uint8Array): boolean {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset, null);
    if (written <= 0) return false;
    offset += written;
  }
  return true;
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* the descriptor is going away with the process either way */
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** The current instant as the §25.7 UTC stamp. */
function utcStamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** Refuse anything that is not an explicit, real, symlink-free instance root. */
function validateInstanceRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0) fail(ReasonCode.InvalidRoot);
  const parts = absoluteParts(root);

  let walked = "";
  for (const component of parts) {
    walked += `/${component}`;
    let info: fs.Stats;
    try {
      info = fs.lstatSync(walked);
    } catch {
      fail(ReasonCode.InvalidRoot);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail(ReasonCode.InvalidRoot);
  }
  const resolved = walked === "" ? "/" : walked;
  for (const required of ["atlas", "state"]) {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(`${resolved}/${required}`);
    } catch {
      fail(ReasonCode.InvalidRoot);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail(ReasonCode.InvalidRoot);
  }
  return resolved;
}

/** Construct and lstat a safe path beneath the instance root. */
function safePath(root: string, relativePath: string, allowMissing: boolean): string {
  const parts = pathParts(relativePath);
  if (isAbsolute(relativePath) || parts.includes("..")) fail(ReasonCode.UnsafePath);
  if (parts.length === 0) return root;
  // Ignore paths bind by resolved location (§24.2): they are roots at the
  // instance top level, not banned names — intake/build/ from an opaque source
  // named "build" is legal. Symlinks are refused wholesale below, so the
  // lexical first component is the resolved location.
  if (isIgnoredName(parts[0] as string)) fail(ReasonCode.IgnoredPath);

  const candidate = `${root}/${parts.join("/")}`;
  let walked = root;
  for (const [index, component] of parts.entries()) {
    walked += `/${component}`;
    const final = index === parts.length - 1;
    let info: fs.Stats;
    try {
      info = fs.lstatSync(walked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing && final) {
        return candidate;
      }
      fail(ReasonCode.UnsafePath);
    }
    if (info.isSymbolicLink()) fail(ReasonCode.UnsafePath);
    if (final) {
      if (!info.isDirectory() && !info.isFile()) fail(ReasonCode.UnsafePath);
    } else if (!info.isDirectory()) {
      fail(ReasonCode.UnsafePath);
    }
  }
  return candidate;
}
