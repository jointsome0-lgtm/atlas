// Reading the append-only journals for the preflight validator (§20.1, §25.8).
//
// A journal is the one Atlas file with no bound on its total size — it only
// grows — so it is read a chunk at a time and never held whole. The §25.8
// ceiling is per row, and an over-long row is reported and then discarded
// unread rather than buffered: a file whose first row is a gigabyte must
// produce a diagnostic, not an out-of-memory.

import fs from "node:fs";

import { JOURNAL_ROW_BYTES } from "./instance.ts";
import { JsonInputError, jsonLoads } from "./json-input.ts";
import { type JsonValue } from "./canonical-json.ts";
import { AtlasReader, ReaderError, type ScannedFile } from "./reader.ts";

const READ_BYTES = 8_192;

/** Curated directory → the schema its documents answer to (§8, §25.7). */
export const CURATED_DIRS: ReadonlyMap<string, string> = new Map([
  ["concepts", "concept"],
  ["zones", "zone"],
  ["patterns", "pattern"],
  ["materials", "material"],
  ["directions", "direction"],
  ["suggested-routes", "suggested-route"],
  ["trails", "trail-segment"],
  ["probes", "probe"],
]);

/** Journal stem → the schema its rows answer to (§25.7). */
export const JOURNALS: ReadonlyMap<string, string> = new Map([
  ["artifacts", "journal-artifact"],
  ["encounters", "journal-encounter"],
  ["questions", "journal-question"],
  ["decisions", "journal-decision"],
  ["mapping-decisions", "journal-mapping-decision"],
  ["receipts", "journal-receipt"],
  ["purges", "journal-purge"],
]);

/**
 * Every file holding rows of one journal, oldest first.
 *
 * §20.1: rotated files are the older prefix and the direct journal is the
 * newest tail — match the builder for every order-sensitive check.
 */
export function journalPaths(reader: AtlasReader, stem: string): ScannedFile[] {
  const paths = reader.scan(`state/${stem}`, { suffix: ".jsonl" });
  const direct = reader.optionalFile(`state/${stem}.jsonl`);
  if (direct !== null) paths.push(direct);
  return paths;
}

export interface JournalRow {
  readonly number: number;
  readonly row: JsonValue;
  readonly raw: Uint8Array;
}

/** Each row of one journal file, refusing anything that is not one. */
export function* readJsonl(path: ScannedFile): Generator<JournalRow> {
  for (const line of journalLines(path)) {
    if (line.oversized) {
      throw new JsonInputError(
        `${path}:${line.number}: journal row exceeds ${JOURNAL_ROW_BYTES} bytes`,
      );
    }
    if (line.raw.length === 0) {
      throw new JsonInputError(
        `${path}:${line.number}: blank JSONL row is unsupported`,
      );
    }
    if (line.raw.includes(0x0d)) {
      throw new JsonInputError(
        `${path}:${line.number}: CR/CRLF is unsupported; use LF`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line.raw);
    } catch {
      throw new JsonInputError(
        `${path}:${line.number}: input is not strict UTF-8`,
      );
    }
    let row: JsonValue;
    try {
      row = jsonLoads(text);
    } catch (error) {
      if (!(error instanceof JsonInputError)) throw error;
      // A row already carries its own position, so unlike a whole document
      // every refusal here gets the same shape whether or not the parser knew
      // where it stopped.
      throw new JsonInputError(
        `${path}:${line.number}: invalid JSON: ${error.message}`,
      );
    }
    yield { number: line.number, row, raw: line.raw };
  }
}

interface JournalLine {
  readonly number: number;
  readonly raw: Uint8Array;
  readonly oversized: boolean;
}

/**
 * The boundary validator's row reader: a BOM refuses the file, and so does a
 * file the reader will not open.
 *
 * §25.8 scopes UTF-8/LF/no-BOM to Atlas-authored files, and the preflight pass
 * is where that is enforced — one bad byte at the front and the journal is not
 * read at all.
 */
export function* journalLines(path: ScannedFile): Generator<JournalLine> {
  let fd: number;
  try {
    fd = path.open();
  } catch (error) {
    if (error instanceof ReaderError) throw new JsonInputError(error.message);
    throw error;
  }
  yield* readLines(fd, path, true);
}

/**
 * The builder's row reader, which is deliberately not the one above.
 *
 * The oracle carries these as two functions, and the difference is not an
 * oversight on either side: the boundary refuses a BOM'd journal outright,
 * while the builder has no BOM check at all and meets those bytes as an
 * ordinary row that fails to parse — reported at its line, after which the
 * rest of the file is still read. Collapsing the two would make a stray BOM
 * on line 1 silently swallow every row after it. It also lets a ReaderError
 * out unwrapped, because the builder answers that one itself.
 */
export function* builderJournalLines(path: ScannedFile): Generator<JournalLine> {
  yield* readLines(path.open(), path, false);
}

/** Yield rows without retaining more than the §25.8 ceiling plus one. */
function* readLines(
  fd: number,
  path: ScannedFile,
  refuseBom: boolean,
): Generator<JournalLine> {
  let number = 1;
  let row = new Uint8Array(0);
  let discarding = false;
  let first = true;

  const buffer = new Uint8Array(READ_BYTES);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, READ_BYTES, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      if (first) {
        first = false;
        if (
          refuseBom &&
          chunk[0] === 0xef &&
          chunk[1] === 0xbb &&
          chunk[2] === 0xbf
        ) {
          throw new JsonInputError(`${path}:1: UTF-8 BOM is unsupported`);
        }
      }
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (!discarding) {
          const room = JOURNAL_ROW_BYTES + 1 - row.length;
          const take = Math.min(end - offset, room);
          row = concat(row, chunk.subarray(offset, offset + take));
          if (end - offset > room || row.length > JOURNAL_ROW_BYTES) {
            // §25.8/§24.4: surface the ceiling immediately and discard the
            // refused remainder without echoing it.
            yield { number, raw: new Uint8Array(0), oversized: true };
            row = new Uint8Array(0);
            discarding = true;
          }
        }
        if (newline < 0) break;
        if (!discarding) yield { number, raw: row, oversized: false };
        number += 1;
        row = new Uint8Array(0);
        discarding = false;
        offset = newline + 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (row.length > 0) yield { number, raw: row, oversized: false };
}

// The row is copied out of the read buffer rather than referenced into it: the
// buffer is reused by the next read, and a row that spans a chunk boundary
// would otherwise be half overwritten before it is parsed.
function concat(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}
