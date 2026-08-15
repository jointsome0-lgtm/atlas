// Serving one private instance's viewer over a stable loopback origin (#112).
//
// The viewer is static and fetches `../graph/atlas-graph.json` relatively, so
// it needs an HTTP origin where `viewer/` and `graph/` are siblings. This
// mounts exactly that pair: the viewer files of the engine checkout it ships
// with, and the instance's emitted graph — nothing else.
//
// Read-only by construction (§24): an explicit 127.0.0.1 bind, GET/HEAD only, a
// closed route table computed at startup (no directory listing, no path
// traversal, no write path), and every read repeats the §24.2 no-follow
// containment checks. Building the graph stays with the builder — a serving
// command never writes into the instance.
//
// Ported from scripts/serve_instance.py. The oracle is CPython's
// BaseHTTPRequestHandler, whose wire output is not a framework's: HTTP/1.0
// responses, a `Server:` header with a trailing space, an HTML error template,
// and a malformed request line answered with a body and no status line at all.
// A response builder that produced *reasonable* bytes instead would be a
// different server, so the bytes are written here directly rather than through
// one — this file speaks HTTP because the thing it replaces did.

import net from "node:net";
import fs from "node:fs";

import { AtlasReader, ReaderError, type ScannedFile } from "./reader.ts";
import { PosixError } from "./posix.ts";

const ROOT = `${import.meta.dir}/../..`;

// An embedding shell allowlists this origin in its CSP frame-src (§16.4,
// ephemeris#108), so the port is a published default, never incidental.
export const DEFAULT_PORT = 8138;

// A displayed path is cut here: long enough for any real instance path,
// short enough that one ERROR: line stays a line.
const PATH_DIAGNOSTIC_LIMIT = 512;

/** The port an http client leaves out of its Host header. */
const HTTP_DEFAULT_PORT = 80;

/** Response bodies leave the server in chunks of this size, never whole. */
const BODY_CHUNK_BYTES = 65536;

/** CPython's request-line ceiling, and the size that answers 414. */
const REQUEST_LINE_BYTES = 65536;

/** The same ceiling, applied a line at a time to the headers, which answer 431. */
const HEADER_LINE_BYTES = 65536;

const GRAPH_RELATIVE_PATH = "graph/atlas-graph.json";
const GRAPH_ROUTE = "/graph/atlas-graph.json";
const VIEWER_ROUTE_PREFIX = "/viewer/";
export const INDEX_ROUTE = `${VIEWER_ROUTE_PREFIX}index.html`;

// Fail-closed content typing: a viewer file whose suffix is not listed here is
// not routed at all, so no response type is ever guessed or sniffed.
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
]);

// Routes are matched against the raw request path, never a percent-decoded one
// (decoding is the traversal surface), so a routable name must need no
// encoding.
const UNRESERVED =
  /^[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\-._]*$/;

/** Characters CPython's `str.isprintable` keeps: not Other, not Separator. */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/**
 * Render a value with non-printables folded to `?`, optionally bounded.
 *
 * §24.4 wants the path in the diagnostic and the diagnostic bounded: a caller
 * can hand this command a megabyte-long argument, so a displayed path is cut
 * with a visible ellipsis rather than withheld.
 */
export function printable(value: string, limit?: number): string {
  let text = "";
  for (const character of value) {
    text += character === " " || !UNPRINTABLE.test(character) ? character : "?";
  }
  // Cut by code point, as CPython's slice of a str does, not by UTF-16 unit.
  if (limit !== undefined) {
    const points = [...text];
    if (points.length > limit) return `${points.slice(0, limit).join("")}…`;
  }
  return text;
}

export function shownPath(value: string): string {
  return printable(value, PATH_DIAGNOSTIC_LIMIT);
}

/**
 * Write one ERROR:-prefixed line per line of a message.
 *
 * A caller-supplied path can carry a newline, and the usage error quotes the
 * arguments it was given: without this a single argument could split a
 * diagnostic into an unprefixed second line (§25.8) or smuggle control
 * characters into it (§24.4).
 */
export function diagnose(message: string): void {
  for (const line of printable(message).split("\n")) {
    process.stderr.write(`ERROR: ${line}\n`);
  }
}

/** One served file, re-opened under §24.2 containment on every request. */
interface Route {
  readonly reader: AtlasReader;
  readonly relativePath: string;
  readonly contentType: string;
}

/** Open the route's file no-follow, or return null when it is not there. */
function openRoute(route: Route): number | null {
  const scanned = route.reader.optionalFile(route.relativePath);
  if (scanned === null) return null;
  return scanned.open();
}

const suffixOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  // `PurePath.suffix` is empty for a dotfile with no other dot, and for a
  // trailing dot; both would otherwise look like a suffix of their own.
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot);
};

