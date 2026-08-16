// Fail-closed reading of an Atlas-owned tree (§24.2).
//
// The caller declares one root. Every scan and every read rebuilds the whole
// path from that root through directory descriptors, with O_NOFOLLOW at each
// step, so a component that was checked cannot be swapped for a symbolic link
// before it is opened. A directory scan validates every entry before returning
// any of them: a caller must never receive a partial list it could act on.
//
// The containment rules live here, not in the POSIX boundary below (§25.8).
// That layer answers what the kernel said; this one decides what is allowed.

import fs from "node:fs";
import { constants as C } from "node:fs";

import {
  AT_SYMLINK_NOFOLLOW,
  O_CLOEXEC,
  PosixError,
  isDirectory as modeIsDirectory,
  isRegularFile,
  isSymbolicLink,
  openat,
  readdir,
  statat,
} from "./posix.ts";
import { compareCodePoint } from "./ordering.ts";
import { abspath } from "./paths.ts";

export const ReasonCode = {
  InvalidRoot: "invalid-root",
  UnsafePath: "unsafe-path",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

const EXPECTATIONS: Record<ReasonCode, string> = {
  [ReasonCode.InvalidRoot]:
    "an explicit lstat-confirmed directory root with no symlink components",
  [ReasonCode.UnsafePath]:
    "a contained lstat-confirmed regular file or directory with no " +
    "symlinks or special files",
};

/** A reader failure that names a reason and a place, and never content. */
export class ReaderError extends Error {
  readonly reason: ReasonCode;
  readonly relativePath: string;

  constructor(reason: ReasonCode, relativePath = ".") {
    const shown = safeDisplay(relativePath);
    super(`${shown}: ${reason}; expected ${EXPECTATIONS[reason]}`);
    this.name = "ReaderError";
    this.reason = reason;
    this.relativePath = shown;
  }
}

/**
 * A name with anything unprintable replaced, so a diagnostic cannot carry a
 * control sequence out to a terminal (§24.4).
 *
 * "Unprintable" is the oracle's rule: any code point in a category the Unicode
 * database calls Other or Separator, except the ASCII space.
 */
export function safeDisplay(value: string): string {
  let out = "";
  for (const character of value) {
    out += character === " " || !/[\p{C}\p{Z}]/u.test(character) ? character : "?";
  }
  return out;
}

const displayParts = (parts: readonly string[]): string =>
  safeDisplay(parts.join("/") || ".");

// The lstat before each open and the O_NOFOLLOW on it are deliberately
// redundant, and a sequential test cannot show it: remove either one and every
// case still passes, because the other catches the symbolic link. Remove both
// and a symlinked component is followed. They are not the same check — the
// lstat rejects a link that is already there, the flag rejects one that appears
// between the lstat and the open — and only the second failure is a race, which
// is exactly the failure that never shows up in a test.
const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = C.O_RDONLY | C.O_NOFOLLOW | O_CLOEXEC | C.O_NONBLOCK;

/**
 * The components of a relative path, or a refusal.
 *
 * Empty and `.` components are dropped exactly as the oracle's path type drops
 * them, which is why only `..` survives to be rejected here. An absolute path
 * is refused because a root-bound reader has nothing to resolve it against.
 */
export function relativeParts(relativePath: string): string[] {
  if (relativePath.startsWith("/")) {
    throw new ReaderError(ReasonCode.UnsafePath);
  }
  const parts = relativePath
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new ReaderError(ReasonCode.UnsafePath);
  }
  return parts;
}

/**
 * A name as text, or a refusal.
 *
 * A filename on Linux is bytes; Atlas-authored text is UTF-8 (§25.8). A name
 * that is not UTF-8 is refused rather than repaired, because every repair
 * invents a name that is not the one on disk — and a reader that hands back an
 * invented name has stopped being fail-closed. This is a deliberate departure
 * from the oracle, which substitutes surrogates and carries them along.
 */
function nameAsText(bytes: Uint8Array, parts: readonly string[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    const lossy = new TextDecoder().decode(bytes);
    throw new ReaderError(ReasonCode.UnsafePath, [...parts, lossy].join("/"));
  }
}

/** A file the reader found, whose later open repeats every check. */
export class ScannedFile {
  // Written out rather than declared in the parameter list: parameter
  // properties survive type-stripping, so §25.8 bars them.
  private readonly reader: AtlasReader;
  readonly parts: readonly string[];

