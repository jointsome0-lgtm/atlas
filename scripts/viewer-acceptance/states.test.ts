// §16.4/§16.5: every screen the viewer can be in is reachable by address.
//
// The point is not that each state exists but that a reader who was handed a
// URL lands on it — an unreachable state is a state nobody can be shown, and
// a state reached by accident is an address that means two things.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import {
  DEMO_GRAPH,
  UNSUPPORTED_VERSION_FIXTURE,
  lab,
  type Fixture,
} from "./harness.ts";

// One lab per file: the browser and the server belong to this file alone,
// so another file's teardown cannot reach them.
const { baseUrl, close, open, start, stop } = lab();

let it: Fixture;

beforeAll(async () => {
  await start();
});
afterAll(async () => {
  await stop();
});
beforeEach(async () => {
  it = await open();
});
afterEach(async () => {
  await close();
});

test("all PR2 screen states are URL-reachable", async () => {
  it.graphDelay = 0.6;
  await it.page.goto(`${baseUrl()}#mode=field`, { waitUntil: "domcontentloaded" });
  expect(await it.page.locator("#main").getAttribute("data-state")).toBe("LOADING");
  expect(await it.page.locator("#main").innerText()).toBe("Loading the graph…");
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  it.graphDelay = 0;

  it.removeGraph();
  await it.openState("#mode=field", "MISSING");
  expect(await it.page.locator("#main").innerText()).toContain(
    "Couldn't read graph/atlas-graph.json",
  );

  it.writeGraphBytes("{not json");
  await it.openState("#mode=field", "REJECTED");
  expect(await it.page.locator(".state-block").getAttribute("role")).toBe("alert");
  expect(await it.page.locator("#main").innerText()).toContain(
    "This graph file can't be displayed",
  );

  it.copyGraph(UNSUPPORTED_VERSION_FIXTURE);
  await it.openState("#mode=field", "UNSUPPORTED_VERSION");
  expect(await it.page.locator("#main").innerText()).toContain("format version 2");

  it.writeGraph(it.graphEnvelope());
  await it.openState("#mode=field", "EMPTY");
  expect(await it.page.locator("#main").innerText()).toContain("This graph has no nodes yet");

  // §16.5: address hardening precedes the empty-graph shortcut.
  await it.openState("#mode=%ZZ", "BAD_ADDRESS");

  // §16.4: unknown field/focus still flags visibly on an empty graph.
  await it.openState("#mode=field&field=ocean", "EMPTY");
  expect(await it.page.locator(".banner").getAttribute("data-banner")).toBe("UNKNOWN_FIELD");

  it.copyGraph(DEMO_GRAPH);
  await it.openState("#mode=%ZZ", "BAD_ADDRESS");
  expect(await it.page.locator("#main").innerText()).toContain("This view address isn't valid");

  await it.openState("#mode=orbit", "UNKNOWN_MODE");
  expect(await it.page.locator("#main").innerText()).toContain('Unknown view "orbit".');
  expect(await it.page.locator("#main").innerText()).toContain("This viewer knows: field.");

  await it.openState("#mode=route", "NOT_IN_SLICE");
  expect(await it.page.locator("#main").innerText()).toContain(
    "isn't part of this viewer slice yet",
  );
  expect(await it.page.locator("#main a").getAttribute("href")).toBe("#mode=field");

  await it.openState("#mode=field&field=body", "UNSUPPORTED_GEOMETRY");
  expect(await it.page.locator("#main").innerText()).toContain("silhouette geometry");
  expect(await it.page.locator("#main a").getAttribute("href")).toContain("field=knowledge");

  await it.openState("#mode=field&focus=concept:no-such-node", "FIELD");
  expect(await it.page.locator(".banner").getAttribute("data-banner")).toBe("UNKNOWN_FOCUS");
  expect(await it.page.locator(".banner").innerText()).toContain("Showing the knowledge field");

  await it.openState("#mode=field&field=ocean", "FIELD");
  expect(await it.page.locator(".banner").getAttribute("data-banner")).toBe("UNKNOWN_FIELD");

  await it.openState("#mode=field&focus=direction:demo-unanchored", "FIELD");
  expect(await it.page.locator(".banner").getAttribute("data-banner")).toBe("FIELD_UNDEFINED");
  expect(await it.page.locator(".node.field-undefined.selected").count()).toBe(1);
  expect(await it.page.locator("#details").innerText()).toContain("field undefined");
});