/** Compute the closed route table: the engine's viewer plus one graph. */
export function buildRoutes(
  viewerReader: AtlasReader,
  instanceReader: AtlasReader,
): Map<string, Route> {
  const routes = new Map<string, Route>();
  for (const scanned of viewerReader.scan(".")) {
    const contentType = CONTENT_TYPES.get(suffixOf(scanned.name));
    if (contentType === undefined || !UNRESERVED.test(scanned.name)) continue;
    routes.set(VIEWER_ROUTE_PREFIX + scanned.name, {
      reader: viewerReader,
      relativePath: scanned.name,
      contentType,
    });
  }
  routes.set(GRAPH_ROUTE, {
    reader: instanceReader,
    relativePath: GRAPH_RELATIVE_PATH,
    contentType: CONTENT_TYPES.get(".json") as string,
  });
  return routes;
}

/**
 * The Host values that address this server — and no others.
 *
 * The origin atlas announces, plus the name a person is as likely to type;
 * both resolve to loopback and neither is attacker-choosable. On port 80 a
 * client leaves the port out of Host, so the bare names address it too.
 */
export function originsFor(port: number): Set<string> {
  const names = ["127.0.0.1", "localhost"];
  const origins = names.map((name) => `${name}:${port}`);
  if (port === HTTP_DEFAULT_PORT) origins.push(...names);
  return new Set(origins);
}

// ---------------------------------------------------------------------------
// The arguments
// ---------------------------------------------------------------------------

interface Arguments {
  readonly instance: string;
  readonly port: number;
}

/** The usage line, in the shape the oracle's argument parser prints it. */
const usageLine = (program: string): string =>
  `usage: ${program} [-h] [--port PORT] INSTANCE_DIR`;

/**
 * The help text, laid out at the width the oracle's parser uses off a tty.
 *
 * The oracle wraps to the terminal width and falls back to 80 columns when
 * there is no terminal, which is every non-interactive caller and every test.
 * That fallback is the layout reproduced here; the port has one layout rather
 * than a terminal-dependent one, which is the same text in every place a
 * caller could have compared them.
 */
function helpText(program: string): string {
  return (
    `${usageLine(program)}\n` +
    "\n" +
    "Serve a private Atlas instance's viewer on 127.0.0.1.\n" +
    "\n" +
    "positional arguments:\n" +
    "  INSTANCE_DIR  private instance root holding graph/atlas-graph.json; atlas\n" +
    "                never guesses or remembers its location\n" +
    "\n" +
    "options:\n" +
    "  -h, --help    show this help message and exit\n" +
    `  --port PORT   loopback port (default ${DEFAULT_PORT}); the embed's fixed origin\n`
  );
}

/**
 * The characters `int()` skips around a number.
 *
 * Neither `String.trim()` nor `str.strip()`: `int()` rewrites the string
 * before it parses it, and that pass only asks Unicode about characters past
 * ASCII. So the next-line character is skipped and the file separator — which
 * `str.strip()` does remove — is not, and the byte-order mark `trim()` removes
 * is not skipped either.
 */
const INT_SPACE =
  "[\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000]";
const INT_STRIP = new RegExp(`^${INT_SPACE}+|${INT_SPACE}+$`, "gu");

/**
 * The value of one decimal digit, in any script that writes them.
 *
 * `int()` reads every character Unicode gives a decimal value, not the ten
 * ASCII ones, so `--port ٨١٣٨` is port 8138 to the oracle. Unicode encodes
 * each set of ten contiguously and in ascending order, so a digit's value is
 * its distance from the start of the run of digits it sits in, and the runs
 * that abut (the mathematical alphanumerics) are whole sets end to end — hence
 * the remainder. The runtime's Unicode table can be newer than the oracle's,
 * which is a difference about which scripts have digits at all.
 */
function decimalValue(digit: string): number {
  const isDigit = (code: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(code));
  const code = digit.codePointAt(0) as number;
  let start = code;
  while (start > 0 && isDigit(start - 1)) start -= 1;
  return (code - start) % 10;
}

function portNumber(value: string): number | string {
  // CPython's `int()` takes surrounding whitespace, a sign, and underscores
  // between digits; anything else is the same refusal as a word.
  const text = value.replace(INT_STRIP, "");
  const digits = /^[+-]?(\p{Nd}(?:_?\p{Nd})*)$/u.exec(text);
  if (digits === null) return "port must be an integer";
  const sign = text.startsWith("-") ? -1 : 1;
  const written = [...(digits[1] as string)]
    .filter((character) => character !== "_")
    .map((character) => decimalValue(character))
    .join("");
  const port = sign * Number(written);
  if (port === 0) {
    // Port 0 asks the kernel for whatever is free; a shell that has to
    // allowlist the origin cannot allowlist a surprise (§16.4).
    return (
      "port must be fixed: 0 picks a random port and the embedding shell " +
      "pins one origin"
    );
  }
  if (!(port >= 1 && port <= 65535)) return "port must be between 1 and 65535";
  return port;
}

