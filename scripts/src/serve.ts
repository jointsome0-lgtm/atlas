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

function portNumber(value: string): number | string {
  // CPython's `int()` takes surrounding whitespace, a sign, and underscores
  // between digits; anything else is the same refusal as a word.
  if (!/^[+-]?\d(?:_?\d)*$/.test(value.trim())) return "port must be an integer";
  const port = Number(value.trim().replaceAll("_", ""));
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

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  let unrecognized = 0;
  let port: number = DEFAULT_PORT;
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index] as string;
    if (argument === "-h" || argument === "--help") return { kind: "help" };
    if (argument === "--port" || argument.startsWith("--port=")) {
      const value =
        argument === "--port"
          ? ((argv[index + 1] ?? null) as string | null)
          : argument.slice("--port=".length);
      if (value === null) {
        return { kind: "error", message: "argument --port: expected one argument" };
      }
      const answer = portNumber(value);
      if (typeof answer === "string") {
        return { kind: "error", message: `argument --port: ${answer}` };
      }
      port = answer;
      index += argument === "--port" ? 2 : 1;
      continue;
    }
    // A leading `-` is an option this parser does not have; a bare word past
    // the first is a positional it does not have. Both are counted, never
    // quoted.
    if (argument.startsWith("-") || positional.length === 1) unrecognized += 1;
    else positional.push(argument);
    index += 1;
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
  if (positional.length === 0) {
    return {
      kind: "error",
      message: "the following arguments are required: INSTANCE_DIR",
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

/** Every Host value in a header block, joined and stripped as the parser does. */
function hostsIn(block: string): string[] {
  const lines: string[] = [];
  for (const raw of block.split("\n")) {
    const line = `${raw}\n`;
    if (line === "\n" || line === "\r\n") break;
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
    // A space is printable and everything else `str.isprintable` refuses is
    // written as its code point — two hex digits for everything latin-1 has.
    else if (character !== " " && UNPRINTABLE.test(character)) {
      const point = character.codePointAt(0) as number;
      text += `\\x${point.toString(16).padStart(2, "0")}`;
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    return [errorReply(501, `Unsupported method (${pythonRepr(request.method)})`), null];
  }
  if (!hostIsOurs(request, serving)) return [errorReply(400), null];
  // Exact match against the raw request target — no decoding, no
  // normalization, no query tolerance: the two paths the viewer asks for are
  // the two paths that answer, and traversal has nothing to walk through.
  const route = serving.routes.get(request.target);
  if (route === undefined) return [errorReply(404), null];
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
  if (fd === null) return [errorReply(404), null];
  let size: number;
  try {
    size = fs.fstatSync(fd).size;
  } catch (error) {
    fs.closeSync(fd);
    diagnose(error instanceof Error ? error.message : String(error));
    return [errorReply(404), null];
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
      headless: false,
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
function sendBody(socket: net.Socket, fd: number, size: number): void {
  const buffer = Buffer.allocUnsafe(Math.min(BODY_CHUNK_BYTES, Math.max(size, 1)));
  let remaining = size;
  while (remaining > 0) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
    if (read === 0) return;
    socket.write(Uint8Array.prototype.slice.call(buffer, 0, read));
    remaining -= read;
  }
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
    };
    const [reply, fd] = answer(parsed, serving);
    const withBody = parsed.method !== "HEAD";
    socket.write(serialize(reply, withBody));
    if (fd !== null) {
      try {
        if (withBody) {
          sendBody(socket, fd, Number((reply.headers[1] as [string, string])[1]));
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    socket.end();
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
    const stop = (): void => {
      server.close();
      resolve(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
