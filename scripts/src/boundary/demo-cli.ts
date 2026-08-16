// Build the invented demo fixtures somewhere temporary and serve them.
//
// Nothing is written inside the checkout: the graph is built into a temporary
// directory shaped like an instance (`graph/atlas-graph.json`), served, and
// removed when the command stops.
//
// One thing here is deliberately not the oracle's. `view_demo.py` mounts the
// temporary directory with CPython's `SimpleHTTPRequestHandler` — a general
// static file server, with directory listings and guessed content types — and
// copies the viewer into the temporary tree to reach it. The port serves the
// demo through the same closed route table `serve_instance` uses (§24): the
// engine's viewer files and one graph, nothing else, no listing, no guessing.
// The demo's own contract — `--port`, the URL it prints, the exit codes — is
// unchanged, and the alternative was reproducing a second HTTP server whose
// only caller is a demo.
//
// Ported from scripts/view_demo.py.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";

import { type Placed, pythonInt, readWords } from "./argv.ts";
import { AtlasReader, ReaderError } from "./reader.ts";
import {
  INDEX_ROUTE,
  type Serving,
  buildRoutes,
  diagnose,
  originsFor,
  printable,
  pythonRepr,
  serveConnection,
} from "./serve.ts";

const ROOT = `${import.meta.dir}/../../..`;

/** The demo's own port, one below the instance server's published origin. */
export const DEFAULT_PORT = 8137;

/** Every option string, in the order the oracle's parser was given them. */
const OPTION_STRINGS = ["-h", "--help", "--port"] as const;

const usageLine = (program: string): string => `usage: ${program} [-h] [--port PORT]`;

/**
 * The help text, laid out at the width the oracle's parser uses off a tty.
 *
 * The oracle wraps to the terminal width and falls back to 80 columns when
 * there is no terminal, which is every non-interactive caller and every test.
 * That fallback is the layout reproduced here (#135).
 */
const helpText = (program: string): string =>
  `${usageLine(program)}\n` +
  "\n" +
  "Build and serve the Atlas demo viewer.\n" +
  "\n" +
  "options:\n" +
  "  -h, --help   show this help message and exit\n" +
  "  --port PORT\n";

/** The demo's port rule: anything `int()` reads, inside the port range. */
function portNumber(value: string): number | string {
  const port = pythonInt(value);
  if (port === null) return "port must be an integer";
  if (!(port >= 0 && port <= 65535)) return "port must be between 0 and 65535";
  return port;
}

type Parsed =
  | { readonly kind: "args"; readonly port: number }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseArgs(argv: readonly string[]): Parsed {
  const reading = readWords(argv, OPTION_STRINGS);
  if (reading.kind === "error") return reading;
  const { words } = reading;

  let unrecognized = 0;
  let port: number = DEFAULT_PORT;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as Placed;
    // This parser has no positionals at all, so a bare word is as unplaceable
    // as an option nobody wrote — and so is the separator, which in the oracle
    // is only ever absorbed by a positional there is none of here.
    if (word.kind === "positional" || word.kind === "unknown" || word.kind === "separator") {
      unrecognized += 1;
      continue;
    }
    if (word.option === "--help") {
      // Help takes no value, so a value attached to it is refused — except in
      // the one shape that is not a value at all: a one-dash spelling whose
      // tail is more short options. `-hx` is `-h -x`, and help fires before
      // the tail is looked at; `-h=x`, `-h-x` and `-h=` are refusals.
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
      return { kind: "error", message: `argument --port: ${answer}` };
    }
    port = answer;
  }
  if (unrecognized > 0) {
    // §24.4 and the oracle disagree here, and canon wins: argparse names the
    // arguments it could not place, which puts a rejected value — a mistyped
    // option can carry a token — into stderr and every log that captures it.
    // The count is the diagnostic; the usage line says what was expected.
    // `serve_instance.py` already withholds them; this is the one command that
    // did not (#136).
    return {
      kind: "error",
      message: `${unrecognized} unrecognized argument(s); values withheld`,
    };
  }
  return { kind: "args", port };
}