type Parsed =
  | { readonly kind: "args"; readonly args: Arguments }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/** Every option string, in the order the oracle's parser was given them. */
const OPTION_STRINGS = ["-h", "--help", "--port"] as const;

/** What the parser's own message calls each option it can complain about. */
const OPTION_NAMES: ReadonlyMap<string, string> = new Map([
  ["--help", "-h/--help"],
  ["--port", "--port"],
]);

/** One argument, classified the way `_parse_optional` classifies it. */
type Word =
  | { readonly kind: "positional"; readonly value: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous" }
  | {
      readonly kind: "option";
      /** The action addressed, named by its long spelling. */
      readonly option: "--help" | "--port";
      /** Whether the caller spelled it with one dash, which changes a refusal. */
      readonly short: boolean;
      /** A value attached to the word itself, by `=` or by juxtaposition. */
      readonly explicit: string | null;
      /**
       * How that value was attached: `=` or nothing at all.
       *
       * The parser keeps these apart, and for an option that takes no value it
       * is the whole difference between printing help and refusing: `-hx` is
       * `-h` followed by more short options, `-h=x` is `-h` handed an argument
       * it has no use for.
       */
      readonly sep: "=" | "" | null;
    };

const asOption = (
  option: string,
  short: boolean,
  explicit: string | null,
  sep: "=" | "" | null,
): Word => ({
  kind: "option",
  option: (option === "-h" ? "--help" : option) as "--help" | "--port",
  short,
  explicit,
  sep,
});

/**
 * Read one argument as the oracle's parser reads it, before anything is used.
 *
 * The order is argparse's and it is load-bearing: an exact spelling wins, then
 * an exact spelling with `=value`, then an unambiguous *prefix* — `--po` is
 * `--port` because `allow_abbrev` is on by default — and only what is left
 * over is measured against the two rules that hand a word back to the
 * positionals: a negative number (there are no options here that look like
 * one) and an argument with a space in it, which was meant to be a path.
 */
function classify(argument: string): Word {
  const positional = { kind: "positional", value: argument } as const;
  if (argument === "" || !argument.startsWith("-")) return positional;
  // A lone dash names a file by convention, so it is never an option.
  if (argument === "-") return positional;
  if ((OPTION_STRINGS as readonly string[]).includes(argument)) {
    return asOption(argument, !argument.startsWith("--"), null, null);
  }
  const equals = argument.indexOf("=");
  const beforeEquals = equals < 0 ? argument : argument.slice(0, equals);
  const afterEquals = equals < 0 ? null : argument.slice(equals + 1);
  if (equals >= 0 && (OPTION_STRINGS as readonly string[]).includes(beforeEquals)) {
    return asOption(beforeEquals, !beforeEquals.startsWith("--"), afterEquals, "=");
  }
  const matches: Word[] = [];
  if (argument.startsWith("--")) {
    // Two dashes: the word is split at `=` and the rest is a prefix. `--=1`
    // has the empty prefix, which is every option at once.
    for (const option of OPTION_STRINGS) {
      if (option.startsWith(beforeEquals)) {
        matches.push(asOption(option, false, afterEquals, afterEquals === null ? null : "="));
      }
    }
  } else {
    // One dash: a short option carries its value in the same word, so `-hx`
    // addresses `-h` and hands it an `x` with nothing between them.
    for (const option of OPTION_STRINGS) {
      if (option === argument.slice(0, 2)) {
        matches.push(asOption(option, true, argument.slice(2), ""));
      } else if (option.startsWith(argument)) matches.push(asOption(option, false, null, null));
    }
  }
  if (matches.length > 1) return { kind: "ambiguous" };
  if (matches.length === 1) return matches[0] as Word;
  if (/^-\d+$|^-\d*\.\d+$/.test(argument)) return positional;
  if (argument.includes(" ")) return positional;
  return { kind: "unknown" };
}

/** A word the parser kept: an ambiguous one never becomes anything. */
type Placed = Exclude<Word, { readonly kind: "ambiguous" }>;

export function parseArgs(argv: readonly string[]): Parsed {
  // Every argument is classified before any of them is used: argparse builds
  // its whole pattern first, which is why an ambiguous option later in the
  // line is refused even though `-h` came earlier and would have printed help.
  const words: Placed[] = [];
  let separated = false;
  for (const argument of argv) {
    if (separated) {
      words.push({ kind: "positional", value: argument });
      continue;
    }
    // The first bare `--` is the separator itself and is not a word.
    if (argument === "--") {
      separated = true;
      continue;
    }
    const word = classify(argument);
    if (word.kind === "ambiguous") {
      return {
        kind: "error",
        message: `ambiguous option: ${argument} could match --help, --port`,
      };
    }
    words.push(word);
  }

  const positional: string[] = [];
  let unrecognized = 0;
  let port: number = DEFAULT_PORT;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as Placed;
    if (word.kind === "positional") {
      // A bare word past the first is a positional this parser does not have.
      if (positional.length === 0) positional.push(word.value);
      else unrecognized += 1;
      continue;
    }
    if (word.kind === "unknown") {
      unrecognized += 1;
      continue;
    }
    if (word.option === "--help") {
      // Help takes no value, so a value attached to it is refused — except in
      // the one shape that is not a value at all: a one-dash spelling whose
      // tail is more short options, written without an `=` and not starting
      // with a dash of its own. `-hx` is `-h -x`, and help fires before the
      // tail is looked at; `-h=x`, `-h-x` and `-h=` are refusals.
      const tail =
        word.explicit !== null &&
        word.explicit !== "" &&
        word.short &&
        word.sep === "" &&
        !word.explicit.startsWith("-");
      if (word.explicit !== null && !tail) {
        return {
          kind: "error",
          message: `argument -h/--help: ignored explicit argument ${pythonRepr(word.explicit)}`,
        };
      }
      return { kind: "help" };
    }
    let value = word.explicit;
    if (value === null) {
      // The next word is the value only if it is a value: an option-looking
      // word leaves `--port` with nothing, exactly as the pattern match does.
      const next = words[index + 1];
      if (next === undefined || next.kind !== "positional") {
        return { kind: "error", message: "argument --port: expected one argument" };
      }
      value = next.value;
      index += 1;
    }
    const answer = portNumber(value);
    if (typeof answer === "string") {
      const name = OPTION_NAMES.get(word.option) as string;
      return { kind: "error", message: `argument ${name}: ${answer}` };
    }
    port = answer;
  }
  // A missing INSTANCE_DIR is refused inside the parse, and the arguments it
  // could not place are only counted after the parse returns.
  if (positional.length === 0) {
    return {
      kind: "error",
      message: "the following arguments are required: INSTANCE_DIR",
    };
  }
  if (unrecognized > 0) {
    // Quoting the rejected arguments verbatim would echo them, and a mistyped
    // option can carry a token: the count is the diagnostic (§24.4), the usage
    // line says what was expected.
    return {
      kind: "error",
      message: `${unrecognized} unrecognized argument(s); values withheld`,
    };
  }
  return { kind: "args", args: { instance: positional[0] as string, port } };
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

const STATUS_TEXT: ReadonlyMap<number, [string, string]> = new Map([
  [400, ["Bad Request", "Bad request syntax or unsupported method"]],
  [404, ["Not Found", "Nothing matches the given URI"]],
  [414, ["Request-URI Too Long", "URI is too long"]],
  [
    431,
    [
      "Request Header Fields Too Large",
      "The server is unwilling to process the request because its header " +
        "fields are too large",
    ],
  ],
  [501, ["Not Implemented", "Server does not support this operation"]],
  [505, ["HTTP Version Not Supported", "Cannot fulfill request"]],
]);

/** `html.escape(text, quote=False)`: the three that can close a tag. */
const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function errorBody(code: number, message: string, explain?: string): Buffer {
  const explanation = explain ?? (STATUS_TEXT.get(code) as [string, string])[1];
  return Buffer.from(
    "<!DOCTYPE HTML>\n" +
      '<html lang="en">\n' +
      "    <head>\n" +
      '        <meta charset="utf-8">\n' +
      "        <title>Error response</title>\n" +
      "    </head>\n" +
      "    <body>\n" +
      "        <h1>Error response</h1>\n" +
      `        <p>Error code: ${code}</p>\n` +
      `        <p>Message: ${escapeHtml(message)}.</p>\n` +
      `        <p>Error code explanation: ${code} - ${escapeHtml(explanation)}.</p>\n` +
      "    </body>\n" +
      "</html>\n",
    "utf8",
  );
}

/** `email.utils.formatdate(usegmt=True)`, which is `Date:`'s only format. */
const httpDate = (): string => new Date().toUTCString();

interface Reply {
  readonly status: number;
  /** The reason phrase on the status line, which 501 overrides. */
  readonly phrase: string;
  readonly headers: ReadonlyArray<[string, string]>;
  readonly body: Buffer | null;
  /** A malformed request line has no version, so no status line is sent. */
  readonly headless: boolean;
}

function errorReply(code: number, phrase?: string, headless = false, explain?: string): Reply {
  const message = phrase ?? (STATUS_TEXT.get(code) as [string, string])[0];
  return {
    status: code,
    phrase: message,
    headers: [
      ["Connection", "close"],
      ["Content-Type", "text/html;charset=utf-8"],
    ],
    body: errorBody(code, message, explain),
    headless,
  };
}

function serialize(reply: Reply, withBody: boolean): Buffer {
  const body = reply.body;
  if (reply.headless) return body ?? Buffer.alloc(0);
  const lines = [
    `HTTP/1.0 ${reply.status} ${reply.phrase}`,
    // BaseHTTPRequestHandler joins server_version and sys_version with a
    // space, and this server clears the second — so the header ends in one.
    "Server: atlas ",
    `Date: ${httpDate()}`,
    ...reply.headers.map(([name, value]) => `${name}: ${value}`),
  ];
  if (body !== null) lines.push(`Content-Length: ${body.length}`);
  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
  return body !== null && withBody ? Buffer.concat([head, body]) : head;
}

interface Request {
  readonly method: string;
  readonly target: string;
  /** Every Host header seen, in order; the count is part of the answer. */
  readonly hosts: string[];
  /**
   * That the request line carried no version, and so gets no response head.
   *
   * HTTP/0.9 has no status line and no headers — the body is the whole
   * response. The oracle enforces that in `send_response_only`, which returns
   * without writing anything when the version is 0.9, so it applies to a served
   * file exactly as much as to an error page.
   */
  readonly headless: boolean;
}

/**
 * The characters `str.split()` with no argument treats as whitespace.
 *
 * The request line is decoded as latin-1, so this is that codec's whole
 * whitespace class and not merely a space — a tab between the method and the
 * target separates two words for the oracle and would otherwise make one.
 */
const PYTHON_WHITESPACE = /[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0]+/;

const pythonSplit = (text: string): string[] =>
  text.split(PYTHON_WHITESPACE).filter((word) => word !== "");

/**
 * `str.isdigit()`, over the characters latin-1 can produce.
 *
 * Superscript two, three and one answer yes to Python and are then refused by
 * `int()` — which is how a version of `HTTP/².1` reaches the same refusal as
 * a version of `HTTP/x` by a different road.
 */
const isDigits = (text: string): boolean => text !== "" && /^[0-9\xb2\xb3\xb9]+$/.test(text);

/** How many headers `http.client` reads before it calls the request hostile. */
const MAX_HEADERS = 100;

/** What the request line was, if it was one. `null` means: answer nothing. */
type RequestLine = { readonly method: string; readonly target: string; readonly headless: boolean };

/** `parse_request` as far as the line goes, refusals and silences included. */
function parseRequestLine(raw: string): RequestLine | Reply | null {
  // The oracle strips only the newline characters from the line's end.
  const line = raw.replace(/[\r\n]+$/, "");
  const words = pythonSplit(line);
  // An empty request line is not a bad request: it is not a request, and the
  // oracle closes the connection without a word.
  if (words.length === 0) return null;

  let headless = true;
  if (words.length >= 3) {
    const version = words[words.length - 1] as string;
    const parts = version.startsWith("HTTP/") ? version.slice(5).split(".") : null;
    const good =
      parts !== null &&
      parts.length === 2 &&
      parts.every((part) => isDigits(part) && part.length <= 10) &&
      parts.every((part) => /^[0-9]+$/.test(part));
    if (!good) {
      return errorReply(400, `Bad request version (${pythonRepr(version)})`, true);
    }
    if (Number(parts[0]) >= 2) {
      return errorReply(505, `Invalid HTTP version (${version.slice(5)})`, true);
    }
    // Past this point the version is known, so a refusal gets a status line.
    headless = false;
  }
  if (words.length < 2 || words.length > 3) {
    return errorReply(400, `Bad request syntax (${pythonRepr(line)})`, headless);
  }
  const method = words[0] as string;
  if (words.length === 2 && method !== "GET") {
    return errorReply(400, `Bad HTTP/0.9 request type (${pythonRepr(method)})`, headless);
  }
  // gh-87389: a target beginning with two slashes reads as an absolute URI
  // without a scheme to an HTTP client, so the run is reduced to one slash
  // before anything is matched against it.
  let target = words[1] as string;
  if (target.startsWith("//")) target = `/${target.replace(/^\/+/, "")}`;

  return { method, target, headless };
}

/**
 * A line the mail parser will still read as a header.
 *
 * Everything below this point reproduces `email.parser`, because that is what
 * `http.client.parse_headers` hands the request to and its answers are not the
 * obvious ones: a line without a colon does not skip a header, it *ends* the
 * head — every line after it is a body, so a Host underneath one is a Host the
 * server never sees.
 */
const HEADER_LINE = /^(?:From |[\x21-\x39\x3b-\x7e]*:|[\t ])/;

/**
 * The block cut into lines the way the mail parser cuts it.
 *
 * The socket reader that measured this block counted line feeds, because a
 * binary `readline` knows nothing else. The mail parser then buffers the whole
 * block into a `StringIO(newline='')` and reads it back: universal newlines,
 * untranslated. So a bare carriage return ends a header line for the parser
 * and not for the reader, and a `Host` after one on the same physical line is
 * a header the server does see.
 */
function logicalLines(block: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < block.length) {
    const character = block[index] as string;
    if (character !== "\r" && character !== "\n") {
      index += 1;
      continue;
    }
    index += character === "\r" && block[index + 1] === "\n" ? 2 : 1;
    lines.push(block.slice(start, index));
    start = index;
  }
  if (start < block.length) lines.push(block.slice(start));
  return lines;
}

