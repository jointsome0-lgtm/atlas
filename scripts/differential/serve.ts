// Differential harness: the instance viewer server against the oracle.
//
// This one talks to the two programs over a socket, because a server's answer
// is the bytes on the wire and nothing else. Not a parsed status, not a header
// dictionary — the literal octets, status line and header order and error body
// included. The oracle is CPython's BaseHTTPRequestHandler, whose output has
// shapes no framework would choose (HTTP/1.0, a trailing space after the
// server name, a malformed request line answered with a body and no status
// line at all), and a port that produced *reasonable* bytes instead would be a
// different server to every client that ever spoke to this one.
//
// Two folds and no others: the Date header is the clock, and the port is
// whichever one was free.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";

const ROOT = `${import.meta.dir}/..`;

// ---------------------------------------------------------------------------
// The instance every serving case starts from
// ---------------------------------------------------------------------------

const GRAPH = '{"format":"atlas-graph","version":1,"nodes":[],"edges":[]}\n';
const REBUILT = '{"format":"atlas-graph","version":1,"nodes":[],"edges":[[]]}\n';

const INSTANCE: Readonly<Record<string, string>> = {
  "graph/atlas-graph.json": GRAPH,
};

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** One thing done to a running server, or to the tree underneath it. */
interface Step {
  /** A raw request, with `{port}` standing for the port this side bound. */
  readonly request?: string;
  /** Rewrite a file in the tree between two requests. */
  readonly write?: readonly [string, string];
  /** Replace a path with a symlink to somewhere else. */
  readonly link?: readonly [string, string];
  /** Remove a path. */
  readonly remove?: string;
  /** Knock on the same port from an address that is not loopback. */
  readonly elsewhere?: true;
  /** The status code the oracle answered; null when it sent no status line. */
  readonly status?: number | null;
  /** Substrings the oracle's response must contain. */
  readonly holds?: readonly string[];
  /** That the response carried no body at all past its headers. */
  readonly bodyless?: boolean;
}

interface Case {
  readonly name: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly links?: Readonly<Record<string, string>>;
  /** Arguments, with `{root}` for the tree and `{port}` for the bound port. */
  readonly args: readonly string[];
  /** Environment laid over the caller's, for the variables a run reads. */
  readonly env?: Readonly<Record<string, string>>;
  /** Set when the program is expected to exit instead of serving. */
  readonly exit?: number;
  readonly says?: readonly string[];
  readonly prints?: readonly string[];
  readonly steps?: readonly Step[];
}

const request = (line: string, host = "127.0.0.1:{port}"): string =>
  `${line}\r\nHost: ${host}\r\n\r\n`;

/** CPython's request-line ceiling: the size at which a line stops being read. */
const REQUEST_LINE_BYTES = 65536;

/** Everything in a request line that is not the target, newline included. */
const LINE_FRAME = "GET / HTTP/1.1\r\n".length;

/** A request line of exactly `total` bytes that names nothing routable. */
const longLine = (total: number): string =>
  `GET /${"x".repeat(total - LINE_FRAME)} HTTP/1.1\r\n`;

/** As many headers as asked for, each one distinct and none of them meaningful. */
const pads = (count: number): string =>
  Array.from({ length: count }, (_, at) => `X-Pad-${at}: 1\r\n`).join("");

/** A whole request carrying `count` headers on top of the one that addresses us. */
const padded = (count: number): string =>
  `GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n${pads(count)}\r\n`;

/** Everything in a header line that is not its value, newline included. */
const HEADER_FRAME = "X-Pad: \r\n".length;

/** A header line of exactly `total` bytes, newline included. */
const longHeader = (total: number): string =>
  `X-Pad: ${"x".repeat(total - HEADER_FRAME)}\r\n`;

/** A graph too big for one read, so the send loop has to go round. */
const BIG_GRAPH = `{"format":"atlas-graph","version":1,"pad":"${"x".repeat(150_000)}"}\n`;

