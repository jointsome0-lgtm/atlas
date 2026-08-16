/**
 * Tests for the demo viewer's command line.
 *
 * A port of `test_view_demo.py`'s usage contract (§25.8): a refusal exits 2,
 * every line it writes carries the `ERROR: ` prefix, and the usage line is
 * written once rather than through the prefix twice.
 *
 * The oracle's third test is not ported and does not need to be. It asserts
 * that `SimpleHTTPRequestHandler.log_message` was overridden to stay silent —
 * a property of a general file server this port does not mount. The demo
 * serves through the instance server's closed route table, which has no
 * logging path at all, and that it writes nothing to stderr while answering
 * requests is compared over a real socket in `scripts/differential/serve.ts`.
 *
 * That the Python and TypeScript command lines answer identically is a
 * separate question, asked over 848 lines in `scripts/differential/demo-cli.ts`.
 *
 * Run: bun test scripts/src
 */

import { expect, test } from "bun:test";

import { DEFAULT_PORT, parseArgs, report } from "./demo-cli.ts";

const PROGRAM = "view_demo.ts";
const ROOT = `${import.meta.dir}/../..`;

interface Result {
  /** Null when the line named a port and the command would go on to serve. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(...argv: string[]): Result {
  let stdout = "";
  let stderr = "";
  const code = report(parseArgs(argv), PROGRAM, {
    out: { write: (text) => void (stdout += text) },
    err: { write: (text) => void (stderr += text) },
  });
  return { code, stdout, stderr };
}

test("a port that is not a number exits 2, every line prefixed", () => {
  const result = run("--port", "nope");
  expect(result.code).toBe(2);
  const lines = result.stderr.split("\n").slice(0, -1);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line.startsWith("ERROR: ")).toBe(true);
  expect(result.stderr).toContain("port must be an integer");
  expect(result.stderr).toContain("ERROR: usage:");
  expect(result.stderr).not.toContain("usage: usage:");
  expect(result.stdout).toBe("");
});

test("a port outside the range exits 2 and says the range", () => {
  const result = run("--port", "70000");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(
    "ERROR: argument --port: port must be between 0 and 65535",
  );
});

test("nothing at all is the default port, and no answer yet", () => {
  const result = run();
  expect(result.code).toBe(null);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect((parseArgs([]) as { readonly port: number }).port).toBe(DEFAULT_PORT);
});

test("help is written to stdout and exits 0", () => {
  const result = run("--help");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.startsWith(`usage: ${PROGRAM} [-h] [--port PORT]`)).toBe(true);
  expect(result.stdout).toContain("Build and serve the Atlas demo viewer.");
});

test(
  "the port the kernel picks is the port the demo pins and prints",
  async () => {
    // The one path with a real socket, and the one whose two halves can drift:
    // the URL printed and the origins a request must address both have to be
    // the *bound* port, which with `--port 0` is not the port that was asked
    // for. Pinning the asked-for port instead answers 400 to every request.
    const server = Bun.spawn(["bun", `${ROOT}/scripts/view_demo.ts`, "--port", "0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let printed = "";
      const reader = server.stdout.getReader();
      while (!printed.includes("\n")) {
        const piece = await reader.read();
        if (piece.done) break;
        printed += new TextDecoder().decode(piece.value);
      }
      const url = /serving (http:\/\/127\.0\.0\.1:\d+\/[^#\s]+)/.exec(printed);
      expect(url, printed).not.toBe(null);

      const index = await fetch((url as RegExpExecArray)[1] as string);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("<html");

      // The route table is closed: the temporary directory it was handed is
      // not browsable, whatever the oracle's file server would have done.
      const listing = await fetch(new URL("/", (url as RegExpExecArray)[1] as string));
      expect(listing.status).toBe(404);
    } finally {
      server.kill("SIGINT");
      await server.exited;
    }
  },
  30_000,
);

test("a refused argument is counted, never quoted back (§24.4)", () => {
  const result = run("--secret-looking-token");
  expect(result.code).toBe(2);
  expect(result.stderr).not.toContain("secret-looking-token");
  expect(result.stderr).toContain("1 unrecognized argument(s); values withheld");
});