/** Every Host value in a header block, joined and stripped as the parser does. */
function hostsIn(block: string): string[] {
  const lines: string[] = [];
  for (const line of logicalLines(block)) {
    // A line that is only a line ending ends the head, and one that cannot be
    // a header ends it too — everything after either is a body.
    if (line === "\n" || line === "\r\n" || line === "\r") break;
    if (!HEADER_LINE.test(line)) break;
    lines.push(line);
  }

  const hosts: string[] = [];
  let name = "";
  let value: string[] = [];
  // `header_source_parse`: the first line loses its name and the spaces after
  // the colon, the continuations are appended whole, and only then are the
  // newline characters cut off the end.
  const commit = (): void => {
    if (name.toLowerCase() === "host") {
      const first = (value[0] as string).slice(name.length + 1).replace(/^[ \t]+/, "");
      hosts.push((first + value.slice(1).join("")).replace(/[\r\n]+$/, ""));
    }
    name = "";
    value = [];
  };
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (name !== "") value.push(line);
      continue;
    }
    if (name !== "") commit();
    const colon = line.indexOf(":");
    // A colon in the first column names nothing, and is dropped on its own.
    if (colon <= 0) continue;
    name = line.slice(0, colon);
    value = [line];
  }
  if (name !== "") commit();
  return hosts;
}

