import fs from "node:fs";
import { constants as C } from "node:fs";

import { AtlasReader, ReaderError, safeDisplay } from "../src/reader.ts";

// Compares the ported §24.2 reader against the reference one on the same tree.
// A fail-closed reader is defined by what it refuses and by the exact reason it
// gives, so every case is compared three ways at once: what came back, whether
// it was refused, and the diagnostic word for word. A reader that refused the
// right trees for the wrong reason would pass an accept/reject-only harness,
// and the reason is what a caller and an operator both act on.

interface Case {
  readonly name: string;
  /** How the tree differs from the shared baseline. */
  readonly build?: (root: string) => void;
  readonly call: string;
  /** Set when the two are known to disagree, with the reason recorded. */
  readonly oracleDiffers?: string;
}

const CASES: readonly Case[] = [
  { name: "scan root", call: "scan()" },
  { name: "scan root recursive", call: "scan('.', recursive=True)" },
  { name: "scan root suffix", call: "scan('.', suffix='.md')" },
  { name: "scan root recursive suffix", call: "scan('.', suffix='.md', recursive=True)" },
  { name: "scan subdirectory", call: "scan('concepts')" },
  { name: "scan nested", call: "scan('nested/deeper')" },
  { name: "scan missing", call: "scan('nowhere')" },
  { name: "scan missing nested", call: "scan('nested/nowhere')" },
  { name: "scan empty directory", call: "scan('empty-dir')" },
  { name: "scan through a file", call: "scan('small.md')" },
  { name: "scan a doubled separator", call: "scan('nested//deeper')" },
  { name: "scan a dot component", call: "scan('nested/./deeper')" },
  { name: "scan a parent component", call: "scan('nested/../concepts')" },
  { name: "scan an absolute path", call: "scan('/etc')" },
  { name: "scan a bare parent", call: "scan('..')" },
  { name: "scan the empty string", call: "scan('')" },

  { name: "has entries", call: "has_entries()" },
  { name: "has entries empty", call: "has_entries('empty-dir')" },
  { name: "has entries missing", call: "has_entries('nowhere')" },
  { name: "has entries nested", call: "has_entries('nested')" },

  { name: "is directory", call: "is_directory('concepts')" },
  { name: "is directory on a file", call: "is_directory('small.md')" },
  { name: "is directory missing", call: "is_directory('nowhere')" },

  { name: "optional file", call: "optional_file('small.md')" },
  { name: "optional file missing", call: "optional_file('nowhere.md')" },
  { name: "optional file nested", call: "optional_file('nested/deeper/leaf.md')" },
  { name: "optional file on a directory", call: "optional_file('concepts')" },
  { name: "optional file through a missing directory", call: "optional_file('nowhere/x.md')" },
  { name: "read a file", call: "read('small.md')" },
  { name: "read a nested file", call: "read('nested/deeper/leaf.md')" },

  // Every hazard the reader exists to refuse.
  {
    name: "a symlink to a file in the scan",
    build: (root) => fs.symlinkSync(`${root}/small.md`, `${root}/hazard`),
    call: "scan()",
  },
  {
    name: "a symlink to a directory in the scan",
    build: (root) => fs.symlinkSync(`${root}/concepts`, `${root}/hazard`),
    call: "scan()",
  },
  {
    name: "a dangling symlink in the scan",
    build: (root) => fs.symlinkSync(`${root}/nowhere`, `${root}/hazard`),
    call: "scan()",
  },
  {
    name: "a symlink deeper in a recursive scan",
    build: (root) => fs.symlinkSync(`${root}/small.md`, `${root}/nested/hazard`),
    call: "scan('.', recursive=True)",
  },
  {
    name: "a symlink deeper, non-recursive, is not reached",
    build: (root) => fs.symlinkSync(`${root}/small.md`, `${root}/nested/hazard`),
    call: "scan()",
  },
  {
    name: "a fifo in the scan",
    build: (root) => Bun.spawnSync(["mkfifo", `${root}/hazard`]),
    call: "scan()",
  },
  {
    name: "a fifo seen by has_entries",
    build: (root) => Bun.spawnSync(["mkfifo", `${root}/hazard`]),
    call: "has_entries()",
  },
  {
    name: "a symlinked directory component",
    build: (root) => fs.symlinkSync(`${root}/concepts`, `${root}/door`),
    call: "scan('door')",
  },
  {
    name: "a file reached through a symlinked directory",
    build: (root) => fs.symlinkSync(`${root}/concepts`, `${root}/door`),
    call: "optional_file('door/alpha.md')",
  },
  {
    name: "a symlinked file opened directly",
    build: (root) => fs.symlinkSync(`${root}/small.md`, `${root}/hazard.md`),
    call: "optional_file('hazard.md')",
  },
  {
    name: "a name that is not UTF-8",
    build: (root) =>
      fs.writeFileSync(
        Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64])]),
        "raw",
      ),
    call: "scan()",
    // The oracle decodes with surrogateescape and hands back a name that is
    // not the one on disk and cannot be written back as text. §25.8 makes
    // Atlas-authored text UTF-8; a reader that invents a name has stopped
    // being fail-closed, so the port refuses it as unsafe-path. Recorded
    // rather than hidden (#126): the one place the two disagree.
    oracleDiffers: "the oracle substitutes surrogates instead of refusing",
  },
  {
    name: "an unreadable directory",
    build: (root) => {
      fs.mkdirSync(`${root}/locked`);
      fs.writeFileSync(`${root}/locked/inside.md`, "x");
      fs.chmodSync(`${root}/locked`, 0o000);
    },
    call: "scan('locked')",
  },
];

