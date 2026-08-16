import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as C } from "node:fs";

import {
  AT_SYMLINK_NOFOLLOW,
  PosixError,
  O_CLOEXEC,
  openat,
  readdir,
  statat,
} from "../src/posix.ts";

// Compares the POSIX boundary against the calls the reference implementation
// makes — `os.scandir(fd)`, `os.stat(..., dir_fd=, follow_symlinks=False)`,
// `os.open(..., dir_fd=)`. The boundary exists because Bun cannot spell those,
// so "it works" is not enough: it has to answer what CPython answers, name for
// name, mode for mode, errno for errno. A boundary that agreed about the happy
// path and disagreed about ELOOP would be worse than none, because the reader
// above it decides containment from exactly that difference.
//
// Alone among the harnesses this one cannot have its oracle written down: a
// mode carries the umask of the machine that ran it and a directory's size is
// the filesystem's business, so a recording would freeze this laptop rather
// than the answer. What it gets instead is a second partner that is here at
// runtime — `node:fs`, reaching the same files by path instead of by
// descriptor. Both are asked while CPython is still installed, which is what
// earns the right to keep only the second one afterwards.
//
// What the surviving partner cannot check is the `*at`-ness itself: nothing
// else in the runtime can spell a directory-relative call, so after the
// cutover the descriptor-relative form is proven equal to the path form over
// this tree, not proven to be resolving relative to the descriptor. That is
// the reader's containment tests' job (scripts/differential/reader.ts), which
// build trees where the two answers must differ.

const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | O_CLOEXEC;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Names sorted the way the oracle sorts them: by their bytes.
 *
 * Base64 is a transport, and sorting the transport is not sorting the names —
 * the two orders disagree, which is how this was noticed.
 */
function byBytes(names: Uint8Array[]): Uint8Array[] {
  return [...names].sort((left, right) => Buffer.compare(left, right));
}

/** The oracle joins a directory and a name with a NUL, which no name holds. */
const keyFor = (relative: string, encoded: string): string =>
  `${relative}${String.fromCharCode(0)}${encoded}`;

/** A tree with the shapes a reader actually meets, plus the awkward ones. */
function buildTree(root: string): string[] {
  const directories: string[] = ["."];

  writeFileSync(`${root}/empty.md`, "");
  writeFileSync(`${root}/small.md`, "abc");
  writeFileSync(`${root}/exact-4096.md`, "x".repeat(4096));
  writeFileSync(`${root}/odd-4097.md`, "x".repeat(4097));

  mkdirSync(`${root}/concepts`);
  directories.push("concepts");
  for (const name of ["alpha.md", "beta.md", "gamma.md"]) {
    writeFileSync(`${root}/concepts/${name}`, name);
  }

  mkdirSync(`${root}/empty-dir`);
  directories.push("empty-dir");

  mkdirSync(`${root}/nested`);
  mkdirSync(`${root}/nested/deeper`);
  directories.push("nested", "nested/deeper");
  writeFileSync(`${root}/nested/deeper/leaf.md`, "leaf");

  // Links: to a file, to a directory, and to nothing at all. The third is the
  // one that separates "stat the link" from "stat what it names".
  symlinkSync(`${root}/small.md`, `${root}/link-to-file`);
  symlinkSync(`${root}/concepts`, `${root}/link-to-dir`);
  symlinkSync(`${root}/nowhere`, `${root}/link-dangling`);
  symlinkSync("relative.md", `${root}/link-relative`);

  // A name that is bytes rather than text, and the longest a name may be.
  writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x6e, 0xff, 0xfe, 0x2e, 0x6d, 0x64])]), "raw");
  writeFileSync(`${root}/${"z".repeat(255)}`, "longest");

  // Enough entries, long enough, to push the listing past its first buffer.
  mkdirSync(`${root}/wide`);
  directories.push("wide");
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(`${root}/wide/${String(index).padStart(4, "0")}-${"n".repeat(180)}`, "");
  }

  return directories;
}

interface Answer {
  readonly listing?: string[];
  readonly stat?: { mode: number; size: number } | { errno: number };
  readonly follow?: { mode: number; size: number } | { errno: number };
  readonly open?: { ok: true } | { errno: number };
}

const ORACLE = `
import base64, json, os, sys

root = sys.stdin.readline().strip()
directories = json.loads(sys.stdin.read())

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC

def describe(fn):
    try:
        info = fn()
    except OSError as exc:
        return {"errno": exc.errno}
    return {"mode": info.st_mode, "size": info.st_size}

out = {}
for relative in directories:
    path = root if relative == "." else os.path.join(root, relative)
    fd = os.open(path, DIR_FLAGS)
    try:
        with os.scandir(fd) as entries:
            names = sorted(os.fsencode(entry.name) for entry in entries)
        out[relative] = {"listing": [base64.b64encode(n).decode() for n in names]}
        for name in names:
            key = relative + "\\x00" + base64.b64encode(name).decode()
            entry = {}
            entry["stat"] = describe(
                lambda: os.stat(name, dir_fd=fd, follow_symlinks=False)
            )
            entry["follow"] = describe(
                lambda: os.stat(name, dir_fd=fd, follow_symlinks=True)
            )
            try:
                opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as exc:
                entry["open"] = {"errno": exc.errno}
            else:
                os.close(opened)
                entry["open"] = {"ok": True}
            out[key] = entry
    finally:
        os.close(fd)

json.dump(out, sys.stdout)
`;

