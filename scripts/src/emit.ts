// §20.2/§25.6: writing the graph so that a crash cannot leave half of one.
//
// The temp file stays beside the canonical output, inside the instance —
// never in a system temp directory, which may be another filesystem and would
// turn the rename into a copy. Its bytes are synced, the rename replaces the
// output atomically, and then the directory itself is synced so the entry
// pointing at the new inode is durable too.
//
// The restore path is the part worth reading twice. A directory sync that
// fails after the rename has already happened is still a failed emission, and
// the caller is about to be told so — but by then the new bytes are at the
// canonical path. Putting the previous bytes back is what makes "this build
// did not emit" true rather than merely reported.
//
// Ported from _emit_graph and _sync_dir in scripts/build_atlas_graph.py.

import fs from "node:fs";
import path from "node:path";

import { stringifyDocument } from "./canonical-json.ts";

const O_DIRECTORY = (fs.constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;

/** Make a directory entry durable, not just the bytes the entry points at. */
export function syncDir(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write `data` to `target`, on the platter before the call returns. */
function writeSynced(target: string, data: Uint8Array): void {
  const fd = fs.openSync(target, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The same write without the sync, which is what the restore path does.
 *
 * Kept as the oracle has it rather than quietly made durable: the bytes that
 * land are identical either way, and the difference — whether the restored
 * file survives a crash in the seconds after a failed emission — is a change
 * to what the tool promises, not a change of language. Worth revisiting on
 * its own, not inside a port.
 */
function writeFlushed(target: string, data: Uint8Array): void {
  const fd = fs.openSync(target, "w");
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Emit one graph durably. False means nothing was emitted — and means it.
 *
 * The diagnostic names the file and the reason; §24.4 asks for the place and
 * not for a sentence, so the wording of the underlying I/O error is the
 * platform's and not a promise of ours.
 */
export function emitGraph(output: string, graph: unknown): boolean {
  const payload = new TextEncoder().encode(stringifyDocument(graph));
  const parent = path.dirname(output);
  const temp = `${output}.tmp`;
  let replaced = false;
  let hadPrevious = false;
  let previous = new Uint8Array(0);

  try {
    fs.mkdirSync(parent, { recursive: true });
    hadPrevious = fs.existsSync(output);
    if (hadPrevious) previous = fs.readFileSync(output);

    writeSynced(temp, payload);
    fs.renameSync(temp, output);
    replaced = true;
    syncDir(parent);
  } catch (error) {
    // The oracle narrows this to OSError; here it is every throw, which is the
    // same set in practice — the serialization that could raise something else
    // happens above the try, and inside it every call is a filesystem one.
    //
    // Put the last good bytes back before returning, so a caller that reads
    // the file after a false answer sees the build that did emit.
    if (replaced) {
      try {
        if (hadPrevious) {
          writeFlushed(temp, previous);
          fs.renameSync(temp, output);
        } else {
          fs.rmSync(output, { force: true });
        }
      } catch {
        /* the restore is best effort; the failure is already being reported */
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* likewise */
    }
    process.stderr.write(
      `ERROR: cannot emit ${output}: ${(error as Error).message}\n`,
    );
    return false;
  }
  return true;
}
