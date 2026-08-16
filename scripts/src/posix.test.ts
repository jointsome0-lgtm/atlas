import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { constants as C } from "node:fs";

import {
  AT_REMOVEDIR,
  AT_SYMLINK_NOFOLLOW,
  PosixError,
  exactByteCount,
  isDirectory,
  isRegularFile,
  isSymbolicLink,
  mkdirat,
  O_CLOEXEC,
  openat,
  readdir,
  renameat,
  statat,
  unlinkat,
} from "./posix.ts";

const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | O_CLOEXEC;

let root: string;
let rootFd: number;

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/atlas-posix-test-");
  rootFd = fs.openSync(root, DIR_FLAGS);
});

afterEach(() => {
  fs.closeSync(rootFd);
  fs.rmSync(root, { recursive: true, force: true });
});

/** What the kernel said, for a call that was supposed to fail. */
function refusal(run: () => unknown): PosixError {
  try {
    run();
  } catch (error) {
    if (error instanceof PosixError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused, and it was not");
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const names = (fd: number) => readdir(fd).map(decode).sort();

describe("naming a child of an open directory", () => {
  test("opens the child, not a path that happens to spell it", () => {
    fs.writeFileSync(`${root}/note.txt`, "hello\n");

    const fd = openat(rootFd, "note.txt", C.O_RDONLY | C.O_NOFOLLOW);
    try {
      expect(fs.readFileSync(fd).toString()).toBe("hello\n");
    } finally {
      fs.closeSync(fd);
    }
  });

  test("keeps naming the directory it opened, after the way there changes", () => {
    // The whole reason this boundary exists. A descriptor names a directory;
    // a path names a route to one. Re-resolving the route between two steps
    // can land somewhere else, and nothing in the second step can tell.
    fs.mkdirSync(`${root}/real`);
    fs.mkdirSync(`${root}/decoy`);
    fs.writeFileSync(`${root}/real/x`, "real");
    fs.writeFileSync(`${root}/decoy/x`, "decoy");
    fs.symlinkSync(`${root}/real`, `${root}/door`);

    const doorFd = fs.openSync(`${root}/door`, DIR_FLAGS);
    try {
      // Someone repoints the door between the check and the use.
      fs.unlinkSync(`${root}/door`);
      fs.symlinkSync(`${root}/decoy`, `${root}/door`);

      const fd = openat(doorFd, "x", C.O_RDONLY | C.O_NOFOLLOW);
      try {
        expect(fs.readFileSync(fd).toString()).toBe("real");
      } finally {
        fs.closeSync(fd);
      }

      // The path spelling of the same intent now reads the other file.
      expect(fs.readFileSync(`${root}/door/x`).toString()).toBe("decoy");
    } finally {
      fs.closeSync(doorFd);
    }
  });

  test("refuses a symbolic link when the caller passes O_NOFOLLOW", () => {
    fs.writeFileSync(`${root}/target`, "x");
    fs.symlinkSync(`${root}/target`, `${root}/link`);

    const error = refusal(() => openat(rootFd, "link", C.O_RDONLY | C.O_NOFOLLOW));
    expect(error.code).toBe("ELOOP");
    expect(error.errno).toBe(-40);
    expect(error.syscall).toBe("openat");
  });

  test("follows a symbolic link when the caller does not", () => {
    fs.writeFileSync(`${root}/target`, "followed");
    fs.symlinkSync(`${root}/target`, `${root}/link`);

    const fd = openat(rootFd, "link", C.O_RDONLY);
    try {
      expect(fs.readFileSync(fd).toString()).toBe("followed");
    } finally {
      fs.closeSync(fd);
    }
  });

  test("says which way it failed, not that it failed", () => {
    fs.writeFileSync(`${root}/file`, "x");

    expect(refusal(() => openat(rootFd, "missing", C.O_RDONLY)).code).toBe(
      "ENOENT",
    );
    expect(
      refusal(() => openat(rootFd, "file", C.O_RDONLY | C.O_DIRECTORY)).code,
    ).toBe("ENOTDIR");
    expect(
      refusal(() =>
        openat(rootFd, "file", C.O_CREAT | C.O_EXCL | C.O_WRONLY, 0o600),
      ).code,
    ).toBe("EEXIST");
  });

  test("creates with the mode it was given", () => {
    const fd = openat(
      rootFd,
      "fresh",
      C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW,
      0o600,
    );
    fs.closeSync(fd);
    expect(fs.statSync(`${root}/fresh`).mode & 0o7777).toBe(0o600);
  });

  test("refuses a name holding a NUL rather than shortening it", () => {
    fs.writeFileSync(`${root}/short`, "x");
    expect(() => openat(rootFd, "short\0ignored", C.O_RDONLY)).toThrow(TypeError);
  });

  test("refuses an unpaired surrogate rather than naming another file", () => {
    // An unpaired half has no UTF-8 encoding, so encoding it yields U+FFFD.
    // Left alone, asking for "\uD800" would quietly answer about this file —
    // and the same call through unlinkat would delete it.
    fs.writeFileSync(`${root}/�`, "not the file you asked for");

    expect(() => openat(rootFd, "\uD800", C.O_RDONLY)).toThrow(TypeError);
    expect(() => openat(rootFd, "\uDC00", C.O_RDONLY)).toThrow(TypeError);
    expect(() => unlinkat(rootFd, "a\uD800b")).toThrow(TypeError);
    expect(() => statat(rootFd, "\uD800", AT_SYMLINK_NOFOLLOW)).toThrow(TypeError);

    // The paired form is a real character and stays allowed.
    fs.writeFileSync(`${root}/\u{1F600}`, "emoji");
    expect(statat(rootFd, "\u{1F600}", AT_SYMLINK_NOFOLLOW).size).toBe(5);
    expect(names(rootFd).includes("�")).toBe(true);
  });
});

describe("asking what a name is", () => {
  test("reports the link itself, not what it points at", () => {
    fs.writeFileSync(`${root}/target`, "0123456789");
    fs.symlinkSync(`${root}/target`, `${root}/link`);

    const link = statat(rootFd, "link", AT_SYMLINK_NOFOLLOW);
    expect(isSymbolicLink(link.mode)).toBe(true);
    expect(isRegularFile(link.mode)).toBe(false);

    const target = statat(rootFd, "link", 0);
    expect(isRegularFile(target.mode)).toBe(true);
    expect(target.size).toBe(10);
  });

  test("tells a directory from a file", () => {
    fs.mkdirSync(`${root}/sub`);
    fs.writeFileSync(`${root}/sub/f`, "abc");

    expect(isDirectory(statat(rootFd, "sub", AT_SYMLINK_NOFOLLOW).mode)).toBe(true);
    expect(isRegularFile(statat(rootFd, "sub", AT_SYMLINK_NOFOLLOW).mode)).toBe(false);

    const subFd = openat(rootFd, "sub", DIR_FLAGS | C.O_NOFOLLOW);
    try {
      const f = statat(subFd, "f", AT_SYMLINK_NOFOLLOW);
      expect(isRegularFile(f.mode)).toBe(true);
      expect(f.size).toBe(3);
    } finally {
      fs.closeSync(subFd);
    }
  });

  test("agrees with the size the caller can read back", () => {
    const payload = "x".repeat(4096 + 7);
    fs.writeFileSync(`${root}/big`, payload);
    expect(statat(rootFd, "big", AT_SYMLINK_NOFOLLOW).size).toBe(Buffer.byteLength(payload));
  });

  test("names a missing child ENOENT", () => {
    expect(refusal(() => statat(rootFd, "nope", AT_SYMLINK_NOFOLLOW)).code).toBe(
      "ENOENT",
    );
  });

  test("reports a size it cannot hold exactly instead of rounding it", () => {
    // Tested as a rule rather than through a file: no filesystem available
    // here reaches 2^53 bytes (ext4 stops around 2^44, and Bun's own
    // ftruncate refuses the length), so an integration test would skip
    // silently and read as coverage it never had.
    const limit = BigInt(Number.MAX_SAFE_INTEGER);

    expect(exactByteCount(0n, "empty")).toBe(0);
    expect(exactByteCount(limit, "largest exact")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => exactByteCount(limit + 1n, "one past")).toThrow(RangeError);
    expect(() => exactByteCount(2n ** 63n, "an XFS-sized file")).toThrow(RangeError);

    // The value a plain Number() would have silently produced.
    expect(Number(limit + 1n)).toBe(Number.MAX_SAFE_INTEGER + 1);
  });

  test("gives one errno one name, and the name Bun uses", () => {
    // EAGAIN and EWOULDBLOCK are the same number, as are ENOTSUP and
    // EOPNOTSUPP. A caller branching on Bun's spelling must not miss ours.
    expect(new PosixError("openat", -11).code).toBe("EAGAIN");
    expect(new PosixError("openat", -95).code).toBe("ENOTSUP");
  });
});

describe("moving and removing by descriptor", () => {
  test("moves a name from one open directory to another", () => {
    fs.mkdirSync(`${root}/from`);
    fs.mkdirSync(`${root}/to`);
    fs.writeFileSync(`${root}/from/a`, "payload");

    const fromFd = openat(rootFd, "from", DIR_FLAGS | C.O_NOFOLLOW);
    const toFd = openat(rootFd, "to", DIR_FLAGS | C.O_NOFOLLOW);
    try {
      renameat(fromFd, "a", toFd, "b");
      expect(names(fromFd)).toEqual([]);
      expect(names(toFd)).toEqual(["b"]);
      expect(fs.readFileSync(`${root}/to/b`).toString()).toBe("payload");
    } finally {
      fs.closeSync(fromFd);
      fs.closeSync(toFd);
    }
  });

  test("renames within one directory, which is how a durable write lands", () => {
    fs.writeFileSync(`${root}/.tmp-1`, "new");
    fs.writeFileSync(`${root}/live`, "old");
    renameat(rootFd, ".tmp-1", rootFd, "live");
    expect(fs.readFileSync(`${root}/live`).toString()).toBe("new");
    expect(names(rootFd)).toEqual(["live"]);
  });

  test("removes a file, and needs to be told before it removes a directory", () => {
    fs.writeFileSync(`${root}/f`, "x");
    fs.mkdirSync(`${root}/d`);

    unlinkat(rootFd, "f");
    expect(refusal(() => unlinkat(rootFd, "d")).code).toBe("EISDIR");
    unlinkat(rootFd, "d", AT_REMOVEDIR);
    expect(names(rootFd)).toEqual([]);
  });

  test("creates a directory with the mode it was given", () => {
    mkdirat(rootFd, "made", 0o700);
    expect(fs.statSync(`${root}/made`).mode & 0o7777).toBe(0o700);
    expect(refusal(() => mkdirat(rootFd, "made", 0o700)).code).toBe("EEXIST");
  });
});

describe("listing an open directory", () => {
  test("lists the children and neither of the two names that are not", () => {
    fs.writeFileSync(`${root}/a`, "");
    fs.writeFileSync(`${root}/b`, "");
    fs.mkdirSync(`${root}/c`);
    fs.symlinkSync(`${root}/a`, `${root}/d`);

    expect(names(rootFd)).toEqual(["a", "b", "c", "d"]);
  });

  test("lists nothing for an empty directory", () => {
    expect(readdir(rootFd)).toEqual([]);
  });

  test("leaves the caller's descriptor where it found it", () => {
    fs.writeFileSync(`${root}/a`, "");
    fs.writeFileSync(`${root}/b`, "");

    // A listing that consumed or advanced the descriptor would make the second
    // call disagree with the first.
    expect(names(rootFd)).toEqual(["a", "b"]);
    expect(names(rootFd)).toEqual(["a", "b"]);
    expect(isDirectory(statat(rootFd, "a", AT_SYMLINK_NOFOLLOW).mode)).toBe(false);
  });

  test("grows past its first buffer rather than truncating the answer", () => {
    // 8 KiB is the first attempt; 400 names of 200 bytes is far past it, so a
    // listing that did not retry would come back short.
    const written: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      const name = `${String(index).padStart(4, "0")}-${"n".repeat(200)}`;
      fs.writeFileSync(`${root}/${name}`, "");
      written.push(name);
    }
    expect(names(rootFd)).toEqual(written.sort());
  });

  test("hands back the bytes of a name that is not valid UTF-8", () => {
    // A Linux filename is a byte string. Deciding what to do about one that is
    // not text is a reading rule; the boundary must not decide it by mangling.
    const raw = Buffer.from([0x62, 0xff, 0xfe, 0x62]);
    fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/`), raw]), "");

    const listed = readdir(rootFd);
    expect(listed).toHaveLength(1);
    expect(Buffer.from(listed[0]!).equals(raw)).toBe(true);
  });

  test("keeps a name that is exactly as long as a name may be", () => {
    const longest = "z".repeat(255);
    fs.writeFileSync(`${root}/${longest}`, "");
    expect(names(rootFd)).toEqual([longest]);
  });

  test("refuses a descriptor that is not a directory", () => {
    fs.writeFileSync(`${root}/f`, "x");
    const fd = openat(rootFd, "f", C.O_RDONLY);
    try {
      expect(refusal(() => readdir(fd)).code).toBe("ENOTDIR");
    } finally {
      fs.closeSync(fd);
    }
  });
});