/**
 * `repr()` of a str, over the characters a latin-1 decode can produce.
 *
 * Not cosmetic: this is what keeps a request's own bytes from reaching the
 * wire as themselves. The status line carries this message raw — the HTML
 * escape below applies to the body only — so a carriage return spelled as
 * itself would end the status line early and hand the client a header of the
 * client's own choosing. Python escapes it to `\r` and the line stays a line
 * (§24.4, §25.8).
 */
function pythonRepr(value: string): string {
  // Python reaches for double quotes only to avoid escaping a single one.
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const short: ReadonlyMap<string, string> = new Map([
    ["\\", "\\\\"],
    ["\n", "\\n"],
    ["\r", "\\r"],
    ["\t", "\\t"],
  ]);
  let text = quote;
  for (const character of value) {
    const escape = short.get(character);
    if (escape !== undefined) text += escape;
    else if (character === quote) text += `\\${character}`;
    // A space is printable; everything else `str.isprintable` refuses is
    // written as its code point, at whichever of the three widths holds it.
    // A request line only ever carries latin-1, because that is what it was
    // decoded with, but an argument carries whatever the caller typed.
    else if (character !== " " && UNPRINTABLE.test(character)) {
      const point = character.codePointAt(0) as number;
      if (point < 0x100) text += `\\x${point.toString(16).padStart(2, "0")}`;
      else if (point < 0x10000) text += `\\u${point.toString(16).padStart(4, "0")}`;
      else text += `\\U${point.toString(16).padStart(8, "0")}`;
    } else text += character;
  }
  return text + quote;
}