  constructor(reader: AtlasReader, parts: readonly string[]) {
    this.reader = reader;
    this.parts = parts;
  }

  get name(): string {
    return this.parts[this.parts.length - 1] as string;
  }

  get relativePath(): string {
    return this.parts.join("/");
  }

  get path(): string {
    return this.reader.root === "/"
      ? `/${this.parts.join("/")}`
      : [this.reader.root, ...this.parts].join("/");
  }

  /**
   * A read descriptor, opened no-follow from the root. The caller closes it.
   *
   * For readers that must not hold the whole file: a journal is bounded per
   * row (§25.8) and not in total, so the one check that stays honest on a
   * large one is the one that never materialises it.
   */
  open(): number {
    return this.reader.openFile(this.parts);
  }

  /**
   * The file's bytes, read through a descriptor opened no-follow from the root.
   *
   * The path is walked again rather than remembered: a descriptor handed out
   * earlier would say nothing about what the name points at now.
   */
  readBytes(): Uint8Array {
    const fd = this.open();
    try {
      return new Uint8Array(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  }

  toString(): string {
    return this.path;
  }
}

export interface ScanOptions {
  readonly suffix?: string;
  readonly recursive?: boolean;
}

/** A no-follow scanner and opener bound to one resolved directory root. */
export class AtlasReader {
  readonly root: string;
  private readonly rootParts: readonly string[];

  constructor(root: string) {
    let absolute: string;
    try {
      // `os.path.abspath`, not `path.resolve`: the two differ on a root
      // spelled with exactly two leading slashes, which POSIX and CPython
      // keep and Node collapses. That string is what every diagnostic out of
      // this reader names, so collapsing it would rename the caller's root.
      absolute = abspath(root);
    } catch {
      throw new ReaderError(ReasonCode.InvalidRoot);
    }
    this.rootParts = absolute.split("/").filter((part) => part !== "");
    // Opening the root proves every component is a real directory reached
    // without following a link. The descriptor is closed again: what it proved
    // is that the walk succeeds, and each later walk repeats it.
    fs.closeSync(this.openRoot());
    this.root = absolute;
  }

  isDirectory(relativePath: string): boolean {
    const fd = this.openDirectory(relativeParts(relativePath), true);
    if (fd === null) return false;
    fs.closeSync(fd);
    return true;
  }

  /** Every file under `relativePath`, in one order, after checking them all. */
  scan(relativePath = ".", options: ScanOptions = {}): ScannedFile[] {
    const parts = relativeParts(relativePath);
    const directoryFd = this.openDirectory(parts, true);
    if (directoryFd === null) return [];
    const files: ScannedFile[] = [];
    try {
      this.scanDirectory(directoryFd, parts, options, files);
    } finally {
      fs.closeSync(directoryFd);
    }
    return files;
  }

  /** Whether the directory holds anything, once every entry is lstat-checked. */
  hasEntries(relativePath = "."): boolean {
    const parts = relativeParts(relativePath);
    const directoryFd = this.openDirectory(parts, false) as number;
    try {
      const names = this.listNames(directoryFd, parts);
      for (const name of names) {
        const childParts = [...parts, name];
        const info = this.statChild(directoryFd, name, childParts);
        if (
          isSymbolicLink(info.mode) ||
          !(modeIsDirectory(info.mode) || isRegularFile(info.mode))
        ) {
          throw new ReaderError(ReasonCode.UnsafePath, displayParts(childParts));
        }
      }
      return names.length > 0;
    } finally {
      fs.closeSync(directoryFd);
    }
  }

  optionalFile(relativePath: string): ScannedFile | null {
    const parts = relativeParts(relativePath);
    let fd: number;
    try {
      fd = this.openFile(parts);
    } catch (error) {
      if (error instanceof PosixError && error.code === "ENOENT") return null;
      throw error;
    }
    fs.closeSync(fd);
    return new ScannedFile(this, parts);
  }

  /** @internal — reopened per read so the checks are never stale. */
  openFile(parts: readonly string[]): number {
    if (parts.length === 0) {
      throw new ReaderError(ReasonCode.UnsafePath);
    }
    const name = parts[parts.length - 1] as string;
    const parentFd = this.openDirectory(parts.slice(0, -1), false) as number;
    let fd: number;
    try {
      const info = statat(parentFd, name, AT_SYMLINK_NOFOLLOW);
      if (!isRegularFile(info.mode)) {
        throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
      }
      fd = openat(parentFd, name, FILE_FLAGS);
    } catch (error) {
      // A missing file is the caller's to interpret; anything else is unsafe.
      if (error instanceof PosixError && error.code === "ENOENT") throw error;
      if (error instanceof ReaderError) throw error;
      throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
    } finally {
      fs.closeSync(parentFd);
    }
    try {
      // The name was a regular file a moment ago; this asks the descriptor
      // itself, which cannot have been swapped underneath the answer.
      if (!isRegularFile(fs.fstatSync(fd).mode)) {
        throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
      }
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    return fd;
  }

  private openRoot(): number {
    let directoryFd = fs.openSync("/", DIR_FLAGS);
    try {
      for (const component of this.rootParts) {
        const info = statat(directoryFd, component, AT_SYMLINK_NOFOLLOW);
        if (!modeIsDirectory(info.mode)) {
          throw new ReaderError(ReasonCode.InvalidRoot);
        }
        const next = openat(directoryFd, component, DIR_FLAGS);
        fs.closeSync(directoryFd);
        directoryFd = next;
      }
      return directoryFd;
    } catch (error) {
      fs.closeSync(directoryFd);
      if (error instanceof ReaderError) throw error;
      throw new ReaderError(ReasonCode.InvalidRoot);
    }
  }

  /**
   * A descriptor for `parts` under the root, or null when it is absent and the
   * caller said absence is allowed.
   */
  private openDirectory(
    parts: readonly string[],
    missingOk: boolean,
  ): number | null {
    let directoryFd = this.openRoot();
    try {
      for (const component of parts) {
        let next: number;
        try {
          const info = statat(directoryFd, component, AT_SYMLINK_NOFOLLOW);
          if (!modeIsDirectory(info.mode)) {
            throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
          }
          next = openat(directoryFd, component, DIR_FLAGS);
        } catch (error) {
          if (error instanceof PosixError && error.code === "ENOENT") {
            if (missingOk) {
              fs.closeSync(directoryFd);
              return null;
            }
            throw error;
          }
          throw error;
        }
        fs.closeSync(directoryFd);
        directoryFd = next;
      }
      return directoryFd;
    } catch (error) {
      fs.closeSync(directoryFd);
      if (error instanceof ReaderError) throw error;
      if (error instanceof PosixError && error.code === "ENOENT") throw error;
      throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
    }
  }

  private listNames(
    directoryFd: number,
    parts: readonly string[],
  ): string[] {
    let raw: Uint8Array[];
    try {
      raw = readdir(directoryFd);
    } catch {
      throw new ReaderError(ReasonCode.UnsafePath, displayParts(parts));
    }
    return raw.map((bytes) => nameAsText(bytes, parts));
  }

  private statChild(
    directoryFd: number,
    name: string,
    childParts: readonly string[],
  ): { mode: number; size: number } {
    try {
      return statat(directoryFd, name, AT_SYMLINK_NOFOLLOW);
    } catch {
      throw new ReaderError(ReasonCode.UnsafePath, displayParts(childParts));
    }
  }

  private scanDirectory(
    directoryFd: number,
    parts: readonly string[],
    options: ScanOptions,
    files: ScannedFile[],
  ): void {
    // Sorted by code point, so the list is the same on every machine and every
    // filesystem — readdir order is neither.
    const names = this.listNames(directoryFd, parts).sort(compareCodePoint);

    for (const name of names) {
      const childParts = [...parts, name];
      const info = this.statChild(directoryFd, name, childParts);

      if (isSymbolicLink(info.mode)) {
        throw new ReaderError(ReasonCode.UnsafePath, displayParts(childParts));
      }
      if (modeIsDirectory(info.mode)) {
        if (options.recursive === true) {
          let childFd: number;
          try {
            childFd = openat(directoryFd, name, DIR_FLAGS);
          } catch {
            throw new ReaderError(
              ReasonCode.UnsafePath,
              displayParts(childParts),
            );
          }
          try {
            this.scanDirectory(childFd, childParts, options, files);
          } finally {
            fs.closeSync(childFd);
          }
        }
        continue;
      }
      if (!isRegularFile(info.mode)) {
        throw new ReaderError(ReasonCode.UnsafePath, displayParts(childParts));
      }
      if (options.suffix === undefined || name.endsWith(options.suffix)) {
        files.push(new ScannedFile(this, childParts));
      }
    }
  }
}
