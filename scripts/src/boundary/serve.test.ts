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
  serveConnection,
} from "./serve.ts";
import type { Serving } from "./serve.ts";

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
function mount(...names: readonly string[]): ReturnType<typeof buildRoutes> {
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

// ---------------------------------------------------------------------------
// The connection reader
// ---------------------------------------------------------------------------

/**
 * Enough of a socket for `serveConnection`, and nothing more.
 *
 * A real half-close cannot be staged from here: Bun's own client `end()` tears
 * the connection down rather than shutting one direction of it, so a TCP test
 * would prove the client's manners and not this server's. The events are what
 * the server actually reacts to, so they are what gets delivered — `end` after
 * `data` is exactly what the kernel reports for `shutdown(SHUT_WR)`.
 */
class FakeSocket {
  readonly written: string[] = [];
  ended = false;
  destroyed = false;
  private readonly handlers = new Map<string, (arg?: unknown) => void>();

  on(event: string, handler: (arg?: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  setTimeout(): this {
    return this;
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  end(data?: string): this {
    if (data !== undefined) this.written.push(data);
    this.ended = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  /** Deliver bytes, then optionally the peer's FIN. */
  deliver(payload: string, half: boolean): string {
    if (payload.length > 0) {
      (this.handlers.get("data") as (chunk: Buffer) => void)(
        Buffer.from(payload, "latin1"),
      );
    }
    if (half) (this.handlers.get("end") as () => void)();
    return this.written.join("");
  }
}

function answered(payload: string, half: boolean): string {
  const serving: Serving = {
    routes: mount("index.html"),
    origins: originsFor(DEFAULT_PORT),
  };
  const socket = new FakeSocket();
  serveConnection(socket as unknown as Parameters<typeof serveConnection>[0], serving);
  return socket.deliver(payload, half);
}

const HOST = `Host: 127.0.0.1:${DEFAULT_PORT}\r\n`;

describe("a request the client ends with FIN instead of a blank line", () => {
  // The differential harness cannot reach this: all 92 of its requests are
  // written complete and its client never half-closes. CPython's header reader
  // stops on a blank line *or* on end of stream, so a request closed by FIN is
  // a request — `nc -N` and `socat ...,shut-wr` send exactly that, and they are
  // what an operator reaches for to check a port is alive. Before the `end`
  // handler this server answered them with silence. Proved on the wire against
  // the recovered oracle as well; what is pinned here is the branch.

  test("answers a half-closed request whose head has no blank line", () => {
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}`, true)).toMatch(/^HTTP\/1\.0 404 /);
  });

  test("answers a half-closed request line with no headers at all", () => {
    // 400 rather than 404 because a head with no headers carries no Host, and
    // §16.5 refuses a request that does not address this server. What matters
    // here is that something is said at all: before the `end` handler this
    // connection was held open in silence waiting for a blank line that the
    // client had already promised never to send.
    expect(answered("GET /nope HTTP/1.1", true)).toMatch(/^HTTP\/1\.0 400 /);
  });

  test("reads the last header even though no newline closed it", () => {
    // `readline` at end of stream returns the partial line, and CPython keeps
    // it, so the Host on it still addresses this server.
    expect(answered(`GET /nope HTTP/1.1\r\nHost: 127.0.0.1:${DEFAULT_PORT}`, true))
      .toMatch(/^HTTP\/1\.0 404 /);
  });

  test("a half-closed request naming another host is still refused", () => {
    expect(answered("GET /nope HTTP/1.1\r\nHost: evil.example\r\n", true))
      .toMatch(/^HTTP\/1\.0 400 /);
  });

  test("says nothing to a client that connects and leaves", () => {
    expect(answered("", true)).toBe("");
  });

  test("still waits when the client has not finished", () => {
    // No FIN: the head is incomplete, so there is nothing to answer yet and the
    // connection is held rather than guessed at.
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}`, false)).toBe("");
  });

  // The header limit counts what `readline` returned, not what looks like a
  // header, so end of stream spends a slot and so does a line with no newline
  // on it. Verified against CPython's own `http.client.parse_headers`: 99 whole
  // lines then EOF is accepted, 100 then EOF is refused, and 99 whole lines
  // plus an unterminated one is refused. Without this a half-closing client
  // would be allowed a header a blank-line client is refused.
  const pads = (count: number): string =>
    Array.from({ length: count }, (_, i) => `X-Pad-${i}: 1\r\n`).join("");

  test("99 headers and end of stream is under the limit", () => {
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}${pads(98)}`, true)).toMatch(
      /^HTTP\/1\.0 404 /,
    );
  });

  test("100 headers and end of stream is over it", () => {
    // The 101st slot is the end of stream itself.
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}${pads(99)}`, true)).toMatch(
      /^HTTP\/1\.0 431 /,
    );
  });

  test("an unterminated last header spends a slot of its own", () => {
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}${pads(98)}X-Cut: 1`, true)).toMatch(
      /^HTTP\/1\.0 431 /,
    );
  });

  test("a complete head is answered without waiting for FIN", () => {
    expect(answered(`GET /nope HTTP/1.1\r\n${HOST}\r\n`, false)).toMatch(
      /^HTTP\/1\.0 404 /,
    );
  });
});

describe("a refusal raised after the method is known", () => {
  // CPython assigns `self.command` before it reads headers, and `send_error`
  // withholds the body on HEAD — so the header-scan refusals are the ones that
  // honour it. A 414 clears the command first and a bad request line never sets
  // it, which is why those keep their bodies on both sides.
  const padding = Array.from({ length: 101 }, (_, i) => `X-Pad-${i}: 1\r\n`).join("");
  const flood = (method: string): string =>
    answered(`${method} /nope HTTP/1.1\r\n${HOST}${padding}\r\n`, false);

  test("431 on HEAD sends the head and no body", () => {
    const reply = flood("HEAD");
    expect(reply).toMatch(/^HTTP\/1\.0 431 /);
    expect(reply).toContain("Content-Length:");
    expect(reply).not.toContain("<!DOCTYPE HTML>");
  });

  test("431 on GET still sends the body", () => {
    expect(flood("GET")).toContain("<!DOCTYPE HTML>");
  });

  test("the method is compared exactly, so lowercase head keeps its body", () => {
    expect(flood("head")).toContain("<!DOCTYPE HTML>");
  });

  test("a 414 keeps its body even on HEAD", () => {
    const reply = answered(`HEAD /${"a".repeat(70000)} HTTP/1.1\r\n${HOST}\r\n`, false);
    expect(reply).toMatch(/^HTTP\/1\.0 414 /);
    expect(reply).toContain("<!DOCTYPE HTML>");
  });
});
