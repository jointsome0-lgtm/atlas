// Reading one JSON file for the preflight validator (§25.7, §25.8).
//
// This is not the writer's reader. `instance.ts` answers with a reason code
// and stops the flow, because a writer that has already taken the lock must
// not continue past a file it could not read. The validator instead collects
// every complaint it can and reports them together, so its failures are
// strings with a place in front of them and its job is to keep going.

import {
  JsonDisciplineError,
  type JsonValue,
  parseStrict,
} from "./canonical-json.ts";
import { ReaderError, type ScannedFile } from "./reader.ts";

/** A JSON input the validator refused, named by place and reason. */
export class JsonInputError extends Error {
  /**
   * The 1-based line a malformed document stopped on, when there was one.
   *
   * Only a syntax failure has a position. A duplicate key or a non-finite
   * number is found by a rule that does not know where it was reading, in this
   * port and in the oracle alike, and the two get different message shapes
   * because of it — so this being absent is load-bearing, not incidental.
   */
  readonly syntaxLine: number | undefined;

  constructor(message: string, syntaxLine?: number) {
    super(message);
    this.name = "JsonInputError";
    this.syntaxLine = syntaxLine;
  }
}

/** Parse strict JSON text, restating a discipline refusal as an input error. */
export function jsonLoads(text: string): JsonValue {
  try {
    return parseStrict(text);
  } catch (error) {
    if (error instanceof JsonDisciplineError) {
      throw new JsonInputError(error.message, error.line);
    }
    throw error;
  }
}

/**
 * Read one JSON file; `delivered` relaxes the Atlas-authored text rules.
 *
 * §25.8 scopes UTF-8/LF/no-BOM to Atlas-authored files; delivered intake
 * batches stay as delivered (§33.2), so their reader tolerates CRLF and a BOM
 * while the structural JSON checks stay fail-closed.
 */
export function readJsonFile(file: ScannedFile, delivered = false): JsonValue {
  let data: Uint8Array;
  try {
    data = file.readBytes();
  } catch (error) {
    if (error instanceof ReaderError) throw new JsonInputError(error.message);
    throw error;
  }

  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    if (!delivered) throw new JsonInputError(`${file}: UTF-8 BOM is unsupported`);
    data = data.subarray(3);
  }

  if (!delivered) {
    const carriageReturn = data.indexOf(0x0d);
    if (carriageReturn >= 0) {
      throw new JsonInputError(
        `${file}:${lineAt(data, carriageReturn)}: CR/CRLF is unsupported; use LF`,
      );
    }
  }

  const invalid = firstInvalidUtf8(data);
  if (invalid !== null) {
    throw new JsonInputError(
      `${file}:${lineAt(data, invalid)}: input is not strict UTF-8`,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);

  try {
    return jsonLoads(text);
  } catch (error) {
    if (!(error instanceof JsonInputError)) throw error;
    // A malformed document knows where it stopped; a duplicate key or a
    // non-finite number does not, and the oracle prints neither a line nor
    // the `invalid JSON:` lead-in for those. Both shapes are kept, because a
    // consumer that greps for a line number in the first would find a wrong
    // one in the second.
    throw new JsonInputError(
      error.syntaxLine === undefined
        ? `${file}: ${error.message}`
        : `${file}:${error.syntaxLine}: invalid JSON: ${error.message}`,
    );
  }
}

/** The line a byte offset falls on, counting from one. */
export function lineAt(data: Uint8Array, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset; at += 1) if (data[at] === 0x0a) line += 1;
  return line;
}

/**
 * The offset of the first byte that begins a malformed UTF-8 sequence, or null.
 *
 * `TextDecoder` refuses without saying where, and the oracle's line number is
 * derived from exactly that offset, so the walk is done here instead. The
 * answer is the *leading* byte of the bad sequence, which is what CPython
 * reports for a bad continuation, a truncated tail and an out-of-range or
 * surrogate encoding alike.
 *
 * RFC 3629 spelled out rather than deferred to a decoder, because the ranges
 * are the point: 0xC0–0xC1 and 0xF5–0xFF can never lead, 0xE0 and 0xF0 have a
 * raised second byte that rules out an overlong encoding, 0xED has a lowered
 * one that rules out a surrogate, and 0xF4 a lowered one that stops at U+10FFFF.
 */
export function firstInvalidUtf8(data: Uint8Array): number | null {
  const at = (index: number): number => data[index] as number;
  let index = 0;
  while (index < data.length) {
    const lead = at(index);
    let width: number;
    let lowSecond = 0x80;
    let highSecond = 0xbf;
    if (lead <= 0x7f) {
      index += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      width = 2;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      width = 3;
      if (lead === 0xe0) lowSecond = 0xa0;
      else if (lead === 0xed) highSecond = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      width = 4;
      if (lead === 0xf0) lowSecond = 0x90;
      else if (lead === 0xf4) highSecond = 0x8f;
    } else {
      return index;
    }
    if (index + width > data.length) return index;
    const second = at(index + 1);
    if (second < lowSecond || second > highSecond) return index;
    for (let offset = 2; offset < width; offset += 1) {
      const byte = at(index + offset);
      if (byte < 0x80 || byte > 0xbf) return index;
    }
    index += width;
  }
  return null;
}
