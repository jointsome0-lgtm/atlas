// §25.6: releasing a lock that may no longer be the one this writer took.
//
// The differential harness runs both command lines against each other and
// covers everything the two programs do from outside — except this. Reaching
// the foreign-lock branch from outside means replacing the lock file while a
// build is running, which is a race, and a harness that has to win a race to
// prove something proves it only sometimes. Here the swap happens between two
// statements, so the branch is reached the same way every time.

import { expect, test } from "bun:test";
import fs from "node:fs";

import { releaseLock } from "./build-cli.ts";

const workspace = fs.mkdtempSync("/tmp/atlas-lock-");

/** Whether the descriptor is still open, asked without disturbing it. */
function isOpen(fd: number): boolean {
  try {
    fs.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

function acquire(name: string): { fd: number; lock: string } {
  const lock = `${workspace}/${name}`;
  const fd = fs.openSync(
    lock,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
  );
  return { fd, lock };
}

test("the lock this writer took is the lock it removes", () => {
  const { fd, lock } = acquire("own");
  releaseLock(fd, lock);
  expect(fs.existsSync(lock)).toBe(false);
  expect(isOpen(fd)).toBe(false);
});

test("a lock replaced by another actor survives this writer's cleanup", () => {
  const { fd, lock } = acquire("replaced");
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, '{"pid": 1, "started_at": "x"}\n');
  releaseLock(fd, lock);
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.readFileSync(lock, "utf8")).toBe('{"pid": 1, "started_at": "x"}\n');
  expect(isOpen(fd)).toBe(false);
});

test("a lock already gone is not an error, and the descriptor still closes", () => {
  const { fd, lock } = acquire("vanished");
  fs.unlinkSync(lock);
  releaseLock(fd, lock);
  expect(fs.existsSync(lock)).toBe(false);
  expect(isOpen(fd)).toBe(false);
});

test("a lock reached by a second name is still the same inode", () => {
  // A hard link is the one way two paths name one lock. Releasing by either
  // name must remove that name and leave the other pointing at a file with
  // one link left, not at nothing.
  const { fd, lock } = acquire("linked");
  const other = `${workspace}/linked-too`;
  fs.linkSync(lock, other);
  releaseLock(fd, lock);
  expect(fs.existsSync(lock)).toBe(false);
  expect(fs.existsSync(other)).toBe(true);
  fs.unlinkSync(other);
});
