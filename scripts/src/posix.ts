// The Bun side of the POSIX boundary (native/atlas-posix).
//
// Bun reaches everything that takes a descriptor — fstat, fsync, ftruncate,
// close, read and write at an explicit offset — and reports errno faithfully.
// What it cannot spell is naming a child *relative to an open directory*, or
// listing a directory it already holds open. Re-resolving a path from its root
// at every step is not the same operation: a component checked in one step can
// be a different file by the next. So these six calls cross into Rust and
// nothing else does.
//
// There is deliberately no fallback. If the library is missing this module
// throws; it does not quietly resolve by path instead, because the quiet
// version would be the unsafe one and nobody would see it happen.

import { dlopen, FFIType, suffix } from "bun:ffi";
import os from "node:os";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

// The Linux ABI numbers this module needs and Bun does not name. They are
// written out rather than looked up because there is nowhere to look them up:
// `node:fs` publishes O_NOFOLLOW and O_DIRECTORY but neither the AT_ family nor
// O_CLOEXEC, and a constant that is silently absent reads as zero — which for
// AT_SYMLINK_NOFOLLOW would mean following the link it was passed to refuse.

// AT_FDCWD is deliberately absent. It is the one descriptor value that turns
// these calls back into path resolution from the working directory — the thing
// Bun already does and this boundary exists to avoid.

/** Report the link itself rather than what it points at. */
export const AT_SYMLINK_NOFOLLOW = 0x100;
/** Make `unlinkat` behave as `rmdir`. */
export const AT_REMOVEDIR = 0x200;
/** Do not leak the descriptor into anything this process goes on to exec. */
export const O_CLOEXEC = 0o2_000_000;

export const S_IFMT = fsConstants.S_IFMT;
export const S_IFREG = fsConstants.S_IFREG;
export const S_IFDIR = fsConstants.S_IFDIR;
export const S_IFLNK = fsConstants.S_IFLNK;

export const isRegularFile = (mode: number): boolean =>
  (mode & S_IFMT) === S_IFREG;
export const isDirectory = (mode: number): boolean =>
  (mode & S_IFMT) === S_IFDIR;
export const isSymbolicLink = (mode: number): boolean =>
  (mode & S_IFMT) === S_IFLNK;

/**
 * A syscall that failed, carrying what the kernel said rather than a sentence
 * about it.
 *
 * `code` and `errno` are shaped like Bun's own filesystem errors — the same
 * name, the same negative `errno` — so a caller handling `ENOENT` does not
 * care which side of the boundary it came from.
 */
export class PosixError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly syscall: string;

  constructor(syscall: string, errno: number) {
    const code = errnoName(errno);
    super(`${syscall} failed: ${code}`);
    this.name = "PosixError";
    this.code = code;
    this.errno = errno;
    this.syscall = syscall;
  }
}

// Two errno values have two names apiece — EAGAIN/EWOULDBLOCK and
// ENOTSUP/EOPNOTSUPP are the same number — so building this table by
// assignment would let whichever came last decide, and a caller matching on
// Bun's own `EAGAIN` would silently miss ours. First name wins, which is the
// one Bun reports.
const ERRNO_NAMES: ReadonlyMap<number, string> = new Map();
for (const [name, value] of Object.entries(os.constants.errno)) {
  if (!ERRNO_NAMES.has(value)) {
    (ERRNO_NAMES as Map<number, string>).set(value, name);
  }
}

/** The kernel's name for a negative errno, or the number if it has none. */
function errnoName(errno: number): string {
  return ERRNO_NAMES.get(-errno) ?? `errno ${-errno}`;
}

// `fileURLToPath`, not `.pathname`: the URL keeps a checkout at
// `/home/a/Atlas Project` in its escaped form, `Atlas%20Project`, which names
// nothing on disk. `dlopen` would then fail on a machine whose only sin is a
// space in a directory name, and every caller would be told the boundary was
// never built.
const LIBRARY_PATH = fileURLToPath(
  new URL(
    `../../native/atlas-posix/target/release/libatlas_posix.${suffix}`,
    import.meta.url,
  ),
);

const SIGNATURES = {
  atlas_openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
    returns: FFIType.i64_fast,
  },
  atlas_statat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64_fast,
  },
  atlas_renameat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i64_fast,
  },
  atlas_unlinkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i64_fast,
  },
  atlas_mkdirat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i64_fast,
  },
  atlas_readdir: {
    // `size_t` is `u64` on every target this crate is built for; Bun has no
    // separate spelling for a word-sized length.
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64_fast,
  },
} as const;

type Library = ReturnType<typeof dlopen<typeof SIGNATURES>>["symbols"];

let loaded: Library | undefined;

function library(): Library {
  if (loaded !== undefined) return loaded;
  try {
    loaded = dlopen(LIBRARY_PATH, SIGNATURES).symbols;
  } catch (cause) {
    throw new Error(
      `the POSIX boundary is not built: expected ${LIBRARY_PATH}. ` +
        `Run: bun run build:native`,
      { cause },
    );
  }
  return loaded;
}

const encoder = new TextEncoder();