/**
 * The same questions asked of `node:fs`, which reaches a name by path because
 * it has no way to reach one by descriptor.
 *
 * Its errno arrives negative and CPython's arrives positive; the sign is a
 * calling convention, not an answer, so it is normalised here rather than
 * being allowed to look like a divergence.
 */
function askNodeFs(root: string, directories: readonly string[]): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const describe = (fn: () => { mode: number; size: number }) => {
    try {
      return fn();
    } catch (error) {
      return { errno: -(error as NodeJS.ErrnoException & { errno: number }).errno };
    }
  };

  for (const relative of directories) {
    const path = relative === "." ? root : `${root}/${relative}`;
    const names = byBytes(readdirSync(path, { encoding: "buffer" }));
    out[relative] = { listing: names.map(b64) };

    for (const name of names) {
      const full = Buffer.concat([Buffer.from(`${path}/`), name]);
      const entry: { stat?: Answer["stat"]; follow?: Answer["follow"]; open?: Answer["open"] } = {};
      entry.stat = describe(() => {
        const info = lstatSync(full);
        return { mode: info.mode, size: info.size };
      });
      entry.follow = describe(() => {
        const info = statSync(full);
        return { mode: info.mode, size: info.size };
      });
      try {
        const opened = openSync(full, C.O_RDONLY | C.O_NOFOLLOW);
        closeSync(opened);
        entry.open = { ok: true };
      } catch (error) {
        entry.open = { errno: -(error as NodeJS.ErrnoException & { errno: number }).errno };
      }
      out[keyFor(relative, b64(name))] = entry;
    }
  }
  return out;
}

const root = mkdtempSync("/tmp/atlas-posix-differential-");
let comparisons = 0;
let divergences = 0;

function compare(partner: string, what: string, ours: unknown, theirs: unknown): void {
  comparisons += 1;
  const a = JSON.stringify(ours);
  const b = JSON.stringify(theirs);
  if (a !== b) {
    divergences += 1;
    console.error(`  ${what}\n    ours:   ${a}\n    ${partner}: ${b}`);
  }
}

function askCPython(root: string, directories: readonly string[]): Record<string, Answer> {
  const run = Bun.spawnSync(["python3", "-c", ORACLE], {
    stdin: Buffer.from(`${root}\n${JSON.stringify(directories)}`),
  });
  if (run.exitCode !== 0) {
    console.error(run.stderr.toString());
    throw new Error("the oracle refused to answer");
  }
  return JSON.parse(run.stdout.toString()) as Record<string, Answer>;
}

try {
  const directories = buildTree(root);

  // Both partners answer the same tree in the same run, so a mode and a
  // directory size mean the same thing to all three. The CPython arm is what
  // goes at the cutover; the `node:fs` arm is what is left holding this.
  const partners: ReadonlyArray<{ name: string; answers: Record<string, Answer> }> = [
    { name: "cpython", answers: askCPython(root, directories) },
    { name: "node:fs", answers: askNodeFs(root, directories) },
  ];

  for (const relative of directories) {
    const path = relative === "." ? root : `${root}/${relative}`;
    const fd = openSync(path, DIR_FLAGS);
    try {
      const listed = byBytes(readdir(fd)).map(b64);
      for (const partner of partners) {
        compare(partner.name, `${relative}: listing`, listed, partner.answers[relative]?.listing);
      }

      for (const encoded of listed) {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");

        // A name that is not UTF-8 cannot be spelled as a JS string without
        // loss, so those entries are compared as a listing only — the boundary
        // takes a string, and inventing one here would test the invention.
        if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
          continue;
        }

        const attempt = (flags: number) => {
          try {
            return statat(fd, decoded, flags);
          } catch (error) {
            return { errno: -(error as PosixError).errno };
          }
        };
        const ourStat = attempt(AT_SYMLINK_NOFOLLOW);
        const ourFollow = attempt(0);

        let opened: { ok: true } | { errno: number };
        try {
          const child = openat(fd, decoded, C.O_RDONLY | C.O_NOFOLLOW);
          closeSync(child);
          opened = { ok: true };
        } catch (error) {
          opened = { errno: -(error as PosixError).errno };
        }

        for (const partner of partners) {
          const theirs = partner.answers[keyFor(relative, encoded)];
          compare(partner.name, `${relative}/${decoded}: stat`, ourStat, theirs?.stat);
          compare(partner.name, `${relative}/${decoded}: follow`, ourFollow, theirs?.follow);
          compare(partner.name, `${relative}/${decoded}: open`, opened, theirs?.open);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  divergences === 0
    ? `posix: ${comparisons} comparisons agree across ours, cpython and node:fs`
    : `posix: ${divergences} of ${comparisons} comparisons diverged`,
);
process.exit(divergences === 0 ? 0 : 1);