/**
 * Build the demo graph into `destination`, quietly unless it fails.
 *
 * The builder is run as its own process rather than called: it writes its
 * progress straight to the streams, and the oracle shows that only when the
 * build fails.
 */
function buildDemo(destination: string): number {
  const built = Bun.spawnSync(
    [
      process.execPath,
      `${ROOT}/scripts/build_atlas_graph.ts`,
      `${ROOT}/fixtures/demo-instance`,
      `${destination}/graph/atlas-graph.json`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode !== 0) {
    const diagnostics = built.stderr.toString();
    if (diagnostics !== "") process.stderr.write(diagnostics);
    else diagnose("demo graph build failed");
  }
  return built.exitCode;
}

export interface Sinks {
  readonly out: { write(text: string): void };
  readonly err: { write(text: string): void };
}

/**
 * Answer the shapes that never reach a socket: help, and every refusal.
 *
 * Null means the line named a port and the caller should go and serve it.
 * Split out so the differential can compare what a caller sees without also
 * binding one.
 */
export function report(
  parsed: Parsed,
  program: string,
  sinks: Sinks,
): number | null {
  const complain = (message: string): void => {
    // One ERROR: line per line of the message: a value carrying a newline
    // would otherwise split a diagnostic into an unprefixed second line
    // (§25.8) or smuggle control characters into it (§24.4).
    for (const line of printable(message).split("\n")) sinks.err.write(`ERROR: ${line}\n`);
  };
  if (parsed.kind === "help") {
    sinks.out.write(helpText(program));
    return 0;
  }
  if (parsed.kind === "error") {
    complain(parsed.message);
    complain(usageLine(program));
    return 2;
  }
  return null;
}

export function main(argv: readonly string[], program: string): Promise<number> {
  const parsed = parseArgs(argv);
  const answered = report(parsed, program, { out: process.stdout, err: process.stderr });
  if (answered !== null) return Promise.resolve(answered);
  const port = (parsed as { readonly port: number }).port;

  const directory = fs.mkdtempSync(`${os.tmpdir()}/atlas-viewer-`);
  const clean = (): void => fs.rmSync(directory, { recursive: true, force: true });
  if (buildDemo(directory) !== 0) {
    clean();
    return Promise.resolve(1);
  }

  // Filled in once the socket is bound, because half of it cannot be known
  // before then. Nothing reads it earlier: a connection can only arrive after
  // the listen callback has run.
  let serving: Serving;
  let routes: Serving["routes"];
  try {
    const viewer = new AtlasReader(`${ROOT}/viewer`);
    routes = buildRoutes(viewer, new AtlasReader(directory));
    if (!routes.has(INDEX_ROUTE)) {
      diagnose(`${viewer.root}/index.html: not found; this checkout has no viewer`);
      clean();
      return Promise.resolve(1);
    }
  } catch (error) {
    if (!(error instanceof ReaderError)) {
      clean();
      throw error;
    }
    diagnose(`cannot serve demo: ${error.message}`);
    clean();
    return Promise.resolve(1);
  }

  const server = net.createServer((socket) => serveConnection(socket, serving));
  return new Promise<number>((resolve) => {
    server.on("error", (error) => {
      diagnose(`cannot serve demo: ${error.message}`);
      clean();
      resolve(1);
    });
    // Explicit loopback bind (§24), as the oracle binds: a demo is still a
    // server, and 0.0.0.0 would offer it to the network.
    server.listen(port, "127.0.0.1", () => {
      // The bound port, not the asked-for one: port 0 is allowed here and the
      // kernel picks it, so both the origins a request must address and the
      // printed URL are the ones that work.
      const bound = (server.address() as net.AddressInfo).port;
      serving = { routes, origins: originsFor(bound) };
      process.stdout.write(
        `serving http://127.0.0.1:${bound}${INDEX_ROUTE}#mode=field — Ctrl-C stops\n`,
      );
    });
    // Ctrl-C only, as the oracle catches `KeyboardInterrupt` and returns 0.
    process.on("SIGINT", () => {
      server.close();
      clean();
      resolve(0);
    });
  });
}