interface Serving {
  readonly routes: ReadonlyMap<string, Route>;
  readonly origins: ReadonlySet<string>;
}

/**
 * Refuse a request addressed to any name but our own origin.
 *
 * A browser sends whatever host the page was loaded from, so an attacker's
 * domain re-pointed at 127.0.0.1 (DNS rebinding) would otherwise read the
 * instance from a page atlas never served.
 */
const hostIsOurs = (request: Request, serving: Serving): boolean =>
  request.hosts.length === 1 &&
  serving.origins.has((request.hosts[0] as string).toLowerCase());

function answer(request: Request, serving: Serving): [Reply, number | null] {
  const bare = request.headless;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return [errorReply(501, `Unsupported method (${pythonRepr(request.method)})`, bare), null];
  }
  if (!hostIsOurs(request, serving)) return [errorReply(400, undefined, bare), null];
  // Exact match against the raw request target — no decoding, no
  // normalization, no query tolerance: the two paths the viewer asks for are
  // the two paths that answer, and traversal has nothing to walk through.
  const route = serving.routes.get(request.target);
  if (route === undefined) return [errorReply(404, undefined, bare), null];
  let fd: number | null;
  try {
    fd = openRoute(route);
  } catch (error) {
    if (error instanceof PosixError && error.code === "ENOENT") {
      fd = null;
    } else if (error instanceof ReaderError) {
      // A containment refusal is worth an operator diagnostic; the reader's
      // text carries a path and a reason, never content (§24.4).
      diagnose(error.message);
      fd = null;
    } else if (error instanceof Error) {
      diagnose(error.message);
      fd = null;
    } else {
      throw error;
    }
  }
  if (fd === null) return [errorReply(404, undefined, bare), null];
  let size: number;
  try {
    size = fs.fstatSync(fd).size;
  } catch (error) {
    fs.closeSync(fd);
    diagnose(error instanceof Error ? error.message : String(error));
    return [errorReply(404, undefined, bare), null];
  }
  return [
    {
      status: 200,
      phrase: "OK",
      headers: [
        ["Content-Type", route.contentType],
        ["Content-Length", String(size)],
        ["Cache-Control", "no-store"],
        ["X-Content-Type-Options", "nosniff"],
        ["Referrer-Policy", "no-referrer"],
      ],
      body: null,
      headless: bare,
    },
    fd,
  ];
}