const ORACLE = `
import json, os, sys
sys.path.insert(0, "scripts")
from atlas_reader import AtlasReader, ReaderError

payload = json.loads(sys.stdin.read())

def run(reader, call):
    if call.startswith("read("):
        name = call[6:-2]
        return {"bytes": reader.optional_file(name).read_bytes().decode()}
    result = eval("reader." + call)
    if isinstance(result, list):
        return {"files": ["/".join(f.parts) for f in result]}
    if result is None:
        return {"file": None}
    if isinstance(result, bool):
        return {"value": result}
    return {"file": "/".join(result.parts)}

out = []
for case in payload:
    try:
        reader = AtlasReader(case["root"])
    except ReaderError as exc:
        out.append({"error": str(exc)})
        continue
    try:
        out.append(run(reader, case["call"]))
    except ReaderError as exc:
        out.append({"error": str(exc)})
    except FileNotFoundError:
        out.append({"missing": True})
    except PermissionError:
        out.append({"denied": True})

json.dump(out, sys.stdout)
`;

/** The tree every case starts from, before its own hazard is added. */
function baseline(root: string): void {
  fs.writeFileSync(`${root}/small.md`, "abc");
  fs.writeFileSync(`${root}/other.txt`, "text");
  fs.mkdirSync(`${root}/concepts`);
  fs.writeFileSync(`${root}/concepts/alpha.md`, "a");
  fs.writeFileSync(`${root}/concepts/beta.md`, "b");
  fs.writeFileSync(`${root}/concepts/gamma.txt`, "g");
  fs.mkdirSync(`${root}/empty-dir`);
  fs.mkdirSync(`${root}/nested`);
  fs.mkdirSync(`${root}/nested/deeper`);
  fs.writeFileSync(`${root}/nested/deeper/leaf.md`, "leaf");
  fs.writeFileSync(`${root}/Zebra.md`, "Z");
  fs.writeFileSync(`${root}/apple.md`, "a");
  fs.writeFileSync(`${root}/éclair.md`, "e");
  // These two are the whole reason the scan sorts by code point rather than by
  // JavaScript's default. An astral character is a surrogate pair whose first
  // code unit is 0xD83D, which sorts *below* U+FFFD as code units and *above*
  // it as code points — so without both names present, a default sort passes.
  fs.writeFileSync(`${root}/\u{1F600}.md`, "astral");
  fs.writeFileSync(`${root}/�.md`, "replacement");
}

/** The port's answer to one case, in the oracle's shape. */
function ours(root: string, call: string): Record<string, unknown> {
  let reader: AtlasReader;
  try {
    reader = new AtlasReader(root);
  } catch (error) {
    return { error: (error as Error).message };
  }
  try {
    const match = /^(\w+)\((.*)\)$/.exec(call) as RegExpExecArray;
    const verb = match[1] as string;
    const argumentText = match[2] as string;

    const positional = /^'([^']*)'/.exec(argumentText);
    const target = positional === null ? "." : (positional[1] as string);
    const recursive = argumentText.includes("recursive=True");
    const suffixMatch = /suffix='([^']*)'/.exec(argumentText);
    const suffix = suffixMatch === null ? undefined : (suffixMatch[1] as string);

    switch (verb) {
      case "scan":
        return {
          files: reader
            .scan(target, { recursive, suffix })
            .map((file) => file.parts.join("/")),
        };
      case "has_entries":
        return { value: reader.hasEntries(target) };
      case "is_directory":
        return { value: reader.isDirectory(target) };
      case "optional_file": {
        const found = reader.optionalFile(target);
        return { file: found === null ? null : found.parts.join("/") };
      }
      case "read": {
        const found = reader.optionalFile(target) as NonNullable<
          ReturnType<AtlasReader["optionalFile"]>
        >;
        return { bytes: new TextDecoder().decode(found.readBytes()) };
      }
      default:
        throw new Error(`the harness cannot run ${verb}`);
    }
  } catch (error) {
    if (error instanceof ReaderError) return { error: error.message };
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { missing: true };
    if (code === "EACCES") return { denied: true };
    throw error;
  }
}

