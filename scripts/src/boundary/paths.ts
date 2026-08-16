// Path arithmetic the way CPython does it, which is not the way Node does it.
//
// Two libraries are being reproduced here and they are not the same library:
// `posixpath` (join, split, normpath, abspath) and `pathlib` (`.name`,
// `.parent`). Node's `node:path` is close enough to both to be dangerous —
// `path.resolve` collapses a leading `//` that POSIX and CPython keep as a
// root of its own, and `path.join` treats an absolute right-hand side as
// ordinary text where `posixpath.join` lets it win outright. A root spelled
// `//instance` would otherwise reach the reader as `/instance`, and every
// diagnostic out of that build would name a path the caller did not give.
//
// Nothing here touches the filesystem. Resolving a path *through* symlinks is
// a different job with a different risk, and lives with its one caller.

/** `posixpath.join`, where an absolute right side replaces the left. */
export function posixJoin(left: string, right: string): string {
  if (right.startsWith("/")) return right;
  if (left === "" || left.endsWith("/")) return left + right;
  return `${left}/${right}`;
}

/** `posixpath.split`: the head keeps its root slash and loses the rest. */
export function posixSplit(path: string): [string, string] {
  const cut = path.lastIndexOf("/") + 1;
  let head = path.slice(0, cut);
  const tail = path.slice(cut);
  if (head !== "" && head.split("").some((character) => character !== "/")) {
    head = head.replace(/\/+$/, "");
  }
  return [head, tail];
}

/** `posixpath.normpath`, including the exactly-two-slashes root. */
export function normpath(path: string): string {
  if (path === "") return ".";
  const leading = /^\/*/.exec(path)?.[0].length ?? 0;
  const root = leading === 0 ? "" : leading === 2 ? "//" : "/";
  const kept: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      kept.push(part);
    } else if (root !== "" || (kept.length > 0 && kept[kept.length - 1] !== "..")) {
      // Above an absolute root there is nothing to pop, so `..` disappears;
      // a relative path keeps the ones it cannot resolve.
      kept.pop();
    } else {
      kept.push("..");
    }
  }
  const joined = root + kept.join("/");
  return joined === "" ? "." : joined;
}

/** `posixpath.abspath`: normalized, and relative to the working directory. */
export function abspath(path: string): string {
  return normpath(path.startsWith("/") ? path : posixJoin(process.cwd(), path));
}

/**
 * `PurePosixPath(path).name` and `.parent`, for the arguments a caller hands
 * in: an absolute or relative directory path, possibly with trailing slashes.
 * `..` is left alone exactly as `PurePosixPath` leaves it — this resolves
 * nothing, it only splits.
 */
export function splitPath(path: string): { name: string; parent: string } {
  const leading = /^\/*/.exec(path)?.[0].length ?? 0;
  const root = leading === 0 ? "" : leading === 2 ? "//" : "/";
  const parts = path
    .slice(leading)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const name = parts.length === 0 ? "" : (parts[parts.length - 1] as string);
  const rest = parts.slice(0, -1);
  const parent =
    root === ""
      ? rest.length === 0
        ? "."
        : rest.join("/")
      : `${root}${rest.join("/")}`;
  return { name, parent };
}