const cases: Case[] = [
  // --- the arguments -------------------------------------------------------
  {
    name: "no instance to serve",
    args: [],
    exit: 2,
    says: ["the following arguments are required: INSTANCE_DIR", "usage:"],
  },
  {
    name: "the help text",
    args: ["--help"],
    exit: 0,
    prints: ["usage:", "INSTANCE_DIR", "--port PORT", "loopback port"],
  },
  {
    name: "the help text by its short name",
    args: ["-h"],
    exit: 0,
    prints: ["usage:"],
  },
  {
    // argparse measures the terminal before it wraps anything, and `COLUMNS`
    // is where it looks first. The port carries one layout (#135): the usage
    // line and the option spellings are the same at every width, the help
    // column's line breaks are not.
    name: "the help text at a terminal width that is not the default",
    args: ["--help"],
    env: { COLUMNS: "40" },
    exit: 0,
    prints: ["usage:", "INSTANCE_DIR", "--port PORT", "loopback port"],
  },
  {
    name: "a port that is not a number",
    files: INSTANCE,
    args: ["{root}", "--port", "eighty"],
    exit: 2,
    says: ["argument --port: port must be an integer"],
  },
  {
    // argparse accepts any unambiguous prefix of a long option, and `--port`
    // is the only one here, so `--po` is `--port`. The run gets past the
    // arguments and fails on the root instead, which is what proves the option
    // was understood rather than merely tolerated.
    name: "the port option written as an abbreviation",
    args: ["/definitely-absent", "--po", "{port}"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    // `int()` reads every Unicode decimal digit, not just ASCII, so these are
    // the digits of a port number and the run reaches the root check. A port
    // that only knew `[0-9]` would refuse the argument instead.
    name: "a port written in digits that are not ASCII",
    args: ["/definitely-absent", "--port", "٨١٣٨"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    // The same abbreviation rule reaching the other option: `--h` is `--help`
    // because nothing else begins that way.
    name: "the help option written as an abbreviation",
    args: ["--h"],
    exit: 0,
    prints: ["usage:"],
  },
  {
    // A long option that takes no value, handed one anyway. The parser refuses
    // the *word*, so help is never printed — an implementation that simply
    // looked for `--help` in the arguments would print it.
    name: "the help option given a value it cannot take",
    args: ["--help=please"],
    exit: 2,
    says: ["argument -h/--help: ignored explicit argument 'please'"],
  },
  {
    // One dash carries its value in the same word, so this is `-h` followed by
    // an `x` the parser never gets to look at: help fires first.
    name: "a short option with letters stuck to it",
    args: ["-hx"],
    exit: 0,
    prints: ["usage:"],
  },
  {
    // The tail is only a tail when nothing stands between it and the option.
    // An `=` makes the same letter a value, and a value is refused.
    name: "a short option handed the same letters through an equals sign",
    args: ["-h=x"],
    exit: 2,
    says: ["argument -h/--help: ignored explicit argument 'x'"],
  },
  {
    // And a tail that opens with a dash is not more short options either.
    name: "a short option whose tail begins with a dash",
    args: ["-h-x"],
    exit: 2,
    says: ["argument -h/--help: ignored explicit argument '-x'"],
  },
  {
    // An empty value is still a value: there is no tail to re-read.
    name: "a short option handed nothing through an equals sign",
    args: ["-h="],
    exit: 2,
    says: ["argument -h/--help: ignored explicit argument ''"],
  },
  {
    // The refused value is shown back, so it is shown the way CPython shows
    // one: escaped, at the width the code point needs, and never as itself —
    // this one would otherwise put a line break in the middle of a diagnostic.
    name: "a refused value carrying characters that cannot be printed",
    args: ["--help=\u2028\u0007\u{10ffff}"],
    exit: 2,
    says: ["argument -h/--help: ignored explicit argument '\\u2028\\x07\\U0010ffff'"],
  },
  {
    // The empty prefix, which is every long option at once. The parser says so
    // before it runs anything, which is why the `--help` after it is not help.
    name: "an option that abbreviates all of them",
    args: ["--=1", "--help"],
    exit: 2,
    says: ["ambiguous option: --=1 could match --help, --port"],
  },
  {
    // `--` ends the options, so what follows is a path even when it starts
    // with a dash. The run reaches the root check, which is the proof.
    name: "the separator that ends the options",
    args: ["--", "/definitely-absent"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    // A lone dash is a name, not an option: there is no one-character option
    // for it to be.
    name: "an instance named with a single dash",
    args: ["-"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    // This command has no option that looks like a negative number, so a word
    // that does is a path.
    name: "an instance whose name reads as a negative number",
    args: ["-5"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    // Two refusals are available and their order is not obvious: the missing
    // instance is refused inside the parse, and the leftover word is only
    // counted after the parse returns.
    name: "an unknown option and no instance at all",
    args: ["--open"],
    exit: 2,
    says: ["the following arguments are required: INSTANCE_DIR"],
  },
  {
    // An option-looking word is not a value, so `--port` is left with nothing
    // rather than served a `--help` as its number.
    name: "an option where the port's value belongs",
    files: INSTANCE,
    args: ["{root}", "--port", "--help"],
    exit: 2,
    says: ["argument --port: expected one argument"],
  },
  {
    // The whitespace `int()` skips is neither the runtime's nor even
    // `str.strip()`'s: the rewrite it does first only asks Unicode about
    // characters past ASCII, so the next-line character is whitespace to it
    // and this is a number one too large.
    name: "a port wrapped in whitespace only Python skips",
    files: INSTANCE,
    args: ["{root}", "--port", "\u008570000\u0085"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    // And the other side of that line: the file separator is whitespace to
    // `str.strip()` and to `str.isspace()`, and is still not a number.
    name: "a port wrapped in whitespace Python strips but does not skip",
    files: INSTANCE,
    args: ["{root}", "--port", "\u001c70000\u001c"],
    exit: 2,
    says: ["argument --port: port must be an integer"],
  },
  {
    name: "a port the kernel would choose",
    files: INSTANCE,
    args: ["{root}", "--port", "0"],
    exit: 2,
    says: ["port must be fixed"],
  },
  {
    name: "a port past the end of the range",
    files: INSTANCE,
    args: ["{root}", "--port", "70000"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    // The first number that is one too many, which seventy thousand cannot
    // show — every off-by-one range check refuses seventy thousand too.
    name: "the port one past the last one",
    files: INSTANCE,
    args: ["{root}", "--port", "65536"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    // What Python's own `int` takes, which is more than a run of digits: a
    // sign, underscores between digits, surrounding whitespace. Each is read
    // as the number it spells and then refused for being out of range, which
    // is a different refusal from being no number at all.
    name: "ports spelled the way Python spells an integer",
    files: INSTANCE,
    args: ["{root}", "--port", "+70000"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    name: "a port with underscores between its digits",
    files: INSTANCE,
    args: ["{root}", "--port", "6_5536"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    name: "a port with whitespace around it",
    files: INSTANCE,
    args: ["{root}", "--port", " 70000\t"],
    exit: 2,
    says: ["port must be between 1 and 65535"],
  },
  {
    // The joined spelling of the same option, which a caller is as likely to
    // type and which nothing else in this corpus reaches.
    name: "a port joined to its option by an equals sign",
    files: INSTANCE,
    args: ["{root}", "--port=eighty"],
    exit: 2,
    says: ["argument --port: port must be an integer"],
  },
  {
    name: "an option that expects a value and is given none",
    files: INSTANCE,
    args: ["{root}", "--port"],
    exit: 2,
    says: ["argument --port: expected one argument"],
  },
  {
    name: "a negative port",
    files: INSTANCE,
    args: ["{root}", "--port", "-1"],
    exit: 2,
    says: ["argument --port"],
  },
  {
    name: "an option this command does not have",
    files: INSTANCE,
    args: ["{root}", "--open"],
    exit: 2,
    says: ["1 unrecognized argument(s); values withheld"],
  },
  {
    // §24.4: the count is the diagnostic, because a mistyped option can carry
    // a token and the parser would otherwise quote it back.
    name: "two arguments this command does not have",
    files: INSTANCE,
    args: ["{root}", "--open", "--and-print"],
    exit: 2,
    says: ["2 unrecognized argument(s); values withheld"],
  },
  {
    name: "a second instance to serve",
    files: INSTANCE,
    args: ["{root}", "{root}"],
    exit: 2,
    says: ["1 unrecognized argument(s)"],
  },
  {
    // §25.8: one diagnostic is one line, and an argument carrying a newline
    // must not split it into an unprefixed second one.
    name: "an argument carrying a newline",
    files: INSTANCE,
    args: ["{root}", "--port", "80\n81"],
    exit: 2,
    says: ["argument --port"],
  },

  // --- the instance --------------------------------------------------------
  {
    name: "an instance directory that is not there",
    args: ["{root}/absent"],
    exit: 1,
    says: ["invalid-root"],
  },
  {
    name: "an instance with no graph built yet",
    dirs: ["graph"],
    args: ["{root}"],
    exit: 1,
    says: ["not found; build it first"],
  },
  {
    name: "a graph that is a symlink out of the instance",
    files: { "elsewhere/atlas-graph.json": GRAPH },
    dirs: ["graph"],
    links: { "graph/atlas-graph.json": "../elsewhere/atlas-graph.json" },
    args: ["{root}"],
    exit: 1,
    says: ["unsafe-path"],
  },
  {
    // §24.4: the path is in the diagnostic and the diagnostic is one line, so
    // a control character a caller put in the path is shown as a `?` rather
    // than sent to the terminal to be obeyed.
    name: "an instance path carrying a character a terminal would act on",
    args: ["{root}/\x07\x1b[2Jnope"],
    exit: 1,
    says: ["??[2Jnope", "invalid-root"],
  },
  {
    // §24.4 again: the path is displayed, and a caller can hand this command a
    // path far longer than a line — so it is cut with a visible ellipsis
    // rather than withheld or printed whole.
    name: "an instance path longer than a diagnostic line",
    args: [`{root}/${"d".repeat(600)}`],
    exit: 1,
    says: ["…", "invalid-root"],
  },
  {
    name: "an instance reached through a symlinked root",
    files: { "real/graph/atlas-graph.json": GRAPH },
    links: { linked: "real" },
    args: ["{root}/linked"],
    exit: 1,
    says: ["invalid-root"],
  },

  // --- what it serves ------------------------------------------------------
  {
    name: "the viewer entry point, with its hardened headers",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    prints: ["serving http://127.0.0.1:"],
    steps: [
      {
        request: request("GET /viewer/index.html HTTP/1.1"),
        status: 200,
        holds: [
          "Content-Type: text/html; charset=utf-8",
          "Cache-Control: no-store",
          "X-Content-Type-Options: nosniff",
          "Referrer-Policy: no-referrer",
          "<!doctype html>",
        ],
      },
    ],
  },
  {
    name: "the graph, from the instance",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1"),
        status: 200,
        holds: ["Content-Type: application/json", '"format":"atlas-graph"'],
      },
    ],
  },
  {
    // §24: the bind is explicit, and no request can prove it. A server on
    // every interface answers byte-identical replies over loopback, so the
    // difference only exists at an address the instance was never offered to —
    // which is the address this case knocks on.
    name: "nothing answers away from loopback",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET /graph/atlas-graph.json HTTP/1.1"), status: 200 },
      { elsewhere: true, holds: ["refused away from loopback"] },
    ],
  },
  {
    // The whole table, named: five viewer files this engine checkout ships and
    // one graph. A route table computed at startup is only closed if the set it
    // computes is the set that answers, so the names next to it — a source file
    // the viewer is built from, a suffix nothing types, a directory — have to
    // be asked for too.
    name: "every route it mounted, and the neighbours it did not",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET /viewer/index.html HTTP/1.1"), status: 200 },
      { request: request("GET /viewer/viewer.js HTTP/1.1"), status: 200 },
      { request: request("GET /viewer/contract.js HTTP/1.1"), status: 200 },
      { request: request("GET /viewer/viewer.css HTTP/1.1"), status: 200 },
      {
        request: request("GET /viewer/favicon.svg HTTP/1.1"),
        status: 200,
        holds: ["Content-Type: image/svg+xml"],
      },
      { request: request("GET /viewer/src/viewer.ts HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/viewer.ts HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/src HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/favicon.ico HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/viewer.js.map HTTP/1.1"), status: 404 },
    ],
  },
  {
    // The body leaves in bounded chunks, and a graph is the one file that can
    // be far larger than a chunk. What proves the loop went round is the whole
    // file arriving with the length its own header claims.
    name: "a graph too big for a single read",
    files: { "graph/atlas-graph.json": BIG_GRAPH },
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1"),
        status: 200,
        holds: [`Content-Length: ${BIG_GRAPH.length}`, `${"x".repeat(150_000)}"}`],
      },
    ],
  },
  {
    name: "the other loopback name a person is as likely to type",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1", "localhost:{port}"),
        status: 200,
      },
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1", "LOCALHOST:{port}"),
        status: 200,
      },
    ],
  },
  {
    // A browser sends whatever host the page was loaded from, so a domain
    // re-pointed at 127.0.0.1 would otherwise read the instance from a page
    // atlas never served.
    name: "a host header naming somebody else",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1", "evil.test"),
        status: 400,
      },
    ],
  },
  {
    name: "a request with no host header at all",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [{ request: "GET /graph/atlas-graph.json HTTP/1.1\r\n\r\n", status: 400 }],
  },
  {
    // A client omits the port from Host only when it is the default one, and
    // this server is never on it — so the bare name addresses nobody here, and
    // neither does the right name on somebody else's port.
    name: "a host header with no port, and one with the wrong port",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET /graph/atlas-graph.json HTTP/1.1", "127.0.0.1"), status: 400 },
      { request: request("GET /graph/atlas-graph.json HTTP/1.1", "localhost"), status: 400 },
      { request: request("GET /graph/atlas-graph.json HTTP/1.1", "127.0.0.1:80"), status: 400 },
      { request: request("GET /graph/atlas-graph.json HTTP/1.1", "127.0.0.2:{port}"), status: 400 },
      { request: request("GET /graph/atlas-graph.json HTTP/1.1", ""), status: 400 },
    ],
  },
  {
    name: "a request carrying two host headers",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\n" +
          "Host: 127.0.0.1:{port}\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
      },
    ],
  },
  {
    name: "a head request, which answers the size and no body",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("HEAD /graph/atlas-graph.json HTTP/1.1"),
        status: 200,
        holds: ["Content-Length: 59"],
        bodyless: true,
      },
    ],
  },
  {
    name: "nothing outside the two routes it mounted",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET / HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/ HTTP/1.1"), status: 404 },
      { request: request("GET /graph/ HTTP/1.1"), status: 404 },
      { request: request("GET /atlas/ HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/index.html/ HTTP/1.1"), status: 404 },
    ],
  },
  {
    // The target is matched raw and never decoded, so there is nothing for a
    // traversal to walk through — every shape of it is simply an unknown name.
    name: "every shape of traversal",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET /graph/../viewer/index.html HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/../../etc/passwd HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/%2e%2e/index.html HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/index.html?x=1 HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/index.html#top HTTP/1.1"), status: 404 },
    ],
  },
  {
    // gh-87389: a leading run of slashes reads as an absolute URI without a
    // scheme to an HTTP client, so the handler collapses it before matching —
    // and the collapsed name is one of the two that answer.
    name: "a target beginning with a run of slashes",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET //viewer/index.html HTTP/1.1"), status: 200 },
      { request: request("GET /////viewer/index.html HTTP/1.1"), status: 200 },
      { request: request("GET //graph/atlas-graph.json HTTP/1.1"), status: 200 },
      // Only a leading run collapses; one in the middle is still a name that
      // was never mounted.
      { request: request("GET /viewer//index.html HTTP/1.1"), status: 404 },
    ],
  },
  {
    // The other half of the same rule, and the half a traversal case cannot
    // show: a name that would *become* a route by decoding is not that route.
    // `%2e%2e` proves nothing here — decoded it is still nothing mounted — so
    // the encoding has to spell a route that exists.
    name: "a target that would decode into a route",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("GET /viewer/index%2ehtml HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/index%2Ehtml HTTP/1.1"), status: 404 },
      { request: request("GET /%76iewer/index.html HTTP/1.1"), status: 404 },
      { request: request("GET /graph/atlas%2dgraph.json HTTP/1.1"), status: 404 },
      // A plus is a space to a form decoder and a plus to this one.
      { request: request("GET /viewer/index+html HTTP/1.1"), status: 404 },
    ],
  },

  // --- request lines a client should never send ----------------------------
  {
    name: "a request line that is empty",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [{ request: "\r\n", holds: [] }],
  },
  {
    name: "a request line that is only whitespace",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [{ request: "   \t \r\n\r\n", holds: [] }],
  },
  {
    name: "a request line with a fourth word",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: "GET /viewer/index.html and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET /viewer/index.html and more\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
    ],
  },
  {
    // A refused line is spelled back the way Python spells a string, and that
    // spelling is load-bearing rather than cosmetic: it picks the quote that
    // needs no escaping, and it writes a control character as an escape rather
    // than as itself — which is the only reason a status line quoting the
    // client's own bytes is still one line (§24.4, §25.8).
    name: "a refused line spelled back with quotes and control characters in it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET\r/x and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET\\r/x and HTTP/1.1'"],
      },
      {
        request: "GET /it's and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ['"GET /it\'s and HTTP/1.1"'],
      },
      {
        request: "GET /it's \"q\" and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET /it\\'s \"q\" and HTTP/1.1'"],
      },
      {
        request: "GET /a\x00b and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET /a\\x00b and HTTP/1.1'"],
      },
      {
        request: "GET /a\x7f\x9bb and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET /a\\x7f\\x9bb and HTTP/1.1'"],
      },
      {
        request: "GET /a\\b and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET /a\\\\b and HTTP/1.1'"],
      },
      // Only the newline is cut off the end, so whitespace in front of the
      // method is part of the line that gets spelled back.
      {
        request: "  GET /x and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'  GET /x and HTTP/1.1'"],
      },
      // A high byte that latin-1 decodes to a printable letter stays a letter.
      {
        request: "GET /caf\xe9 and HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
        holds: ["'GET /caf\xe9 and HTTP/1.1'"],
      },
    ],
  },
  {
    name: "words separated by something other than a space",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: "GET\t/viewer/index.html\tHTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET  /viewer/index.html  HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET\xa0/viewer/index.html\xa0HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
    ],
  },
  {
    name: "a request line ended by a bare newline",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [{ request: "GET /viewer/index.html HTTP/1.1\nHost: 127.0.0.1:{port}\r\n\r\n" }],
  },
  {
    // The version's digits are counted and converted, so a padded major that
    // no integer would hold is a bad version rather than version one.
    name: "a version padded past what a number may be",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: "GET /viewer/index.html HTTP/00000000001.1\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/01.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/1.1.1\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/1\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/.1\r\n\r\n" },
      { request: "GET /viewer/index.html HTTPS/1.1\r\n\r\n" },
      // Superscript two is a digit to Python and not a number to it.
      { request: "GET /viewer/index.html HTTP/\xb2.1\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/012.1\r\n\r\n" },
      // The first major this handler will not speak, which is the one right
      // above the one it does — a refusal at nine says nothing about two.
      { request: "GET /viewer/index.html HTTP/2.0\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET /viewer/index.html HTTP/1.9\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      // Five characters in, this one spells a version — but the five it is
      // asked to be are `HTTP/`, and these are not them.
      { request: "GET /viewer/index.html HTTP.1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
      { request: "GET /viewer/index.html xHTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
    ],
  },
  {
    name: "a host header folded across two lines",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n \r\n\r\n" },
      { request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHost:\r\n 127.0.0.1:{port}\r\n\r\n" },
      // A continuation carrying nothing but a tab still belongs to the value
      // above it, which is then not the value it was.
      { request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\t\r\n\r\n" },
    ],
  },
  {
    // Header shapes the mail parser accepts and a stricter reading would not:
    // the field name is matched case-insensitively, the run after the colon
    // that is stripped is spaces *and* tabs, and a head may end with bare
    // newlines throughout. Each of these is a 200 that a plausible tightening
    // would turn into a 400.
    name: "header shapes that still address this server",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET /graph/atlas-graph.json HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
      {
        request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHOST: 127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
      {
        request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHost:\t127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
      {
        request: "GET /graph/atlas-graph.json HTTP/1.1\nHost: 127.0.0.1:{port}\n\n",
        status: 200,
      },
    ],
  },
  {
    // And the shape it does not: a space inside the field name is not a name
    // at all, so the line is where the head stops and the Host below it is
    // never read — the same refusal a line with no colon produces.
    name: "a header name with a space in it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\nBad Name: x\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 400,
      },
    ],
  },
  {
    name: "a header line with no colon in it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: "GET /graph/atlas-graph.json HTTP/1.1\r\nnonsense\r\nHost: 127.0.0.1:{port}\r\n\r\n" },
    ],
  },
  {
    // Two lines the mail parser reads as headers although neither looks like
    // one: `From ` with no colon is a mailbox separator it still accepts, and a
    // colon in the first column names an empty field it drops. Both keep the
    // head open, so the Host underneath them is a Host the server does see —
    // which is the opposite of the line above.
    name: "header lines that are not headers and do not end the head",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\n" +
          "From person@example.test\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\n" +
          ": nothing\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
      // A continuation with no header above it belongs to nothing at all.
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\n" +
          " leading\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: 200,
      },
    ],
  },
  {
    // §24.4 again, from the other side: more headers than the parser will read
    // is refused by their count, and the request's own bytes stay unquoted.
    name: "more headers than the parser will read",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n" +
          Array.from({ length: 120 }, (_, at) => `X-Pad-${at}: private-vera\r\n`).join("") +
          "\r\n",
        status: 431,
      },
    ],
  },
  {
    // Where that limit actually falls, which a request of a hundred and twenty
    // headers cannot show. The parser counts the blank line that ends the head
    // as one of the hundred, so ninety-nine headers plus their terminator is
    // the last request it will read — and the hundredth header is one too many
    // even though a hundred is the stated limit.
    name: "the last header the parser will read, and the one past it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: padded(98), status: 200 },
      { request: padded(99), status: 431, holds: ["Too many headers"] },
    ],
  },
  {
    // The other ceiling in the same place, and the other refusal it produces:
    // one header may be as long as a whole request line, and one byte more is
    // a different complaint from too many of them.
    name: "a header line at the ceiling and one byte past it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n" +
          `${longHeader(REQUEST_LINE_BYTES)}\r\n`,
        status: 200,
      },
      {
        request:
          `GET /graph/atlas-graph.json HTTP/1.1\r\n${longHeader(REQUEST_LINE_BYTES + 1)}`,
        status: 431,
        holds: ["Line too long"],
      },
      // The same refusal for a header line the client never ends, which is the
      // only way the ceiling can be met before a newline is seen.
      {
        request:
          "GET /graph/atlas-graph.json HTTP/1.1\r\nX-Pad: " +
          "x".repeat(REQUEST_LINE_BYTES + 1 - "X-Pad: ".length),
        status: 431,
        holds: ["Line too long"],
      },
    ],
  },
  {
    // Wrong in two places at once, which is the only way to see which one is
    // read first: the request line is parsed and answered before a single
    // header is measured, so this is a bad version and not a header refusal.
    name: "a request line and a header block that are both refusable",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: `GET /graph/atlas-graph.json HTTP/x\r\n${pads(120)}\r\n`,
        status: null,
        holds: ["Error code: 400", "Bad request version"],
      },
    ],
  },
  {
    // §24.4: a 404 body says a name was not routed, never which name.
    name: "a refusal that does not echo what was asked for",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /viewer/PRIVATE-VERA-SECRET.js HTTP/1.1"),
        status: 404,
        holds: ["Nothing matches the given URI"],
      },
    ],
  },
  {
    name: "no route that accepts a write",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      { request: request("POST /graph/atlas-graph.json HTTP/1.1"), status: 501 },
      { request: request("PUT /graph/atlas-graph.json HTTP/1.1"), status: 501 },
      { request: request("DELETE /graph/atlas-graph.json HTTP/1.1"), status: 501 },
      { request: request("OPTIONS /viewer/index.html HTTP/1.1"), status: 501 },
    ],
  },
  {
    // An error body is HTML carrying a word the client chose, so the three
    // characters that could close a tag are escaped on the way in. The status
    // line above it is not HTML and keeps the word as it arrived, which is why
    // both spellings appear in one reply.
    name: "a method spelled with the characters that close a tag",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("PATCH<&> /graph/atlas-graph.json HTTP/1.1"),
        status: 501,
        holds: [
          "501 Unsupported method ('PATCH<&>')",
          "Message: Unsupported method ('PATCH&lt;&amp;&gt;').",
        ],
      },
    ],
  },
  {
    name: "a request line that is not one",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "BOGUS\r\n\r\n",
        status: null,
        holds: ["Error code: 400", "Bad request syntax"],
      },
    ],
  },
  {
    name: "a version from a protocol this is not",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET /viewer/index.html HTTP/9.9\r\n\r\n",
        status: null,
        holds: ["Error code: 505", "Invalid HTTP version (9.9)"],
      },
    ],
  },
  {
    name: "a version that is not a version",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET /viewer/index.html HTTP/x\r\n\r\n",
        status: null,
        holds: ["Error code: 400", "Bad request version"],
      },
    ],
  },
  {
    name: "a request older than the version line",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "POST /viewer/index.html\r\n\r\n",
        status: null,
        holds: ["Error code: 400", "Bad HTTP/0.9 request type"],
      },
    ],
  },
  {
    // The success half of the same rule, which the refusal above hides: a GET
    // with no version is HTTP/0.9, and HTTP/0.9 has no response head at all.
    // The oracle sends the file and nothing else — no status line, no headers.
    // A port that answered this one with `HTTP/1.0 200 OK` would be prepending
    // its own head to the body of every 0.9 client.
    name: "a request older than the version line, answered",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET /graph/atlas-graph.json\r\nHost: 127.0.0.1:{port}\r\n\r\n",
        status: null,
        holds: ['"format":"atlas-graph"'],
      },
    ],
  },
  {
    // A bare CR inside the header block. CPython reads headers through
    // `email.feedparser`, which treats CR, LF and CRLF alike as line
    // boundaries — so this is a well-formed Host followed by a second header,
    // not one Host value with a control character in it.
    name: "a header block split by a bare carriage return",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: "GET /graph/atlas-graph.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\rX: y\r\n\r\n",
        status: 200,
      },
    ],
  },
  {
    // The request line is measured before it is parsed, so an enormous target
    // is refused rather than walked — and never printed. The pair is the whole
    // point: a ceiling proves nothing until a line one byte under it is read
    // and the same line one byte over it is not, because every off-by-one here
    // is a ceiling that still looks like a ceiling.
    //
    // Nothing follows the over-long line: the oracle answers and closes with
    // the client's bytes still unread otherwise, and a reset connection would
    // make this case argue with the network instead of with the port.
    name: "a request line at the ceiling and one byte past it",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: `${longLine(REQUEST_LINE_BYTES)}Host: 127.0.0.1:{port}\r\n\r\n`,
        status: 404,
      },
      {
        request: longLine(REQUEST_LINE_BYTES + 1),
        status: 414,
        holds: ["URI is too long"],
      },
    ],
  },
  {
    // A line the client never ends is measured all the same: the read stops at
    // the ceiling rather than waiting for a newline that is not coming, so a
    // client can neither hold the socket nor make the server keep the bytes.
    name: "a request line that never ends",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: `GET /${"x".repeat(REQUEST_LINE_BYTES + 1 - "GET /".length)}`,
        status: 414,
        holds: ["URI is too long"],
      },
    ],
  },

  // --- the tree moving underneath it ---------------------------------------
  {
    // Every read repeats the §24.2 containment checks, so a graph replaced by
    // a symlink while the server runs stops being served — the route table
    // remembers a name, never a descriptor.
    //
    // The `says` claim is what separates this from a file that is simply
    // absent: both answer 404 on the wire, and only a refusal reaches the
    // operator, carrying the reader's reason and no content (§24.4).
    name: "a graph swapped for a symlink while it is being served",
    files: { ...INSTANCE, "elsewhere/atlas-graph.json": GRAPH },
    args: ["{root}", "--port", "{port}"],
    says: ["unsafe-path"],
    steps: [
      { request: request("GET /graph/atlas-graph.json HTTP/1.1"), status: 200 },
      { remove: "graph/atlas-graph.json" },
      { link: ["graph/atlas-graph.json", "../elsewhere/atlas-graph.json"] },
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1"),
        status: 404,
      },
    ],
  },
  {
    name: "a graph rebuilt between two requests",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    steps: [
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1"),
        status: 200,
        holds: ['"edges":[]'],
      },
      { write: ["graph/atlas-graph.json", REBUILT] },
      {
        request: request("GET /graph/atlas-graph.json HTTP/1.1"),
        status: 200,
        holds: ['"edges":[[]]'],
      },
    ],
  },
  {
    // The other half of the pair above: a file that is merely gone is not a
    // refusal, so it answers the same 404 and says nothing to the operator.
    name: "a graph deleted while the server is up",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    says: [],
    steps: [
      { request: request("GET /graph/atlas-graph.json HTTP/1.1"), status: 200 },
      { remove: "graph/atlas-graph.json" },
      { request: request("GET /graph/atlas-graph.json HTTP/1.1"), status: 404 },
      { request: request("GET /viewer/index.html HTTP/1.1"), status: 200 },
    ],
  },
  {
    // §25.8: request lines are not ERROR:-prefixed diagnostics, so they are
    // not printed at all. Serving a hundred files must leave stderr empty.
    name: "a served request that says nothing",
    files: INSTANCE,
    args: ["{root}", "--port", "{port}"],
    says: [],
    steps: [
      { request: request("GET /viewer/index.html HTTP/1.1"), status: 200 },
      { request: request("GET /nope HTTP/1.1"), status: 404 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Running one case on one side
// ---------------------------------------------------------------------------

const workspace = fs.realpathSync(fs.mkdtempSync("/tmp/atlas-serve-"));

function materialize(root: string, item: Case): void {
  fs.mkdirSync(root, { recursive: true });
  for (const directory of item.dirs ?? []) {
    fs.mkdirSync(`${root}/${directory}`, { recursive: true });
  }
  for (const [relative, content] of Object.entries(item.files ?? {})) {
    const cut = relative.lastIndexOf("/");
    if (cut > 0) fs.mkdirSync(`${root}/${relative.slice(0, cut)}`, { recursive: true });
    fs.writeFileSync(`${root}/${relative}`, content);
  }
  for (const [link, target] of Object.entries(item.links ?? {})) {
    const cut = link.lastIndexOf("/");
    if (cut > 0) fs.mkdirSync(`${root}/${link.slice(0, cut)}`, { recursive: true });
    fs.symlinkSync(target, `${root}/${link}`);
  }
}

/** A port nothing is listening on, asked of the kernel and handed straight back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Send one raw request and read until the server closes, as HTTP/1.0 does. */
function speak(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(Buffer.from(payload, "latin1"));
    });
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => resolve("<connection failed>"));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}

