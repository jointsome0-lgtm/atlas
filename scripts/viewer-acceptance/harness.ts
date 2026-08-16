// The fixture the §27.8 viewer acceptance suite runs on: a copy of the viewer
// served over a loopback socket, one graph file underneath it, and a browser.
//
// The viewer is the one part of Atlas with no differential harness behind it —
// it is browser code, and there is no second implementation to compare it
// against. What stands in for that is this: a real browser, a real socket, and
// assertions read off what was actually painted.

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import fs from "node:fs";

const ROOT = `${import.meta.dir}/../..`;
export const DEMO_GRAPH = `${ROOT}/fixtures/demo-graph/atlas-graph.json`;
export const VIEWER_ACCEPTANCE = `${ROOT}/fixtures/viewer-acceptance`;
export const REJECTED_ACCEPTANCE = `${VIEWER_ACCEPTANCE}/rejected`;
export const UNSUPPORTED_VERSION_FIXTURE = `${VIEWER_ACCEPTANCE}/unsupported-version.json`;

export type Dict = Record<string, unknown>;

export interface Fixture {
  readonly page: Page;
  /** Seconds the server waits before answering for the graph file. */
  graphDelay: number;
  writeGraph(value: unknown): void;
  /** Bytes rather than a document, for the cases that are not JSON at all. */
  writeGraphBytes(bytes: string | Uint8Array): void;
  copyGraph(from: string): void;
  removeGraph(): void;
  openState(fragment: string, state: string, timeout?: number): Promise<void>;
  graphEnvelope(over?: { nodes?: Dict[]; edges?: Dict[]; version?: number }): Dict;
}

interface Held {
  root: string;
  server: ReturnType<typeof Bun.serve>;
  browser: Browser;
  context: BrowserContext | null;
  page: Page | null;
  baseUrl: string;
  graphDelay: number;
}

/**
 * One browser for the whole process, and it is never closed here.
 *
 * `bun test` runs every file in one process, and closing a browser at the end
 * of a file reaches into the next file's: what that looks like is a hook that
 * never returns, or a page that reports itself closed before its first
 * navigation. Nothing closes it, so nothing can close it early — the browser
 * dies when the process does, which is what Playwright's own exit handling is
 * for. What a file does own is its server, its temp root, and its contexts.
 */
let shared: Promise<Browser> | null = null;
const sharedBrowser = (): Promise<Browser> => (shared ??= chromium.launch());

export interface Lab {
  /** Started once for the whole file; a browser launch costs more than a test. */
  start(): Promise<void>;
  stop(): Promise<void>;
  open(): Promise<Fixture>;
  close(): Promise<void>;
  /** The URL a test navigates to directly, for the few that do. */
  baseUrl(): string;
}

/**
 * One lab per test file.
 *
 * The state was module-level once, which is fine until two test files run in
 * one process: the second file's setup takes the browser out from under the
 * first file's tests, and what that looks like is a hook that never returns.
 * A file that owns its own lab cannot be reached by another file's teardown.
 */
export function lab(): Lab {
  const held: Held = {
    root: "",
    server: null as unknown as ReturnType<typeof Bun.serve>,
    browser: null as unknown as Browser,
    context: null,
    page: null,
    baseUrl: "",
    graphDelay: 0,
  };

  async function start(): Promise<void> {
    held.root = fs.mkdtempSync("/tmp/atlas-viewer-test-");
    fs.cpSync(`${ROOT}/viewer`, `${held.root}/viewer`, { recursive: true });
    fs.mkdirSync(`${held.root}/graph`);

    held.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // The delay exists so a test can see the viewer's LOADING state, which
        // is otherwise over before a browser can be asked about it.
        if (path === "/graph/atlas-graph.json" && held.graphDelay > 0) {
          await Bun.sleep(held.graphDelay * 1000);
        }
        // Served from the copy, so a test that rewrites the graph cannot reach
        // the checkout. A path is resolved and then required to stay inside.
        // A malformed escape — `/viewer/%` — makes `decodeURIComponent` throw,
        // and an unrouted request is a 404 here, not a 500.
        let decoded: string;
        try {
          decoded = decodeURIComponent(path);
        } catch {
          return new Response("not found", { status: 404 });
        }
        const target = `${held.root}${decoded}`;
        const real = fs.realpathSync.native(held.root);
        let resolved: string;
        try {
          resolved = fs.realpathSync.native(target);
        } catch {
          return new Response("not found", { status: 404 });
        }
        if (resolved !== real && !resolved.startsWith(`${real}/`)) {
          return new Response("forbidden", { status: 403 });
        }
        const file = Bun.file(resolved);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file);
      },
    });
    held.baseUrl = `http://127.0.0.1:${held.server.port}/viewer/index.html`;
    held.browser = await sharedBrowser();
  }

  async function stop(): Promise<void> {
    held.server.stop(true);
    fs.rmSync(held.root, { recursive: true, force: true });
  }

  /**
   * A fresh context per test: the viewer keeps session state, and a leaked
   * selection would make the next test's first assertion a coin toss.
   */
  async function open(): Promise<Fixture> {
    fs.copyFileSync(DEMO_GRAPH, `${held.root}/graph/atlas-graph.json`);
    held.graphDelay = 0;
    held.context = await held.browser.newContext();
    held.page = await held.context.newPage();
    const page = held.page;

    return {
      page,
      get graphDelay(): number {
        return held.graphDelay;
      },
      set graphDelay(seconds: number) {
        held.graphDelay = seconds;
      },
      writeGraph(value: unknown): void {
        fs.writeFileSync(`${held.root}/graph/atlas-graph.json`, JSON.stringify(value));
      },
      writeGraphBytes(bytes: string | Uint8Array): void {
        fs.writeFileSync(`${held.root}/graph/atlas-graph.json`, bytes);
      },
      copyGraph(from: string): void {
        fs.copyFileSync(from, `${held.root}/graph/atlas-graph.json`);
      },
      removeGraph(): void {
        fs.rmSync(`${held.root}/graph/atlas-graph.json`, { force: true });
      },
      async openState(fragment: string, state: string, timeout = 15_000): Promise<void> {
        // Force a document navigation even when two state variants use the
        // same fragment but replace graph/atlas-graph.json between loads.
        await page.goto("about:blank");
        await page.goto(held.baseUrl + fragment, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`#main[data-state="${state}"]`, { timeout });
      },
      graphEnvelope(over = {}): Dict {
        const nodes = over.nodes ?? [];
        const state: Dict = {};
        for (const node of nodes) {
          if (node["type"] === "concept") {
            state[node["id"] as string] = {
              exposure: "unseen",
              confidence: "unknown",
              clarity: "vague",
              coverage: "none",
              evidence: [],
              decisions: [],
            };
          } else if (node["type"] === "question") {
            state[node["id"] as string] = { status: "open", evidence: [], decisions: [] };
          }
        }
        return {
          format: "atlas-graph",
          version: over.version ?? 1,
          nodes,
          edges: over.edges ?? [],
          trails: [],
          state,
          influence: {},
          frontier: [],
          projections: {},
        };
      },
    };
  }

  async function close(): Promise<void> {
    await held.context?.close();
    held.context = null;
    held.page = null;
  }

  return { start, stop, open, close, baseUrl: () => held.baseUrl };
}
