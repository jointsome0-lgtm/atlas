// The oracle's answers, written down so they outlive the oracle.
//
// Every harness here asks CPython the same question it asks the port, and the
// two answers are compared. At the cutover CPython is deleted — and a harness
// that asked it directly would go with it, taking its corpus along. The corpus
// is the proof, so it stays.
//
// A harness therefore asks through this module. While the oracle exists the
// answer is recorded (`--record`), and every run afterwards checks the
// recording against the live oracle, so a recording cannot drift from the
// thing it records. At the cutover the asking half is deleted — the third
// argument below, and the Python each harness carried to ask with — and the
// recording is what remains: the oracle's answer, frozen on the day it was
// still there.
//
// A recording is keyed by a fingerprint of the question, so a corpus that
// grows a case does not silently keep an old answer. It fails, naming the
// harness, and somebody has to say out loud where the new answer came from.

import { createHash } from "node:crypto";
import fs from "node:fs";

const HERE = import.meta.dir;

/** The zone the runner set for this run; a recording's default is UTC. */
const ZONE = process.env.TZ ?? "UTC";

/** `--record` rewrites the recordings instead of checking against them. */
const RECORDING = process.argv.includes("--record");

interface Entry {
  /** Fingerprint of the question, so a changed corpus cannot reuse an answer. */
  readonly ask: string;
  /** Present only when this zone's answer differs from the default one. */
  readonly zone?: string;
  readonly answer: unknown;
}

interface Book {
  readonly harness: string;
  readonly source: string;
  readonly recorded: string;
  answers: Entry[];
}

const fingerprint = (question: string): string =>
  createHash("sha256").update(question, "utf8").digest("hex").slice(0, 32);

const pathFor = (harness: string): string => `${HERE}/oracle/${harness}.json`;

const books = new Map<string, Book>();

function book(harness: string): Book {
  const known = books.get(harness);
  if (known !== undefined) return known;
  let loaded: Book;
  try {
    loaded = JSON.parse(fs.readFileSync(pathFor(harness), "utf8")) as Book;
  } catch {
    if (!RECORDING) {
      throw new Error(
        `${harness}: no recorded oracle answers; this harness cannot run without them`,
      );
    }
    loaded = {
      harness,
      source: "CPython, the implementation this port replaces",
      recorded: new Date().toISOString().slice(0, 10),
      answers: [],
    };
  }
  books.set(harness, loaded);
  return loaded;
}

/**
 * Fold the zoned entries back down.
 *
 * A zone earns an entry of its own only by answering differently: the point of
 * the hostile-timezone matrix is that almost no zone does, and six copies of
 * one answer would bury the one that matters. Recording runs the zones as
 * separate processes, so this runs at every write rather than at the end.
 */
function normalize(answers: Entry[]): Entry[] {
  const kept: Entry[] = [];
  for (const entry of answers) {
    if (entry.zone === undefined) {
      kept.push(entry);
      continue;
    }
    const base = answers.find((other) => other.ask === entry.ask && other.zone === undefined);
    if (base === undefined) {
      // No default answer yet — this zone's becomes it, and a later zone that
      // agrees will fold into it here.
      kept.push({ ask: entry.ask, answer: entry.answer });
      continue;
    }
    if (JSON.stringify(base.answer) !== JSON.stringify(entry.answer)) kept.push(entry);
  }
  return kept;
}

/**
 * Write a book so a diff of it reads case by case.
 *
 * One line per recorded answer: these files are large, and a single-line JSON
 * document would make a change to any one case look like a change to all.
 */
/**
 * A recording is a committed file, so it is held to §24.4: nothing about the
 * machine that made it goes in. A path the oracle resolved is the way that
 * happens — a fixture named through `..` comes back absolute — and it is a
 * fold that was missed, never something to write down and clean up later.
 */
function refuseMachine(harness: string, text: string): void {
  const home = process.env["HOME"];
  if (home === undefined || home === "" || home === "/") return;
  if (!text.includes(home)) return;
  throw new Error(
    `${harness}: an oracle answer names this machine's home directory, so a ` +
      `root is unfolded. The recording is committed; it cannot carry a path ` +
      `that exists on one computer.`,
  );
}