/** An address of this machine that is not loopback, if it has one. */
const OTHER_ADDRESS: string | null = (() => {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
})();

/**
 * Whether the port answers at an address that is not loopback.
 *
 * The one property no request can show: a server listening on every interface
 * sends byte-identical replies over loopback, so the difference is only ever
 * visible from somewhere else.
 */
function reachable(port: number): Promise<string> {
  if (OTHER_ADDRESS === null) {
    return Promise.resolve("<this machine has no other address>");
  }
  return new Promise((resolve) => {
    const refused = (): void => {
      socket.destroy();
      resolve("refused away from loopback");
    };
    const socket = net.createConnection({ port, host: OTHER_ADDRESS }, () => {
      socket.destroy();
      resolve("answered away from loopback");
    });
    socket.setTimeout(5_000, refused);
    socket.on("error", refused);
  });
}

/** Wait until something answers on the port, or give up. */
async function ready(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return true;
    await sleep(25);
  }
  return false;
}

interface Outcome {
  readonly exit: number | null | "still running";
  readonly out: string;
  readonly err: string;
  readonly replies: string[];
}

/** How long a command that was supposed to exit is given to do it. */
const EXIT_DEADLINE_MS = 20_000;

/**
 * The child's exit code, or a marker when it never got round to exiting.
 *
 * A refusal that starts serving instead is one of the more interesting ways
 * this program could be wrong — an argument the parser was meant to reject
 * would put a private instance on a port — and waiting for it to exit would
 * turn that into a harness that reports nothing at all rather than a
 * divergence.
 */