/**
 * A name as C will see it: its bytes, then a terminator.
 *
 * Two things are refused here, and both are refused because the alternative is
 * not an error but a *different file*. A NUL would arrive truncated. An
 * unpaired surrogate has no UTF-8 encoding, so `TextEncoder` substitutes
 * U+FFFD — which means `unlinkat(fd, "\uD800")` would delete a file actually
 * named U+FFFD, quietly and successfully. The JSON writer refuses the same
 * half-character for the same reason.
 *
 * Whether a name may contain a separator, or be `..`, is the caller's rule to
 * keep; this layer guarantees only that what arrives is what was asked for.
 */
function terminated(name: string): Uint8Array {
  for (const character of name) {
    // Iterating by code point means a well-formed pair arrives as one
    // character above 0xFFFF; only an unpaired half lands in this range.
    const point = character.codePointAt(0) as number;
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new TypeError(
        "a path may not contain an unpaired surrogate: it has no encoding, " +
          "and encoding it anyway would name a different file",
      );
    }
    if (point === 0) {
      throw new TypeError("a path may not contain a NUL byte");
    }
  }
  const bytes = encoder.encode(name);
  const buffer = new Uint8Array(bytes.length + 1);
  buffer.set(bytes);
  return buffer;
}

/**
 * The kernel's answer as a number, or the kernel's refusal as an error.
 *
 * Bun hands back `number | bigint` for a 64-bit return, widening only past
 * `Number.MAX_SAFE_INTEGER`. Every value crossing here is a descriptor, a zero,
 * a negative errno, or the byte length of one directory listing, so none of
 * them reach that far.
 */
function check(syscall: string, result: number | bigint): number {
  const value = Number(result);
  if (value < 0) throw new PosixError(syscall, value);
  return value;
}

/**
 * Open `name` inside the already-open directory `dirfd`.
 *
 * The flags are the caller's, including `O_NOFOLLOW`: this layer does not
 * decide what containment means. Returns a descriptor the caller must close.
 */
export function openat(
  dirfd: number,
  name: string,
  flags: number,
  mode = 0,
): number {
  return check(
    "openat",
    library().atlas_openat(dirfd, terminated(name), flags, mode),
  );
}

/**
 * What `name` is and how large.
 *
 * `flags` is required and has no default: whether to follow a symbolic link is
 * the containment question this whole boundary exists to let the caller answer,
 * and a default would be this layer answering it on their behalf.
 */
export function statat(
  dirfd: number,
  name: string,
  flags: number,
): { mode: number; size: number } {
  const mode = new Uint32Array(1);
  const size = new BigUint64Array(1);
  check("statat", library().atlas_statat(dirfd, terminated(name), flags, mode, size));
  return { mode: mode[0]!, size: exactByteCount(size[0]!, name) };
}

/**
 * A `u64` byte count as a number, or a refusal.
 *
 * Narrowing to a double is lossless up to 2^53 and silently wrong past it, and
 * a caller sizing a read from a rounded length would be handed a plausible
 * number rather than an error. No filesystem Atlas is tested on can reach that
 * size — ext4 stops around 2^44 — but XFS and Btrfs can, so the difference
 * between "impossible" and "unchecked" is one that only shows up on someone
 * else's disk.
 */
export function exactByteCount(raw: bigint, what: string): number {
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${what} is ${raw} bytes, past what a JavaScript number holds exactly`,
    );
  }
  return Number(raw);
}

/** Move `oldName` under `oldDirfd` to `newName` under `newDirfd`. */
export function renameat(
  oldDirfd: number,
  oldName: string,
  newDirfd: number,
  newName: string,
): void {
  check(
    "renameat",
    library().atlas_renameat(
      oldDirfd,
      terminated(oldName),
      newDirfd,
      terminated(newName),
    ),
  );
}

/** Remove `name` inside `dirfd`; pass `AT_REMOVEDIR` for a directory. */
export function unlinkat(dirfd: number, name: string, flags = 0): void {
  check("unlinkat", library().atlas_unlinkat(dirfd, terminated(name), flags));
}

/** Create a directory `name` inside `dirfd`. */
export function mkdirat(dirfd: number, name: string, mode: number): void {
  check("mkdirat", library().atlas_mkdirat(dirfd, terminated(name), mode));
}

const FIRST_LISTING_BUFFER = 8192;

/**
 * The names directly inside `dirfd`, as raw bytes, in the order the filesystem
 * gave them.
 *
 * Bytes, not strings: a filename on Linux is a byte string that is usually but
 * not always UTF-8, and deciding what to do about the exception is a reading
 * rule, not a syscall. Order is likewise left alone — sorting is meaning.
 * `.` and `..` are absent; they are the two names that are not children.
 */
export function readdir(dirfd: number): Uint8Array[] {
  const symbols = library();
  let buffer = new Uint8Array(FIRST_LISTING_BUFFER);
  let needed = check("readdir", symbols.atlas_readdir(dirfd, buffer, buffer.length));

  // A directory can grow between the sizing and the read, so this is a loop and
  // not a single retry.
  while (needed > buffer.length) {
    buffer = new Uint8Array(needed);
    needed = check("readdir", symbols.atlas_readdir(dirfd, buffer, buffer.length));
  }

  const names: Uint8Array[] = [];
  let offset = 0;
  while (offset < needed) {
    const length = buffer[offset]! | (buffer[offset + 1]! << 8);
    offset += 2;
    names.push(buffer.slice(offset, offset + length));
    offset += length;
  }
  return names;
}
