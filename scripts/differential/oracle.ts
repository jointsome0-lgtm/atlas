// The oracle's frozen answers, read after the oracle is gone.
//
// Every harness here once asked CPython the same question it asks the port, and
// the two answers were compared. At the cutover CPython is deleted — and a
// harness that asked it directly would go with it, taking its corpus along.
// The corpus is the proof, so it stays.
//
// The answers were recorded while the oracle existed and checked against it
// on every run. This module now reads what remains: the oracle's answer,
// frozen on the day it was still there.
//
// A recording is keyed by a fingerprint of the question, so a corpus that
// grows a case does not silently keep an old answer. It fails, naming the
// harness, and somebody has to say out loud where the new answer came from.

import { createHash } from "node:crypto";
import fs from "node:fs";

const HERE = import.meta.dir;

/** The zone the runner set for this run; a recording's default is UTC. */
const ZONE = process.env.TZ ?? "UTC";

interface Entry {
  /** Fingerprint of the question, so a changed corpus cannot reuse an answer. */
  readonly ask: string;
  /** Present only when this zone's answer differs from the default one. */
  readonly zone?: string;
  readonly answer: unknown;
}

interface Book {
  readonly answers: readonly Entry[];
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
    throw new Error(
      `${harness}: no recorded oracle answers; this harness cannot run without them`,
    );
  }
  books.set(harness, loaded);
  return loaded;
}

/**
 * Refuse a question that names the machine asking it.
 *
 * The answer is keyed by a hash of the question, so a question carrying this
 * checkout's path is a different question on every computer — the recording
 * then answers on the machine that made it and nowhere else, and the first
 * place that shows is CI (atlas#141). It is always a fold that was missed:
 * `foldRoots` exists for exactly this, and the fix is to add the root to its
 * list, never to re-record per machine.
 *
 * Checked here rather than at the fold because here is where a missed one
 * becomes permanent.
 */
const CHECKOUT = `${HERE}/../..`;
const MACHINE: readonly string[] = [
  CHECKOUT,
  fs.realpathSync(CHECKOUT),
  ...(process.env["HOME"] !== undefined && process.env["HOME"] !== "/"
    ? [process.env["HOME"]]
    : []),
];

/**
 * Refuse to answer at all when the process can ignore permissions.
 *
 * Several harnesses prove a refusal the only way a refusal can be proved: they
 * take away a permission and record that the operation stopped. Root has no
 * such permission to lose — `openat` on a mode-000 directory succeeds, a write
 * into a read-only tree succeeds — so those recordings describe an outcome the
 * process can no longer produce, and every one of them reports a divergence
 * that is not a behavioural difference (atlas#141).
 *
 * There is no fold for this and there should not be: the cases are correct and
 * the recordings are correct, and it is the process that is wrong. Refusing
 * once here beats teaching each chmod case to check its own uid, and it covers
 * the ones nobody has written yet.
 */
function refuseRoot(): void {
  if (process.getuid?.() !== 0) return;
  throw new Error(
    "the corpus is running as root, and root cannot be refused: the cases " +
      "that prove a refusal do it by taking a permission away, which root " +
      "does not have to lose. Run it as an ordinary user — not under sudo, " +
      "and not in a container that defaults to root.",
  );
}

function refuseMachine(harness: string, question: string): void {
  for (const named of MACHINE) {
    if (named === "" || !question.includes(named)) continue;
    throw new Error(
      `${harness}: the question names this machine (${named}), so its ` +
        `fingerprint is different on every computer and the recording can ` +
        `only ever answer here. Fold the root out with foldRoots.`,
    );
  }
}

/** The oracle's frozen answer to one question. */
export function oracleAnswer(harness: string, question: string): unknown {
  refuseRoot();
  refuseMachine(harness, question);
  const key = fingerprint(question);
  const current = book(harness);

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