function settled(child: ReturnType<typeof Bun.spawn>): Promise<number | "still running"> {
  return new Promise((resolve) => {
    const alarm = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("still running");
    }, EXIT_DEADLINE_MS);
    void child.exited.then((code) => {
      clearTimeout(alarm);
      resolve(code);
    });
  });
}

// The clock and the port are the two things that cannot be the same twice.
function fold(text: string, root: string, port: number): string {
  return text
    .replaceAll(root, "«root»")
    .replaceAll(workspace, "«workspace»")
    .replaceAll(String(port), "«port»")
    .replaceAll(/^Date: .*$/gm, "Date: «now»")
    .replaceAll(/serve_instance\.(py|ts)/g, "«program»")
    .replaceAll(/build_atlas_graph\.(py|ts)/g, "«builder»");
}

async function once(side: string, index: number, item: Case, argv: string[]): Promise<Outcome> {
  const root = `${workspace}/${side}-${index}`;
  materialize(root, item);
  const port = await freePort();
  const args = item.args.map((argument) =>
    argument.replaceAll("{root}", root).replaceAll("{port}", String(port)),
  );
  const child = Bun.spawn([...argv, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    // Inherited unless a case says otherwise: the two sides differ in
    // the program under test and nothing else.
    env: item.env === undefined ? undefined : { ...process.env, ...item.env },
  });

  const replies: string[] = [];
  if (item.steps !== undefined) {
    if (await ready(port)) {
      for (const step of item.steps) {
        if (step.write !== undefined) {
          fs.writeFileSync(`${root}/${step.write[0]}`, step.write[1]);
        } else if (step.link !== undefined) {
          fs.symlinkSync(step.link[1], `${root}/${step.link[0]}`);
        } else if (step.remove !== undefined) {
          fs.rmSync(`${root}/${step.remove}`, { force: true });
        } else if (step.elsewhere === true) {
          replies.push(await reachable(port));
        } else if (step.request !== undefined) {
          replies.push(
            fold(
              await speak(port, step.request.replaceAll("{port}", String(port))),
              root,
              port,
            ),
          );
        }
      }
    } else {
      replies.push("<never listened>");
    }
    child.kill("SIGKILL");
  }

  const exit = await settled(child);
  const out = fold(await new Response(child.stdout).text(), root, port);
  const err = fold(await new Response(child.stderr).text(), root, port);
  // A killed server has no exit code worth comparing; a startup refusal does.
  return { exit: item.steps === undefined ? exit : null, out, err, replies };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** Divergences with an issue behind them, counted apart rather than hidden. */
const KNOWN: ReadonlyMap<string, string> = new Map([
  ["the help text at a terminal width that is not the default", "#135"],
]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
const stillDiverging = new Set<string>();

/** The status code on a reply's first line, or null when it sent none. */
function statusOf(reply: string): number | null {
  const match = /^HTTP\/1\.[01] (\d{3}) /.exec(reply);
  return match === null ? null : Number(match[1]);
}

for (const [index, item] of cases.entries()) {
  // The two side directories are named to the same length on purpose: a
  // diagnostic that cuts a path at a fixed number of characters would
  // otherwise cut it in two different places and disagree about nothing.
  const theirs = await once("oracle", index, item, ["python3", `${ROOT}/serve_instance.py`]);
  const mine = await once("ported", index, item, ["bun", `${ROOT}/serve_instance.ts`]);

  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      continue;
    }
    diverged += 1;
    console.error(`serve: ${item.name}`);
    if (mine.exit !== theirs.exit) {
      console.error(`  exit mine: ${mine.exit} oracle: ${theirs.exit}`);
    }
    if (mine.out !== theirs.out) {
      console.error(`  out mine:    ${JSON.stringify(mine.out)}`);
      console.error(`  out oracle:  ${JSON.stringify(theirs.out)}`);
    }
    if (mine.err !== theirs.err) {
      console.error(`  err mine:    ${JSON.stringify(mine.err)}`);
      console.error(`  err oracle:  ${JSON.stringify(theirs.err)}`);
    }
    for (const [at, reply] of theirs.replies.entries()) {
      if (reply !== mine.replies[at]) {
        console.error(`  reply ${at} mine:   ${JSON.stringify(mine.replies[at])}`);
        console.error(`  reply ${at} oracle: ${JSON.stringify(reply)}`);
      }
    }
    continue;
  }

  // And what the case claims, read off the oracle's own answer.
  const complaints: string[] = [];
  if (item.exit !== undefined && theirs.exit !== item.exit) {
    complaints.push(`exited ${theirs.exit} against the claimed ${item.exit}`);
  }
  for (const phrase of item.says ?? []) {
    if (!theirs.err.includes(phrase)) complaints.push(`never said ${phrase}`);
  }
  if (item.says !== undefined && item.says.length === 0 && theirs.err !== "") {
    complaints.push("said something about a run claimed silent");
  }
  for (const phrase of item.prints ?? []) {
    if (!theirs.out.includes(phrase)) complaints.push(`never printed ${phrase}`);
  }
  let at = 0;
  for (const step of item.steps ?? []) {
    if (step.request === undefined && step.elsewhere !== true) continue;
    const reply = theirs.replies[at] as string;
    if (step.status !== undefined && statusOf(reply) !== step.status) {
      complaints.push(`reply ${at} answered ${statusOf(reply)}, not ${step.status}`);
    }
    for (const phrase of step.holds ?? []) {
      if (!reply.includes(phrase)) complaints.push(`reply ${at} never held ${phrase}`);
    }
    if (step.bodyless === true && !reply.endsWith("\r\n\r\n")) {
      complaints.push(`reply ${at} carried a body it was claimed not to have`);
    }
    at += 1;
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`serve: ${item.name}: the oracle ${complaints.join("; ")}`);
    if (theirs.err !== "") console.error(`  ${theirs.err.trimEnd()}`);
  }
}

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(`serve: ${name}: recorded as a divergence and no longer one`);
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(
  `serve: ${cases.length} cases compared, ${diverged} unexplained, ` +
    `${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