/**
 * Write a file to the socket in bounded chunks, never whole.
 *
 * The graph may be tens of megabytes (§25.8), and a second request must not
 * double a whole file in memory. The builder replaces the graph atomically, so
 * this descriptor keeps serving the bytes fstat measured.
 */
async function sendBody(socket: net.Socket, fd: number, size: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(BODY_CHUNK_BYTES, Math.max(size, 1)));
  let remaining = size;
  while (remaining > 0) {
    if (socket.destroyed || socket.writableEnded) return;
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
    if (read === 0) return;
    const flushed = socket.write(Uint8Array.prototype.slice.call(buffer, 0, read));
    remaining -= read;
    // The oracle writes to a blocking socket, so a client that reads slower
    // than the disk delivers slows the write down. Here the same client would
    // instead fill this process's memory with the rest of the file, so the
    // next chunk waits for the socket's own buffer to drain.
    if (!flushed) await drained(socket);
  }
}

/** Wait for the socket to want more bytes — or to stop wanting anything. */
function drained(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      socket.off("drain", done);
      socket.off("close", done);
      socket.off("error", done);
      resolve();
    };
    socket.once("drain", done);
    socket.once("close", done);
    socket.once("error", done);
  });
}

/** A connection that stops talking mid-request holds a socket open. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How far the header block has been read: still arriving, refused, complete.
 *
 * `_read_headers` counts every line it takes, the blank one that ends the head
 * included, and measures each before keeping it — so both refusals land while
 * the client is still talking, not after it finishes.
 */
type Scan =
  | { readonly state: "waiting" }
  | { readonly state: "refused"; readonly reply: Reply }
  | { readonly state: "read"; readonly end: number };

function scanHeaders(buffer: Buffer, from: number, headless: boolean): Scan {
  const tooLarge = (message: string, explain: string): Scan => ({
    state: "refused",
    reply: errorReply(431, message, headless, explain),
  });
  const overlong = (): Scan =>
    tooLarge("Line too long", `got more than ${HEADER_LINE_BYTES} bytes when reading header line`);

  let start = from;
  let lines = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline < 0) {
      return buffer.length - start > HEADER_LINE_BYTES ? overlong() : { state: "waiting" };
    }
    if (newline + 1 - start > HEADER_LINE_BYTES) return overlong();
    lines += 1;
    if (lines > MAX_HEADERS) {
      return tooLarge("Too many headers", `got more than ${MAX_HEADERS} headers`);
    }
    const line = buffer.subarray(start, newline + 1).toString("latin1");
    if (line === "\n" || line === "\r\n") return { state: "read", end: start };
    start = newline + 1;
  }
}

