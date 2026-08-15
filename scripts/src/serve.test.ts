import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { AtlasReader } from "./reader.ts";
import {
  DEFAULT_PORT,
  INDEX_ROUTE,
  buildRoutes,
  originsFor,
  parseArgs,
  printable,
} from "./serve.ts";

// The differential harness proves this server answers, byte for byte, what
// CPython's answers. What is pinned here is what a comparison of two running
// servers cannot reach: the route table is computed from the engine's own
// `viewer/` directory, which holds five ordinary files and will never hold the
// awkward ones — so the rules that decide what gets mounted are exercised
// against a directory made for the purpose. Likewise the origins on port 80,
// which no test may bind.

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync("/tmp/atlas-serve-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A viewer directory holding exactly these names, and an instance beside it. */
function mount(...names: readonly string[]): Map<string, unknown> {
  fs.rmSync(`${root}/viewer`, { recursive: true, force: true });
  fs.mkdirSync(`${root}/viewer`);
  for (const name of names) fs.writeFileSync(`${root}/viewer/${name}`, "");
  fs.mkdirSync(`${root}/instance/graph`, { recursive: true });
  fs.writeFileSync(`${root}/instance/graph/atlas-graph.json`, "{}\n");
  return buildRoutes(new AtlasReader(`${root}/viewer`), new AtlasReader(`${root}/instance`));
}

describe("the closed route table", () => {
  test("mounts a file of every type it can name, and nothing else", () => {
    const routes = mount("index.html", "viewer.css", "viewer.js", "f.svg", "d.json", "notes.txt");
    expect([...routes.keys()].sort()).toEqual([
      "/graph/atlas-graph.json",
      "/viewer/d.json",
      "/viewer/f.svg",
      "/viewer/index.html",
      "/viewer/viewer.css",
      "/viewer/viewer.js",
    ]);
  });

  test("a dotfile has no suffix, so nothing types it", () => {
    // `.js` here is the whole name, not a suffix — and a rule that read it as
    // one would mount a file whose name begins where its type should be.
    expect([...mount(".js", ".html").keys()]).toEqual(["/graph/atlas-graph.json"]);
  });

  test("a name ending in a dot has no suffix either", () => {
    expect([...mount("viewer.js.", "index.").keys()]).toEqual(["/graph/atlas-graph.json"]);
  });

  test("a dotted name keeps only its last suffix", () => {
    const routes = mount("viewer.js.map", "viewer.min.js");
    expect([...routes.keys()].sort()).toEqual([
      "/graph/atlas-graph.json",
      "/viewer/viewer.min.js",
    ]);
  });

  test("a name that would need encoding is not a route", () => {
    // Routes are matched against the raw target, so a name only reachable by
    // percent-encoding it would be a route nothing could ever ask for — and a
    // route table holding one is a table that no longer says what it serves.
    const routes = mount("two words.js", "a+b.js", "a%2e.js", "ünïcode.js", "a?b.js", "ok-1._x.js");
    expect([...routes.keys()].sort()).toEqual([
      "/graph/atlas-graph.json",
      "/viewer/ok-1._x.js",
    ]);
  });

  test("the graph is mounted from the instance, not from the viewer", () => {
    const routes = mount("index.html");
    fs.writeFileSync(`${root}/viewer/atlas-graph.json`, "");
    expect(routes.get("/graph/atlas-graph.json")).toMatchObject({
      relativePath: "graph/atlas-graph.json",
      contentType: "application/json",
    });
  });

  test("the entry point the startup check looks for is one of them", () => {
    expect(mount("index.html").has(INDEX_ROUTE)).toBe(true);
    expect(mount("viewer.js").has(INDEX_ROUTE)).toBe(false);
  });
});

describe("the origins that address this server", () => {
  test("are the two loopback names carrying the port", () => {
    expect([...originsFor(DEFAULT_PORT)].sort()).toEqual([
      `127.0.0.1:${DEFAULT_PORT}`,
      `localhost:${DEFAULT_PORT}`,
    ]);
  });

  test("include the bare names on the port a client leaves out", () => {
    // No test may bind port 80, so this branch has no running server to ask.
    expect([...originsFor(80)].sort()).toEqual([
      "127.0.0.1",
      "127.0.0.1:80",
      "localhost",
      "localhost:80",
    ]);
  });

  test("do not include the bare names on any other port", () => {
    expect(originsFor(8080).has("127.0.0.1")).toBe(false);
  });
});

describe("what a diagnostic may carry", () => {
  test("folds every character a terminal would act on", () => {
    expect(printable("a\x1b[2Jb\x07c\nd")).toBe("a?[2Jb?c?d");
  });

  test("keeps the space, which is the one separator that is printable", () => {
    expect(printable("a b")).toBe("a b");
  });

  test("cuts by code point rather than by unit, and says that it cut", () => {
    // A path is bounded so one ERROR: line stays a line; counting UTF-16 units
    // would cut an astral character in half and put a lone surrogate on it.
    expect(printable("𝔞".repeat(10), 4)).toBe("𝔞𝔞𝔞𝔞…");
    expect(printable("abcd", 4)).toBe("abcd");
    expect(printable("abcde", 4)).toBe("abcd…");
  });
});

describe("reading the arguments the way the oracle's parser reads them", () => {
  /** The port a run would bind, or the kind of refusal it met instead. */
  const read = (...argv: string[]): number | string => {
    const parsed = parseArgs(argv);
    if (parsed.kind === "args") return parsed.args.port;
    return parsed.kind === "help" ? "help" : parsed.message;
  };

  test("an unambiguous prefix addresses the option it abbreviates", () => {
    // `allow_abbrev` is on by default, so a caller who types `--po` has named
    // the only option that begins that way.
    expect(read("--po", "9999", "/instance")).toBe(9999);
    expect(read("--p=9999", "/instance")).toBe(9999);
    expect(read("--h")).toBe("help");
  });

  test("a prefix that names every option names none of them", () => {
    // The empty prefix. argparse says which ones it could have meant, in the
    // order they were declared, and quotes the word as typed.
    expect(read("--=1", "/instance")).toBe(
      "ambiguous option: --=1 could match --help, --port",
    );
  });

  test("every argument is classified before any of them is used", () => {
    // Help would have fired first if the parser read left to right and acted
    // as it went; it builds the whole pattern first instead.
    expect(read("-h", "--=1")).toBe("ambiguous option: --=1 could match --help, --port");
  });

  test("digits are read from any script that writes them", () => {
    // `int()` reads every Unicode decimal digit. The mathematical sets are the
    // hard case: they abut, so a digit's value is its place within its own ten
    // and not its distance from wherever the run of digits started.
    const spell = (zero: number): string =>
      [8, 1, 3, 8].map((digit) => String.fromCodePoint(zero + digit)).join("");
    expect(read("--port", spell(0x0660), "/instance")).toBe(8138);
    expect(read("--port", spell(0x0966), "/instance")).toBe(8138);
    expect(read("--port", spell(0xff10), "/instance")).toBe(8138);
    expect(read("--port", spell(0x1d7ce), "/instance")).toBe(8138);
    expect(read("--port", spell(0x1d7d8), "/instance")).toBe(8138);
  });

  test("the whitespace around a number is the one int() skips", () => {
    // Not the runtime's list and not `str.strip()`'s: the rewrite `int()` does
    // first only asks Unicode about characters past ASCII.
    expect(read("--port", "\u0085443\u00a0", "/instance")).toBe(443);
    expect(read("--port", "\u001c443", "/instance")).toBe(
      "argument --port: port must be an integer",
    );
    expect(read("--port", "\ufeff443", "/instance")).toBe(
      "argument --port: port must be an integer",
    );
  });

  test("a word that only looks like an option is a path", () => {
    // There are no options here that look like negative numbers, and an
    // argument with a space in it was meant to be a name.
    expect(read("-")).toBe(DEFAULT_PORT);
    expect(read("-5")).toBe(DEFAULT_PORT);
    expect(read("-x y")).toBe(DEFAULT_PORT);
    expect(read("--", "--port")).toBe(DEFAULT_PORT);
  });

  test("an option-looking word is not the value of the option before it", () => {
    expect(read("/instance", "--port", "--help")).toBe(
      "argument --port: expected one argument",
    );
    // A negative number is a value, though — it is not an option here.
    expect(read("/instance", "--port", "-1")).toBe(
      "argument --port: port must be between 1 and 65535",
    );
  });

  test("a missing instance is refused before a leftover word is counted", () => {
    // Two refusals are available and only one of them happens: the parse fails
    // inside argparse, and the words it could not place are counted after it
    // returns.
    expect(read("--open")).toBe("the following arguments are required: INSTANCE_DIR");
    expect(read("--open", "/instance")).toBe(
      "1 unrecognized argument(s); values withheld",
    );
  });

  test("a long option that takes no value refuses one, a short one does not", () => {
    expect(read("--help=please")).toBe(
      "argument -h/--help: ignored explicit argument 'please'",
    );
    // One dash carries its value in the same word, so `-hx` is `-h` and an `x`
    // that help never gets to look at.
    expect(read("-hx")).toBe("help");
  });
});