const roots: string[] = [];
let comparisons = 0;
let divergences = 0;
let recorded = 0;

try {
  // Each case gets its own tree: a hazard left behind would silently change
  // the case after it, and a shared tree is how that goes unnoticed.
  for (const testCase of CASES) {
    const root = fs.mkdtempSync("/tmp/atlas-reader-differential-");
    roots.push(root);
    baseline(root);
    testCase.build?.(root);
  }

  const oracleRun = Bun.spawnSync(["python3", "-c", ORACLE], {
    stdin: Buffer.from(
      JSON.stringify(
        CASES.map((testCase, index) => ({
          root: roots[index],
          call: testCase.call,
        })),
      ),
    ),
  });
  if (oracleRun.exitCode !== 0) {
    console.error(oracleRun.stderr.toString());
    throw new Error("the oracle refused to answer");
  }
  const oracle = JSON.parse(oracleRun.stdout.toString()) as Record<
    string,
    unknown
  >[];

  CASES.forEach((testCase, index) => {
    comparisons += 1;
    const mine = JSON.stringify(ours(roots[index] as string, testCase.call));
    const theirs = JSON.stringify(oracle[index]);
    const agree = mine === theirs;

    if (testCase.oracleDiffers !== undefined) {
      recorded += 1;
      if (agree) {
        divergences += 1;
        console.error(
          `  ${testCase.name}: recorded as differing (${testCase.oracleDiffers}) ` +
            `but the two now agree — retire the note`,
        );
      }
      return;
    }
    if (!agree) {
      divergences += 1;
      console.error(
        `  ${testCase.name}\n    ours:   ${mine}\n    oracle: ${theirs}`,
      );
    }
  });

  // The diagnostic sanitiser is compared on its own: it decides what a
  // terminal is allowed to receive, and no tree case reaches its edges.
  const SANITISE = [
    "plain.md",
    "with space.md",
    "tab\there",
    "newline\nhere",
    "bellhere",
    "escapehere",
    "nbsp here",
    "zwj‍here",
    "rtl‮here",
    "emoji\u{1F600}here",
    "éclair",
    "line sep",
  ];
  const sanitiseRun = Bun.spawnSync(["python3", "-c", `
import json, sys
values = json.loads(sys.stdin.read())
def safe(v):
    return "".join(c if c.isprintable() else "?" for c in v)
json.dump([safe(v) for v in values], sys.stdout)
`], { stdin: Buffer.from(JSON.stringify(SANITISE)) });
  const theirSafe = JSON.parse(sanitiseRun.stdout.toString()) as string[];
  SANITISE.forEach((value, index) => {
    comparisons += 1;
    if (safeDisplay(value) !== theirSafe[index]) {
      divergences += 1;
      console.error(
        `  safeDisplay(${JSON.stringify(value)})\n` +
          `    ours:   ${JSON.stringify(safeDisplay(value))}\n` +
          `    oracle: ${JSON.stringify(theirSafe[index])}`,
      );
    }
  });

  // Roots the reader must refuse before it reads anything.
  const bad = fs.mkdtempSync("/tmp/atlas-reader-roots-");
  roots.push(bad);
  fs.writeFileSync(`${bad}/file`, "x");
  fs.mkdirSync(`${bad}/real`);
  fs.symlinkSync(`${bad}/real`, `${bad}/link`);
  const ROOTS = [`${bad}/file`, `${bad}/link`, `${bad}/missing`, `${bad}/real`];
  const rootRun = Bun.spawnSync(["python3", "-c", ORACLE], {
    stdin: Buffer.from(
      JSON.stringify(ROOTS.map((root) => ({ root, call: "is_directory('.')" }))),
    ),
  });
  const theirRoots = JSON.parse(rootRun.stdout.toString()) as Record<
    string,
    unknown
  >[];
  ROOTS.forEach((root, index) => {
    comparisons += 1;
    const mine = JSON.stringify(ours(root, "is_directory('.')"));
    const theirs = JSON.stringify(theirRoots[index]);
    if (mine !== theirs) {
      divergences += 1;
      console.error(`  root ${index}\n    ours:   ${mine}\n    oracle: ${theirs}`);
    }
  });
} finally {
  for (const root of roots) {
    try {
      fs.chmodSync(`${root}/locked`, 0o700);
    } catch {
      // Only the one case creates it.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  divergences === 0
    ? `reader: ${comparisons} comparisons agree with the oracle` +
        (recorded > 0 ? ` (${recorded} recorded divergence)` : "")
    : `reader: ${divergences} of ${comparisons} comparisons diverged`,
);
process.exit(divergences === 0 ? 0 : 1);