function serveConnection(socket: net.Socket, serving: Serving): void {
  socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
  // A client that disconnects mid-write is not an error at all.
  socket.on("error", () => socket.destroy());
  const chunks: Buffer[] = [];
  let done = false;
  socket.on("data", (chunk: Buffer) => {
    if (done) return;
    chunks.push(chunk);
    const head = Buffer.concat(chunks);
    const stop = (reply: Reply | null): void => {
      done = true;
      if (reply === null) socket.end();
      else socket.end(serialize(reply, true));
    };

    // The request line is read and answered before a single header is, so a
    // request that is wrong in both places is wrong in the first one.
    const first = head.indexOf(0x0a);
    if (first < 0) {
      // Measured before it is parsed, so an enormous URI is refused rather
      // than walked — and never quoted back (§24.4).
      if (head.length > REQUEST_LINE_BYTES) stop(errorReply(414));
      return;
    }
    if (first + 1 > REQUEST_LINE_BYTES) {
      stop(errorReply(414));
      return;
    }
    const line = parseRequestLine(head.subarray(0, first).toString("latin1"));
    if (line === null) {
      stop(null);
      return;
    }
    if ("status" in line) {
      stop(line);
      return;
    }
    const scan = scanHeaders(head, first + 1, line.headless);
    if (scan.state === "waiting") return;
    if (scan.state === "refused") {
      stop(scan.reply);
      return;
    }
    done = true;

    const parsed: Request = {
      method: line.method,
      target: line.target,
      hosts: hostsIn(head.subarray(first + 1, scan.end).toString("latin1")),
      headless: line.headless,
    };
    const [reply, fd] = answer(parsed, serving);
    const withBody = parsed.method !== "HEAD";
    socket.write(serialize(reply, withBody));
    if (fd === null) {
      socket.end();
      return;
    }
    const size = Number((reply.headers[1] as [string, string])[1]);
    void (async () => {
      try {
        if (withBody) await sendBody(socket, fd, size);
        socket.end();
      } catch (error) {
        // `handle_error`: one line naming the failure, never a traceback with
        // paths and request data in it (§24.4), and the server keeps serving.
        const name = error instanceof Error ? error.constructor.name : "Error";
        diagnose(`request failed: ${name}`);
        socket.destroy();
      } finally {
        fs.closeSync(fd);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Validate both roots and the served graph, or diagnose and give up. */
function openReaders(instance: string): [AtlasReader, AtlasReader] | null {
  let instanceReader: AtlasReader;
  let graph: ScannedFile | null;
  try {
    instanceReader = new AtlasReader(instance);
    graph = instanceReader.optionalFile(GRAPH_RELATIVE_PATH);
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    diagnose(`${shownPath(instance)}: ${error.message}`);
    return null;
  }
  if (graph === null) {
    const shown = shownPath(instance);
    diagnose(
      `${shown}/${GRAPH_RELATIVE_PATH}: not found; build it first with ` +
        `scripts/build_atlas_graph.ts ${shown}/atlas ` +
        `${shown}/${GRAPH_RELATIVE_PATH}`,
    );
    return null;
  }
  let viewerReader: AtlasReader;
  try {
    viewerReader = new AtlasReader(`${ROOT}/viewer`);
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    diagnose(`${ROOT}/viewer: ${error.message}`);
    return null;
  }
  return [viewerReader, instanceReader];
}

export function main(argv: readonly string[], program: string): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(helpText(program));
    return Promise.resolve(0);
  }
  if (parsed.kind === "error") {
    diagnose(parsed.message);
    diagnose(usageLine(program));
    return Promise.resolve(2);
  }
  const { instance, port } = parsed.args;
  const readers = openReaders(instance);
  if (readers === null) return Promise.resolve(1);
  const [viewerReader, instanceReader] = readers;
  let routes: Map<string, Route>;
  try {
    routes = buildRoutes(viewerReader, instanceReader);
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    diagnose(`${viewerReader.root}: ${error.message}`);
    return Promise.resolve(1);
  }
  if (!routes.has(INDEX_ROUTE)) {
    diagnose(
      `${viewerReader.root}/index.html: not found; this engine checkout has ` +
        "no viewer to serve",
    );
    return Promise.resolve(1);
  }

  const serving: Serving = { routes, origins: originsFor(port) };
  const server = net.createServer((socket) => serveConnection(socket, serving));
  return new Promise<number>((resolve) => {
    server.on("error", (error) => {
      diagnose(`cannot serve ${shownPath(instance)}: ${error.message}`);
      resolve(1);
    });
    // Explicit loopback bind (§24): the instance is personal state, and
    // 0.0.0.0 would offer it to the network the moment one exists.
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(
        `serving http://127.0.0.1:${port}${INDEX_ROUTE}#mode=field ` +
          `— read-only view of ${shownPath(instance)} — Ctrl-C stops\n`,
      );
    });
    // Ctrl-C only. The oracle catches `KeyboardInterrupt` and returns 0; it
    // has nothing for SIGTERM, so a terminated server dies of the signal and
    // says so in its exit status. Handling it here would invent a shutdown a
    // caller cannot tell from a clean stop.
    process.on("SIGINT", () => {
      server.close();
      resolve(0);
    });
  });
}