function write(harness: string): void {
  const current = book(harness);
  current.answers = normalize(current.answers);
  const head = `{\n  "harness": ${JSON.stringify(current.harness)},\n` +
    `  "source": ${JSON.stringify(current.source)},\n` +
    `  "recorded": ${JSON.stringify(current.recorded)},\n  "answers": [\n`;
  const lines = current.answers.map((entry) => `    ${JSON.stringify(entry)}`);
  const body = `${head}${lines.join(",\n")}\n  ]\n}\n`;
  refuseMachine(harness, body);
  fs.mkdirSync(`${HERE}/oracle`, { recursive: true });
  fs.writeFileSync(pathFor(harness), body);
}

/**
 * The oracle's answer to one question, recorded or replayed.
 *
 * `ask` is only called while the oracle exists, and its result must survive a
 * JSON round trip — every harness here parses the oracle's stdout, so it
 * already does. Once the oracle is gone the argument is gone with it, and the
 * recording answers on its own.
 */
export function oracleAnswer(harness: string, question: string, ask?: () => unknown): unknown {
  const key = fingerprint(question);
  const current = book(harness);

  if (RECORDING) {
    if (ask === undefined) {
      throw new Error(`${harness}: --record needs an oracle to ask, and there is none`);
    }
    const answer = ask();
    // A default entry is the UTC answer with its zone folded away, so
    // re-recording UTC replaces it rather than sitting beside it.
    const at = current.answers.findIndex(
      (entry) =>
        entry.ask === key &&
        (entry.zone === ZONE || (entry.zone === undefined && ZONE === "UTC")),
    );
    if (at >= 0) current.answers.splice(at, 1);
    current.answers.push({ ask: key, zone: ZONE, answer });
    write(harness);
    return answer;
  }

  const found =
    current.answers.find((entry) => entry.ask === key && entry.zone === ZONE) ??
    current.answers.find((entry) => entry.ask === key && entry.zone === undefined);
  if (found === undefined) {
    throw new Error(
      `${harness}: the corpus asks a question no recorded oracle answer covers ` +
        `(${key}, TZ=${ZONE}). A case was added or changed, and the answer it ` +
        `expects has to come from somewhere that gets said out loud.`,
    );
  }
  if (ask !== undefined) {
    // Checked against the oracle on every run while the oracle is still here,
    // so a recording cannot quietly become a snapshot of the port instead.
    const live = JSON.stringify(ask());
    if (JSON.stringify(found.answer) !== live) {
      throw new Error(
        `${harness}: the live oracle no longer answers what was recorded ` +
          `(${key}, TZ=${ZONE})`,
      );
    }
  }
  return found.answer;
}

/**
 * A run's temporary roots, replaced by a stable name — and put back.
 *
 * A harness that builds a tree gets a fresh path for it every run, and that
 * path is in the question it asks and in the answer it gets back. Neither can
 * be recorded as it stands: the fingerprint would never match twice, and the
 * frozen answer would name a directory that no longer exists. So the roots are
 * folded out on the way in and folded back on the way out, and what is written
 * down is the part that does not turn with the run.
 *
 * Longest first, because one root can be a prefix of another.
 */
export function foldRoots(text: string, roots: readonly string[]): string {
  let folded = text;
  for (const [root, index] of [...roots.entries()]
    .map(([index, root]) => [root, index] as const)
    .sort((left, right) => right[0].length - left[0].length)) {
    folded = folded.split(root).join(`«root:${index}»`);
  }
  return folded;
}

export function unfoldRoots(text: string, roots: readonly string[]): string {
  let plain = text;
  roots.forEach((root, index) => {
    plain = plain.split(`«root:${index}»`).join(root);
  });
  return plain;
}

/** The same, for a harness whose oracle side has to be awaited. */
export async function oracleAnswerAsync(
  harness: string,
  question: string,
  ask?: () => Promise<unknown>,
): Promise<unknown> {
  if (ask === undefined) return oracleAnswer(harness, question);
  const answer = await ask();
  return oracleAnswer(harness, question, () => answer);
}
