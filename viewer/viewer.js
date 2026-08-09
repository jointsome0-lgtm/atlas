import {
  CEILINGS,
  DEFAULT_FIELD,
  EDGE_TYPES,
  FIELDS,
  MODES,
  NODE_TYPES,
  RENDER_NODE_LINK_CEILING,
  acceptGraphBuffer,
  parseFragment
} from "./contract.js";

const SVG_NS = "http:" + "//www.w3.org/2000/svg";
const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 650;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
// Screen pixels a press may wander and still count as a press, not a pan.
const DRAG_SLOP = 4;
// The arrowhead's side in stroke-width units, before applyDashScale divides
// the stroke's low-zoom lift back out of it.
const ARROW_UNITS = 6;
const ROUTE_TYPES = new Set(["step_of_route", "suggested_next"]);
const TRAIL_TYPES = new Set(["moved_to", "via", "produced_artifact"]);
const AUTHORED_TYPES = new Set(["related_to", "prerequisite_of", "extends", "implements", "contradicts", "alternative_to", "explains", "demonstrates", "critiques", "mentions", "loads", "supports"]);
// §10.2/§20.3: the two symmetric types render without an arrowhead.
const SYMMETRIC_TYPES = new Set(["related_to", "alternative_to"]);
const STRUCTURAL_TYPES = new Set(["has_part", "overall_concept", "part_of_direction"]);
const EDGE_FAMILIES = [
  {key: "route", className: "edge-route", label: "routes (hideable)"},
  {key: "trail", className: "edge-trail", label: "trail"},
  {key: "authored", className: "edge-authored", label: "authored (tick length = weight)"},
  {key: "structural", className: "edge-structural", label: "structure"},
  {key: "journal", className: "edge-journal", label: "journal-derived"}
];
const EDGE_FAMILY_CLASSES = Object.fromEntries(EDGE_FAMILIES.map((family) => [family.key, family.className]));
// §16.2 A3: the asserted weights differ by mark extent, never by stroke.
const WEIGHT_TICK_TOKENS = {"low": "--w-tick-low", "medium": "--w-tick-medium", "high": "--w-tick-high"};
// §16.2 A1: interior texture is the monotone contact ladder. Each §14 ladder
// keeps its own words (§14.5) while sharing the texture ranks; the plate
// kinds are the ones whose state the fold emits (§14.1, §14.8).
const STATE_TYPES = new Set(["concept", "material", "material_part", "question"]);
const TEXTURE_KINDS = ["concept", "material", "material_part"];
const EXPOSURE_TEXTURES = {"unseen": "plain", "touched": "dot", "read": "hatch", "summarized": "cross", "applied": "solid", "taught": "keyline"};
const DEPTH_TEXTURES = {"skim": "dot", "read": "hatch", "summarized": "cross", "applied": "solid", "taught": "keyline"};
// §16.2 A2: fixed slot order top to bottom; a struck mark's extent carries
// the decided level, a decided floor is the baseline strike (mark 0), and
// disputed is the fork, never a rung.
const RAIL_MARK_TOKENS = ["--rail-mark-0", "--rail-mark-1", "--rail-mark-2", "--rail-mark-3"];
const CONCEPT_RAIL_DIMENSIONS = [
  {dimension: "confidence", marks: {"unknown": 0, "low": 1, "medium": 2, "high": 3}},
  {dimension: "clarity", marks: {"vague": 0, "rough": 1, "stable": 3}, fork: "disputed"},
  {dimension: "coverage", marks: {"none": 0, "partial": 2, "broad": 3}}
];
// Status is gated but not ordinal: every confirmed value uses the same
// baseline strike, while the panel/list words carry which status was decided.
const QUESTION_RAIL_DIMENSIONS = [
  {dimension: "status", uniformMark: 0}
];
// §16.2 A11: the fixed drop order. A tier engages when the typical on-screen
// node spacing falls under tier × plate radius, so crowding and zooming out
// degrade the same way; the status line names every channel not drawn.
const DENSITY_TIERS = [
  {className: "drop-decision", token: "--tier-decision-x", fallbackX: 4, copy: "decision rails, edge weight"},
  {className: "drop-labels", token: "--tier-label-x", fallbackX: 3, copy: "labels"},
  {className: "drop-state", token: "--tier-state-x", fallbackX: 2, copy: "state texture, freshness boundary"}
];
// Half extents on the 7-unit shape grid (×plate unit at draw time): label
// anchoring and edge trimming, never state (A10).
const KIND_HALF_EXTENT = {
  "plan": 8, "concept": 7, "material": 6.5, "material_part": 4.5,
  "direction": 8, "suggested_route": 7, "personal_trail": 7,
  "trail_segment": 7, "artifact": 6.7, "encounter": 4.5,
  "question": 7, "probe": 6.5, "zone": 7, "pattern": 7
};
// Conservative radial extents for edge trimming. Circles and polygons whose
// farthest point already lies on one axis fall back to KIND_HALF_EXTENT; the
// noncircular kinds below need their circumradius so a diagonal edge cannot
// finish inside the plate.
const KIND_RADIAL_EXTENT = {
  "plan": Math.hypot(8, 5.5),
  "material": Math.SQRT2 * 6.5,
  "material_part": Math.SQRT2 * 4.5,
  "direction": 10,
  "artifact": Math.hypot(6.7, 2.2)
};
const LONG_FIELDS = new Set(["notes", "body", "summary", "reason", "text"]);
const DETAIL_FIELDS = {
  "concept": ["aliases"],
  "pattern": ["aliases"],
  "zone": ["notes"],
  "material_part": ["material"],
  "material": ["kind", "url", "status"],
  "suggested_route": ["status", "source_plan"],
  "direction": ["status", "attractor"],
  "question": ["text", "created_at", "source"],
  "probe": ["status", "source_plan", "body"],
  "artifact": ["kind", "path", "observed_at", "summary", "evidence_strength", "probe"],
  "encounter": ["date", "target", "depth", "mode", "context"],
  "trail_segment": ["date", "direction", "from", "to", "via", "reason", "resulting_questions"],
  "personal_trail": ["direction"],
  "plan": []
};
const NODE_CLASSES = {
  "plan": "node-plan", "concept": "node-concept",
  "material": "node-material", "material_part": "node-material_part",
  "direction": "node-direction", "suggested_route": "node-suggested_route",
  "personal_trail": "node-personal_trail", "trail_segment": "node-trail_segment",
  "artifact": "node-artifact", "encounter": "node-encounter",
  "question": "node-question", "probe": "node-probe",
  "zone": "node-zone", "pattern": "node-pattern"
};

const main = document.querySelector("#main");
const shell = document.querySelector("#app-shell");
const details = document.querySelector("#details");
const detailContent = document.querySelector("#detail-content");
const closeDetails = document.querySelector("#close-details");
const fieldChip = document.querySelector("#field-chip");
const statusBar = document.querySelector("#status-bar");
const routesToggle = document.querySelector("#routes-toggle");
const horizonSelect = document.querySelector("#horizon-select");
const graphView = document.querySelector("#graph-view");
const listView = document.querySelector("#list-view");
const legendToggle = document.querySelector("#legend-toggle");
const legend = document.querySelector("#legend");

let accepted = null;
let loadState = "LOADING";
let unsupportedVersion = null;
let renderGeneration = 0;
let currentTransform = null;
let densityResizeObserver = null;
let viewMode = "graph";
let fieldContinuesPastHorizon = false;

function htmlElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svgElement(tag, className) {
  const element = document.createElementNS(SVG_NS, tag);
  if (className) element.setAttribute("class", className);
  return element;
}

// Geometry the renderer computes in script still comes from the token sheet:
// §16.2's aesthetics name channels and tokens, never numbers, so a value moves
// in viewer.css alone.
let rootStyle = null;
function tokenNumber(name, fallback) {
  if (!rootStyle) rootStyle = getComputedStyle(document.documentElement);
  const value = Number.parseFloat(rootStyle.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

// Every shape is authored on a 7-unit grid; --plate-r sets the drawn scale,
// so the plate size moves in the token sheet alone (#98).
function plateRadius() {
  return tokenNumber("--plate-r", 18);
}

function plateUnit() {
  return plateRadius() / 7;
}

function halfExtent(type) {
  return (KIND_HALF_EXTENT[type] || 7) * plateUnit();
}

function radialExtent(type) {
  return (KIND_RADIAL_EXTENT[type] || KIND_HALF_EXTENT[type] || 7) * plateUnit();
}

// The full drawn footprint of a node's kind marks — pull ring and sensitivity
// dot included — for rail placement, the cartouche frame, and label anchoring.
function glyphExtent(node) {
  const u = plateUnit();
  let extent = halfExtent(node.type);
  if (node.type === "question") extent = Math.max(extent, 12 * u);
  if (node.sensitivity) extent = Math.max(extent, 10.5 * u);
  return extent;
}

// The texture rung for a node's own state key, or null where the ladder does
// not apply: no entry on a material key means no recorded contact (§14.8),
// and a parent never borrows a child's rung (A12).
function plateTexture(node, entry) {
  if (node.type === "concept") return EXPOSURE_TEXTURES[entry.exposure];
  if (node.type === "material" || node.type === "material_part") {
    return entry ? DEPTH_TEXTURES[entry.depth_reached] : "plain";
  }
  return null;
}

function setMainState(name) {
  main.dataset.state = name;
}

function closePanel() {
  details.hidden = true;
  shell.classList.remove("details-open");
  detailContent.replaceChildren();
}

function resetScreen(field = DEFAULT_FIELD) {
  renderGeneration += 1;
  if (densityResizeObserver) {
    densityResizeObserver.disconnect();
    densityResizeObserver = null;
  }
  currentTransform = null;
  statusCounts = null;
  main.replaceChildren();
  statusBar.textContent = "";
  fieldChip.textContent = "Field: " + field;
  closePanel();
}

function stateBlock(name, copy, role) {
  resetScreen();
  setMainState(name);
  const block = htmlElement("div", "state-block");
  if (role) block.setAttribute("role", role);
  block.textContent = copy;
  main.append(block);
  return block;
}

function renderLoadState() {
  if (loadState === "LOADING") {
    stateBlock("LOADING", "Loading the graph…");
  } else if (loadState === "MISSING") {
    stateBlock("MISSING", "Couldn't read graph/atlas-graph.json. Build it, then reload this page.");
  } else if (loadState === "REJECTED") {
    stateBlock("REJECTED", "This graph file can't be displayed. Rebuild it with the Atlas builder and reload.", "alert");
  } else if (loadState === "UNSUPPORTED_VERSION") {
    stateBlock("UNSUPPORTED_VERSION", "This graph is format version " + unsupportedVersion + ". This viewer supports version 1. Rebuild the graph with a matching builder.", "alert");
  }
}

function addSamePageLink(parent, prefix, label, hash) {
  parent.append(document.createTextNode(prefix));
  const link = htmlElement("a", "", label);
  link.setAttribute("href", hash);
  parent.append(link);
}

function renderAddressState(name, value) {
  if (name === "BAD_ADDRESS") {
    stateBlock(name, "This view address isn't valid. Try #mode=field.", "alert");
    return;
  }
  if (name === "UNKNOWN_MODE") {
    const block = stateBlock(name, "");
    block.append(htmlElement("div", "", "Unknown view \"" + value + "\"."));
    block.append(htmlElement("div", "", "This viewer knows: field."));
    return;
  }
  if (name === "NOT_IN_SLICE") {
    const block = stateBlock(name, "");
    addSamePageLink(block, "The " + value + " view isn't part of this viewer slice yet. The field view is: ", "#mode=field", "#mode=field");
  }
}

function renderUnsupportedGeometry() {
  const block = stateBlock("UNSUPPORTED_GEOMETRY", "");
  fieldChip.textContent = "Field: body";
  block.append(htmlElement("div", "", "The body field renders in silhouette geometry, which this viewer slice doesn't include."));
  const line = htmlElement("div");
  addSamePageLink(line, "Knowledge field: ", "#mode=field&field=knowledge", "#mode=field&field=knowledge");
  block.append(line);
}

function renderEmpty() {
  stateBlock("EMPTY", "This graph has no nodes yet. Import a plan or record an encounter, then rebuild.");
}

function bannerFor(kind, value) {
  if (kind === "UNKNOWN_FOCUS") return "No node \"" + value + "\" in this graph. Showing the knowledge field.";
  if (kind === "UNKNOWN_FIELD") return "Unknown field \"" + value + "\". Showing the knowledge field.";
  return "This node doesn't derive a field yet — showing it in the knowledge field.";
}

function appendBanner(kind, value) {
  const banner = htmlElement("div", "banner", bannerFor(kind, value));
  banner.setAttribute("role", "status");
  banner.dataset.banner = kind;
  main.append(banner);
}

function fieldForNode(node) {
  if (node.type === "concept") return "knowledge";
  if (node.type === "zone" || node.type === "pattern") return "body";
  return FIELDS.find((field) => node.fields.includes(field)) || DEFAULT_FIELD;
}

async function dispatch() {
  if (loadState !== "ACCEPTED") {
    renderLoadState();
    return;
  }
  setLensControls(false);
  // Every screen that is not a drawn field has no horizon and nothing outside
  // one; the render below re-arms both once it knows there is a focus.
  setHorizonControl(false);
  fieldContinuesPastHorizon = false;
  // §16.5: address hardening never depends on graph content — a bad
  // address is the generic error and no render, empty graph included.
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const address = parseFragment(raw);
  if (address.kind === "BAD_ADDRESS") {
    renderAddressState("BAD_ADDRESS");
    return;
  }
  if (!MODES.includes(address.mode)) {
    renderAddressState("UNKNOWN_MODE", address.mode);
    return;
  }
  if (address.mode !== "field") {
    renderAddressState("NOT_IN_SLICE", address.mode);
    return;
  }
  const nodeById = new Map(accepted.graph.nodes.map((node) => [node.id, node]));
  let selected = null;
  let field = DEFAULT_FIELD;
  let banner = null;
  if (address.focus !== undefined) {
    const resolved = accepted.retired.get(address.focus) || address.focus;
    selected = nodeById.get(resolved) || null;
    if (!selected) {
      banner = {kind: "UNKNOWN_FOCUS", value: address.focus};
    } else {
      field = fieldForNode(selected);
      if (selected.fields.length === 0) banner = {kind: "FIELD_UNDEFINED"};
    }
  } else if (address.field !== undefined) {
    if (FIELDS.includes(address.field)) {
      field = address.field;
    } else {
      banner = {kind: "UNKNOWN_FIELD", value: address.field};
    }
  }

  if (accepted.graph.nodes.length === 0) {
    // §16.4: an unknown focus/field is still visibly flagged on a fresh
    // empty instance — EMPTY never swallows a bad embed link.
    renderEmpty();
    if (banner) appendBanner(banner.kind, banner.value);
    return;
  }

  if (field === "body") {
    renderUnsupportedGeometry();
    return;
  }

  const nodes = accepted.graph.nodes.filter((node) => node.fields.includes(field) || (field === DEFAULT_FIELD && node.fields.length === 0));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = accepted.graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  setHorizonControl(selected !== null);
  const horizon = selected === null ? null : horizonHops();
  const view = horizon === null
    ? {nodes, edges, cut: [], continues: false}
    : neighbourhood(nodes, edges, selected, horizon);
  fieldContinuesPastHorizon = view.continues;
  // §25.8's fallback line counts nodes *in view*, and a horizon is what is
  // in view.
  const pastCeiling = view.nodes.length > RENDER_NODE_LINK_CEILING;
  setLensControls(pastCeiling);
  if (pastCeiling || viewMode === "list") {
    renderList(field, view.nodes, view.edges, selected, banner, pastCeiling);
    return;
  }
  await renderField(field, view.nodes, view.edges, selected, banner, view.cut);
}

function setLensControls(pastCeiling) {
  const effectiveMode = pastCeiling ? "list" : viewMode;
  graphView.disabled = pastCeiling;
  if (pastCeiling) {
    graphView.title = "Node-link layout caps at 2,400 nodes";
  } else {
    graphView.removeAttribute("title");
  }
  graphView.setAttribute("aria-pressed", String(effectiveMode === "graph"));
  listView.setAttribute("aria-pressed", String(effectiveMode === "list"));
}

// A reader control, not an address: §16.4's fragment carries mode, focus and
// field, and an extra key there would be a contract edit.
function setHorizonControl(focused) {
  horizonSelect.disabled = !focused;
  if (focused) horizonSelect.removeAttribute("title");
  else horizonSelect.title = "Open a node to look around it";
}

function horizonHops() {
  const value = Number.parseInt(horizonSelect.value, 10);
  return Number.isNaN(value) ? null : value;
}

// #99: the field is drawn out to a horizon in hops and no further, with
// nothing — no cluster, count, or heat — drawn in its place (A5, A11). Hops
// run over the edges the reader can see, so hiding a family narrows the
// horizon with it.
function neighbourhood(nodes, edges, selected, horizon) {
  const neighbours = new Map(nodes.map((node) => [node.id, []]));
  if (!neighbours.has(selected.id)) return {nodes, edges, cut: [], continues: false};
  for (const edge of visibleEdges(edges)) {
    neighbours.get(edge.source).push(edge.target);
    neighbours.get(edge.target).push(edge.source);
  }
  const reached = new Set([selected.id]);
  let frontier = [selected.id];
  for (let hop = 0; hop < horizon; hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id)) {
        if (reached.has(other)) continue;
        reached.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  // Cut, not gone: drawn as far as the view reaches and then stopped (#99).
  // Taken from the visible set so a hidden family leaves no stub behind.
  const cut = visibleEdges(edges).filter(
    (edge) => reached.has(edge.source) !== reached.has(edge.target));
  return {
    nodes: nodes.filter((node) => reached.has(node.id)),
    edges: edges.filter((edge) => reached.has(edge.source) && reached.has(edge.target)),
    cut,
    continues: reached.size < nodes.length
  };
}

// An accepted graph may hold up to the §25.8 node ceiling; the list stays
// responsive by previewing each section and expanding on explicit request
// (never silently), in frame-sized chunks.
const LIST_SECTION_PREVIEW = 500;
const LIST_EXPAND_CHUNK = 1000;

function makeListRow(node, selected) {
  const row = htmlElement("button", "node-list-row");
  row.type = "button";
  row.dataset.nodeId = node.id;
  const entry = STATE_TYPES.has(node.type) ? accepted.graph.state[node.id] : undefined;
  appendNodeGlyph(row, node);
  row.append(htmlElement("span", "node-list-title", displayTitle(node)));
  // §16.2 A8/A11: the list carries the field's state channels as columns.
  if (STATE_TYPES.has(node.type)) {
    const wordsByChannel = stateWords(node, entry);
    for (const [label, words] of wordsByChannel) {
      row.append(htmlElement("span", "node-list-state", label + ": " + words));
    }
  }
  row.append(htmlElement("span", "node-list-id", node.id));
  if (node.fields.length === 0) row.append(htmlElement("span", "badge", "field undefined"));
  if (selected && selected.id === node.id) row.classList.add("selected");
  row.addEventListener("click", () => updateFocus(node.id));
  return row;
}

function makeEdgeListRow(edge) {
  const row = htmlElement("div", "edge-list-row");
  row.dataset.source = edge.source;
  row.dataset.target = edge.target;
  row.dataset.edgeType = edge.type;
  row.append(
    htmlElement("span", "edge-list-endpoint", edge.source),
    htmlElement("span", "edge-list-type", edge.type),
    htmlElement("span", "edge-list-endpoint", edge.target),
  );
  // §16.2 A3/A8/A11: only edge kinds that admit weight get this column;
  // unassessed is a word here even though its field reading is an open gap.
  if (Object.prototype.hasOwnProperty.call(edge, "weight")) {
    row.append(htmlElement("span", "edge-list-weight", "weight: " + edge.weight));
  }
  return row;
}

async function expandSection(rows, typeNodes, selected, showAll) {
  const generation = renderGeneration;
  let hadFocus = document.activeElement === showAll;
  showAll.remove();
  // The out-of-order selected row (appended after the preview) is recreated
  // at its sorted position by the tail.
  const misplaced = rows.querySelector(".node-list-row.out-of-order");
  if (misplaced) misplaced.remove();
  let firstAppended = null;
  for (let start = LIST_SECTION_PREVIEW; start < typeNodes.length; start += LIST_EXPAND_CHUNK) {
    for (const node of typeNodes.slice(start, start + LIST_EXPAND_CHUNK)) {
      const row = makeListRow(node, selected);
      if (!firstAppended) firstAppended = row;
      rows.append(row);
    }
    if (hadFocus && firstAppended) {
      // The activated control is gone; Tab continues from the revealed rows.
      firstAppended.focus({preventScroll: true});
      hadFocus = false;
    }
    await nextFrame();
    if (generation !== renderGeneration) return;
  }
}

async function expandEdgeSection(rows, edges, showAll) {
  const generation = renderGeneration;
  let hadFocus = document.activeElement === showAll;
  showAll.remove();
  let firstAppended = null;
  for (let start = LIST_SECTION_PREVIEW; start < edges.length; start += LIST_EXPAND_CHUNK) {
    for (const edge of edges.slice(start, start + LIST_EXPAND_CHUNK)) {
      const row = makeEdgeListRow(edge);
      if (!firstAppended) firstAppended = row;
      rows.append(row);
    }
    if (hadFocus && firstAppended) {
      firstAppended.setAttribute("tabindex", "-1");
      firstAppended.focus({preventScroll: true});
      hadFocus = false;
    }
    await nextFrame();
    if (generation !== renderGeneration) return;
  }
}

function renderList(field, nodes, edges, selected, banner, pastCeiling) {
  resetScreen(field);
  setMainState("LIST");
  const listEdges = visibleEdges(edges);
  setStatus(nodes.length, listEdges.length);
  const list = htmlElement("div", "node-list");
  if (banner) list.classList.add("has-banner");
  if (pastCeiling) {
    const note = htmlElement("div", "list-ceiling-note", nodes.length + " nodes is past the node-link ceiling (2,400) — showing the list.");
    note.setAttribute("role", "status");
    list.append(note);
  }
  let selectedRow = null;
  for (const type of NODE_TYPES) {
    const typeNodes = nodes
      .filter((node) => node.type === type)
      .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
    if (!typeNodes.length) continue;
    const section = htmlElement("section", "node-list-section");
    section.dataset.nodeType = type;
    section.append(htmlElement("h2", "", type.replaceAll("_", " ") + " (" + typeNodes.length + ")"));
    const rows = htmlElement("div", "node-list-rows");
    const preview = typeNodes.slice(0, LIST_SECTION_PREVIEW);
    for (const node of preview) rows.append(makeListRow(node, selected));
    if (selected && typeNodes.length > preview.length
        && typeNodes.slice(preview.length).some((node) => node.id === selected.id)) {
      // The selection is always visible, even past the preview.
      const row = makeListRow(selected, selected);
      row.classList.add("out-of-order");
      rows.append(row);
    }
    section.append(rows);
    if (typeNodes.length > preview.length) {
      const showAll = htmlElement("button", "list-show-all",
        "Show all " + typeNodes.length + " " + type.replaceAll("_", " ") + " rows");
      showAll.type = "button";
      showAll.addEventListener("click", () => { void expandSection(rows, typeNodes, selected, showAll); });
      section.append(showAll);
    }
    list.append(section);
    const marked = rows.querySelector(".node-list-row.selected");
    if (marked) selectedRow = marked;
  }
  if (listEdges.length) {
    const section = htmlElement("section", "edge-list-section");
    section.append(htmlElement("h2", "", "edges (" + listEdges.length + ")"));
    const rows = htmlElement("div", "edge-list-rows");
    for (const edge of listEdges.slice(0, LIST_SECTION_PREVIEW)) {
      rows.append(makeEdgeListRow(edge));
    }
    section.append(rows);
    if (listEdges.length > LIST_SECTION_PREVIEW) {
      const showAll = htmlElement(
        "button", "list-show-all", "Show all " + listEdges.length + " edge rows",
      );
      showAll.type = "button";
      showAll.addEventListener("click", () => {
        void expandEdgeSection(rows, listEdges, showAll);
      });
      section.append(showAll);
    }
    list.append(section);
  }
  main.append(list);
  if (selected) openPanel(selected, visibleEdges(accepted.graph.edges));
  if (banner) appendBanner(banner.kind, banner.value);
  if (selectedRow) {
    selectedRow.scrollIntoView({block: "nearest"});
    if (focusOrphaned()) selectedRow.focus({preventScroll: true});
  }
}

// A redraw may destroy the element that held keyboard focus (an activated
// node or list row lives inside the rebuilt tree). Restore focus to the
// selection only in that case — never steal it from a live control such as
// the Routes toggle.
function focusOrphaned() {
  return document.activeElement === null || document.activeElement === document.body;
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function initialPositions(nodes) {
  const sorted = [...nodes].sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
  const random = mulberry32(fnv1a32(sorted.map((node) => node.id).join("")));
  const radius = Math.max(100, sorted.length * 7);
  const positions = new Map();
  sorted.forEach((node, index) => {
    const angle = (Math.PI * 2 * index / Math.max(sorted.length, 1)) + (random() - 0.5) * 0.22;
    const jitter = radius * (0.82 + random() * 0.36);
    positions.set(node.id, {x: Math.cos(angle) * jitter, y: Math.sin(angle) * jitter});
  });
  return {sorted, positions};
}

// The room a node's own marks occupy, as a radius. Clearance only — position
// and size stay geometry, never state (A10).
function layoutRadius(node) {
  let radius = glyphExtent(node);
  const entry = STATE_TYPES.has(node.type)
    ? accepted.graph.state[node.id] : undefined;
  if (entry !== undefined) {
    const dimensions = railDimensions(node);
    if (dimensions.length) {
      const bounds = railBounds(node, dimensions);
      radius = Math.max(
        radius, bounds.right, -bounds.left, bounds.bottom, -bounds.top);
    }
  }
  return radius;
}

function layoutRadii(sorted) {
  return new Map(sorted.map((node) => [node.id, layoutRadius(node)]));
}

// Typed arrays for the O(n²) pair loop: same arithmetic in the same order, so
// the same graph still settles into the same picture (§27.8).
function layoutBuffer(sorted, positions, radii, edges) {
  const count = sorted.length;
  const index = new Map();
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const radius = new Float64Array(count);
  sorted.forEach((node, at) => {
    const position = positions.get(node.id);
    index.set(node.id, at);
    x[at] = position.x;
    y[at] = position.y;
    radius[at] = radii.get(node.id);
  });
  const springs = [];
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    springs.push(source, target);
  }
  return {
    count,
    x,
    y,
    radius,
    springs: Int32Array.from(springs),
    forceX: new Float64Array(count),
    forceY: new Float64Array(count),
    writeBack() {
      sorted.forEach((node, at) => {
        const position = positions.get(node.id);
        position.x = x[at];
        position.y = y[at];
      });
    }
  };
}

// Cooling: the step ceiling falls with the temperature, so late iterations
// settle instead of wandering. Seeded and clamped (§27.8).
function layoutIteration(buffer, restGap, temperature) {
  const {count, x, y, radius, springs, forceX, forceY} = buffer;
  forceX.fill(0);
  forceY.fill(0);
  for (let left = 0; left < count; left += 1) {
    const leftX = x[left];
    const leftY = y[left];
    const leftRadius = radius[left];
    for (let right = left + 1; right < count; right += 1) {
      let dx = x[right] - leftX;
      let dy = y[right] - leftY;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 0.01) {
        dx = 0.1 + left * 0.001;
        dy = 0.1 + right * 0.001;
        distanceSquared = dx * dx + dy * dy;
      }
      const distance = Math.sqrt(distanceSquared);
      // Repulsion sized for plate-scale nodes (#98): weakly connected nodes
      // must clear a full plate-and-rail footprint, not the old 7-unit dot.
      // Scaling by the pair's own clearance keeps that true for every kind.
      const clearance = leftRadius + radius[right];
      const magnitude = 3 * clearance * clearance / distanceSquared;
      const fx = magnitude * dx / distance;
      const fy = magnitude * dy / distance;
      forceX[left] -= fx;
      forceY[left] -= fy;
      forceX[right] += fx;
      forceY[right] += fy;
    }
  }
  for (let at = 0; at < springs.length; at += 2) {
    const source = springs[at];
    const target = springs[at + 1];
    const dx = x[target] - x[source];
    const dy = y[target] - y[source];
    const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
    // Rest length is both footprints plus one gap, so an edge between two big
    // plates does not drag them into each other's marks.
    const rest = radius[source] + radius[target] + restGap;
    const magnitude = (distance - rest) * 0.018;
    const fx = magnitude * dx / distance;
    const fy = magnitude * dy / distance;
    forceX[source] += fx;
    forceY[source] += fy;
    forceX[target] -= fx;
    forceY[target] -= fy;
  }
  const step = 8 * temperature;
  for (let at = 0; at < count; at += 1) {
    x[at] += Math.max(-step, Math.min(step, forceX[at] * 0.08 - x[at] * 0.004));
    y[at] += Math.max(-step, Math.min(step, forceY[at] * 0.08 - y[at] * 0.004));
  }
}

// Pushes footprints the force loop left overlapping apart along their own
// axis. Visited in id order, so the correction is seeded like the layout.
function separationPass(buffer, gap) {
  const {count, x, y, radius} = buffer;
  let moved = false;
  for (let left = 0; left < count; left += 1) {
    const leftRadius = radius[left];
    for (let right = left + 1; right < count; right += 1) {
      const minimum = leftRadius + radius[right] + gap;
      // Read live: a push earlier in this pass has already moved both ends.
      let dx = x[right] - x[left];
      let dy = y[right] - y[left];
      let distance = Math.hypot(dx, dy);
      if (distance >= minimum) continue;
      if (distance < 0.01) {
        dx = 1;
        dy = (left + right) % 2 === 0 ? 0.5 : -0.5;
        distance = Math.hypot(dx, dy);
      }
      const push = (minimum - distance) / 2;
      const ux = dx / distance;
      const uy = dy / distance;
      x[left] -= ux * push;
      y[left] -= uy * push;
      x[right] += ux * push;
      y[right] += uy * push;
      moved = true;
    }
  }
  return moved;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

// A11's density input is the median nearest-neighbour distance after layout.
// It measures crowding even when long spokes join a dense ring of leaves. The
// O(n²) pass is bounded by §25.8's 2,400-node field ceiling, runs once per
// completed layout, and its result is cached on currentTransform.
function typicalSpacing(nodes, positions) {
  if (nodes.length < 2) {
    return Math.sqrt(VIEW_WIDTH * VIEW_HEIGHT / Math.max(nodes.length, 1));
  }
  const nearest = new Array(nodes.length).fill(Number.POSITIVE_INFINITY);
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = positions.get(nodes[leftIndex].id);
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = positions.get(nodes[rightIndex].id);
      const distance = Math.hypot(right.x - left.x, right.y - left.y);
      nearest[leftIndex] = Math.min(nearest[leftIndex], distance);
      nearest[rightIndex] = Math.min(nearest[rightIndex], distance);
    }
  }
  const finite = nearest.filter(Number.isFinite);
  if (finite.length) return median(finite);
  return Math.sqrt(VIEW_WIDTH * VIEW_HEIGHT / Math.max(nodes.length, 1));
}

// Node count is the only input, so the budget is as seeded as the layout.
function iterationBudget(count) {
  if (count < 2) return 1;
  return Math.min(420, Math.max(120, Math.round(3600 / Math.sqrt(count))));
}

// View-time only: this tab, dying with it, so nothing derived is stored
// (§31.8).
//
// EVERY INPUT calculateLayout READS MUST BE DECLARED IN layoutKey BELOW; one
// that is not is a silently wrong picture. Today: the drawn node set, the
// drawn edge set in order, and the tokens layoutRadius reads through
// plateRadius and railGeometry.
const LAYOUT_MEMO_LIMIT = 4;
const layoutMemo = new Map();
let layoutOrdinals = null;

// Ordinals into the accepted graph, not ids: both drawn arrays are
// order-preserving filters of it, so equal ordinals means equal input. Never a
// hash — a collision would draw the wrong picture with no symptom.
function graphOrdinals() {
  if (!layoutOrdinals) {
    layoutOrdinals = {
      node: new Map(accepted.graph.nodes.map((node, at) => [node.id, at])),
      edge: new Map(accepted.graph.edges.map((edge, at) => [edge, at]))
    };
  }
  return layoutOrdinals;
}

function layoutKey(field, nodes, edges) {
  const ordinals = graphOrdinals();
  const rails = railGeometry();
  return [
    field, plateRadius(), rails.gap, rails.width, rails.slotH, rails.pitch,
    nodes.map((node) => ordinals.node.get(node.id)).join(","),
    edges.map((edge) => ordinals.edge.get(edge)).join(",")
  ].join("|");
}

function rememberLayout(key, nodes, positions) {
  const entry = {
    // By reference, never mutated by the renderer: dragging a plate (#116)
    // must write through this entry or evict it.
    positions,
    radii: layoutRadii(nodes),
    spacing: typicalSpacing(nodes, positions)
  };
  layoutMemo.delete(key);
  layoutMemo.set(key, entry);
  while (layoutMemo.size > LAYOUT_MEMO_LIMIT) {
    layoutMemo.delete(layoutMemo.keys().next().value);
  }
  return entry;
}

function recallLayout(key) {
  const entry = layoutMemo.get(key);
  if (!entry) return null;
  layoutMemo.delete(key);
  layoutMemo.set(key, entry);
  return entry;
}

async function calculateLayout(nodes, edges, generation) {
  const {sorted, positions} = initialPositions(nodes);
  const radii = layoutRadii(sorted);
  const buffer = layoutBuffer(sorted, positions, radii, edges);
  const restGap = 2.8 * plateRadius();
  const iterations = iterationBudget(sorted.length);
  // Yield on elapsed time, not per iteration: a frame-locked yield made a
  // small field wait on frames it did not need.
  let lastYield = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const temperature = Math.max(0.05, 1 - iteration / iterations);
    layoutIteration(buffer, restGap, temperature);
    if (performance.now() - lastYield > 8) {
      await nextFrame();
      if (generation !== renderGeneration) return null;
      lastYield = performance.now();
    }
  }
  if (sorted.length === 0) return positions;
  fitToFrame(buffer);
  // After the fit, which only ever spreads: nothing rescales the clearance
  // this pass wins. Bounded so the O(n²) sweep stays inside §25.8's budget.
  const separationGap = 0.6 * plateRadius();
  const separationPasses = sorted.length > 600 ? 4 : 24;
  for (let pass = 0; pass < separationPasses; pass += 1) {
    if (!separationPass(buffer, separationGap)) break;
    if (performance.now() - lastYield > 8) {
      await nextFrame();
      if (generation !== renderGeneration) return null;
      lastYield = performance.now();
    }
  }
  buffer.writeBack();
  return positions;
}

// Centre the settled layout in the viewBox, growth only: shrinking squeezed
// positions while glyphs kept their size. A larger field is fitted by zoom.
function fitToFrame(buffer) {
  const {count, x, y} = buffer;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < count; at += 1) {
    minX = Math.min(minX, x[at]);
    maxX = Math.max(maxX, x[at]);
    minY = Math.min(minY, y[at]);
    maxY = Math.max(maxY, y[at]);
  }
  const scale = Math.max(1, Math.min((VIEW_WIDTH - 110) / Math.max(maxX - minX, 1), (VIEW_HEIGHT - 100) / Math.max(maxY - minY, 1)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  for (let at = 0; at < count; at += 1) {
    x[at] = VIEW_WIDTH / 2 + (x[at] - centerX) * scale;
    y[at] = VIEW_HEIGHT / 2 + (y[at] - centerY) * scale;
  }
}

// Zoom out only, until the drawn bounds fit the frame. Every input is the
// settled layout, not the window, so the picture stays seeded (§27.8).
function frameFit(sorted, positions, radii) {
  const identity = {zoom: 1, x: 0, y: 0};
  if (sorted.length === 0) return identity;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of sorted) {
    const position = positions.get(node.id);
    const margin = radii.get(node.id) + 2;
    minX = Math.min(minX, position.x - margin);
    maxX = Math.max(maxX, position.x + margin);
    minY = Math.min(minY, position.y - margin);
    maxY = Math.max(maxY, position.y + margin);
  }
  const zoom = Math.min(1, (VIEW_WIDTH - 40) / Math.max(maxX - minX, 1), (VIEW_HEIGHT - 40) / Math.max(maxY - minY, 1));
  if (zoom >= 1) return identity;
  return {
    zoom,
    x: VIEW_WIDTH / 2 - zoom * (minX + maxX) / 2,
    y: VIEW_HEIGHT / 2 - zoom * (minY + maxY) / 2
  };
}

// Where a label may start on each side of a node: past the plate, and past
// the decision rail on the side that carries it.
function labelAnchors(node) {
  const drawn = glyphExtent(node);
  const entry = STATE_TYPES.has(node.type)
    ? accepted.graph.state[node.id] : undefined;
  const dimensions = entry === undefined ? [] : railDimensions(node);
  const bounds = dimensions.length ? railBounds(node, dimensions) : null;
  return {
    right: Math.max(drawn, bounds ? bounds.right : 0),
    left: Math.max(drawn, bounds ? -bounds.left : 0),
  };
}

// Fixed order, so a placement is a property of the graph and not of the
// visiting order.
const LABEL_SLOTS = [
  {side: "right", row: 0}, {side: "left", row: 0},
  {side: "right", row: -1}, {side: "left", row: -1},
  {side: "right", row: 1}, {side: "left", row: 1},
  {side: "right", row: -2}, {side: "left", row: 2},
];
// Above this the sweep is skipped: A11 has dropped the label channel whole
// well before a field this dense. Node count only, so still seeded (§27.8).
const LABEL_SWEEP_CEILING = 400;

function boxesIntersect(left, right) {
  return left.left < right.right && right.left < left.right
    && left.top < right.bottom && right.top < left.bottom;
}

function labelBox(position, anchors, width, side, dy, line) {
  const x = side === "right"
    ? position.x + anchors.right + dy.gap
    : position.x - anchors.left - dy.gap - width;
  const top = position.y + dy.offset - line * 0.8;
  return {left: x, right: x + width, top, bottom: top + line};
}

// First slot that clears every plate and every label already placed. Moves no
// node and encodes nothing — a label's side is legibility, never state (A10).
function placeLabels(nodes, positions, radii) {
  const sorted = [...nodes].sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
  const gap = tokenNumber("--label-gap", 4);
  const em = tokenNumber("--label-em", 5.8);
  const line = tokenNumber("--label-line", 13);
  const placements = new Map();
  const fallback = {side: "right", offset: 4};
  if (sorted.length > LABEL_SWEEP_CEILING) {
    for (const node of sorted) placements.set(node.id, fallback);
    return placements;
  }
  const obstacles = sorted.map((node) => {
    const position = positions.get(node.id);
    const radius = radii.get(node.id);
    return {
      left: position.x - radius, right: position.x + radius,
      top: position.y - radius, bottom: position.y + radius,
    };
  });
  for (const node of sorted) {
    const position = positions.get(node.id);
    const anchors = labelAnchors(node);
    const width = displayTitle(node).length * em;
    let chosen = null;
    for (const slot of LABEL_SLOTS) {
      const offset = 4 + slot.row * line;
      const box = labelBox(
        position, anchors, width, slot.side, {gap, offset}, line);
      if (obstacles.some((obstacle) => boxesIntersect(box, obstacle))) continue;
      chosen = {side: slot.side, offset, box};
      break;
    }
    if (!chosen) {
      const box = labelBox(
        position, anchors, width, fallback.side,
        {gap, offset: fallback.offset}, line);
      chosen = {side: fallback.side, offset: fallback.offset, box};
    }
    obstacles.push(chosen.box);
    placements.set(node.id, {side: chosen.side, offset: chosen.offset});
  }
  return placements;
}

async function renderField(field, nodes, edges, selected, banner, cutEdges = []) {
  const key = layoutKey(field, nodes, edges);
  if (repaintSelection(key, selected, banner, cutEdges)) return;
  resetScreen(field);
  const generation = renderGeneration;
  const renderedEdges = visibleEdges(edges);
  setStatus(nodes.length, renderedEdges.length);
  let layout = recallLayout(key);
  if (!layout) {
    setMainState("LAYOUT");
    main.append(htmlElement("div", "layout-message", "Laying out " + nodes.length + " nodes…"));
    const settled = await calculateLayout(nodes, edges, generation);
    // Half a settling must never reach the memo.
    if (!settled || generation !== renderGeneration) return;
    layout = rememberLayout(key, nodes, settled);
    main.replaceChildren();
  }
  const {positions, radii} = layout;
  setMainState("FIELD");
  const stage = htmlElement("div", "graph-stage");
  const svg = svgElement("svg", "graph-svg");
  svg.setAttribute("viewBox", "0 0 " + VIEW_WIDTH + " " + VIEW_HEIGHT);
  svg.setAttribute("aria-label", "Knowledge field graph");
  svg.setAttribute("tabindex", "0");
  const viewport = svgElement("g", "viewport");
  svg.append(makeDefinitions(), viewport);
  stage.append(svg, makeZoomControls());
  main.append(stage);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lanes = edgeLanes(renderedEdges);
  // Which relations touch which plate, kept as the drawn groups themselves:
  // answering a selection is then a class on what is already on screen.
  const incidence = new Map();
  const touches = (id, group) => {
    if (!incidence.has(id)) incidence.set(id, []);
    incidence.get(id).push(group);
  };
  for (const edge of renderedEdges) {
    const group = makeEdge(edge, positions, nodeById, lanes.get(edge));
    viewport.append(group);
    touches(edge.source, group);
    touches(edge.target, group);
  }
  if (selected && positions.has(selected.id)) {
    // The whole graph, not the drawn set: a stub's family can turn on the
    // node the horizon is holding back (§16.3).
    const everyNode = new Map(accepted.graph.nodes.map((node) => [node.id, node]));
    for (const stub of makeStubs(cutEdges, positions, everyNode, positions.get(selected.id))) {
      viewport.append(stub);
      touches(stub.dataset.source, stub);
    }
  }
  const placements = placeLabels(nodes, positions, radii);
  const nodeGroups = new Map();
  for (const node of nodes) {
    const group = makeNode(node, positions.get(node.id), placements.get(node.id));
    viewport.append(group);
    nodeGroups.set(node.id, group);
  }

  const focusedPosition = selected ? positions.get(selected.id) : null;
  const fit = frameFit(nodes, positions, radii);
  // A focused node is read at its own scale; unfocused, the view opens on
  // the whole field.
  const transform = focusedPosition
    ? {x: VIEW_WIDTH / 2 - focusedPosition.x, y: VIEW_HEIGHT / 2 - focusedPosition.y, zoom: 1}
    : {x: fit.x, y: fit.y, zoom: fit.zoom};
  transform.minZoom = Math.min(ZOOM_MIN, fit.zoom);
  transform.spacing = layout.spacing;
  currentTransform = {
    svg, viewport, key, positions, nodeGroups, incidence, selectedId: null,
    routes: routesToggle.checked, stubs: cutEdges.length > 0, ...transform
  };
  applyTransform(currentTransform);
  installDensityResize(currentTransform);
  installPanZoom(currentTransform);
  installKeyboardPanZoom(stage, currentTransform);
  paintSelection(selected, banner);
}

// §16.2 A9's focus feedback, and the only place it is expressed: a rebuilt
// field and a repainted one cannot disagree about what is selected.
function paintSelection(selected, banner) {
  const transform = currentTransform;
  if (!transform) return;
  const previous = transform.selectedId;
  if (previous !== null) {
    const stale = transform.nodeGroups.get(previous);
    if (stale) {
      stale.classList.remove("selected");
      stale.setAttribute("tabindex", "-1");
    }
    for (const group of transform.incidence.get(previous) || []) {
      group.classList.remove("incident");
    }
  }
  const group = selected ? transform.nodeGroups.get(selected.id) || null : null;
  transform.selectedId = group ? selected.id : null;
  if (group) {
    group.classList.add("selected");
    group.setAttribute("tabindex", "0");
    for (const edgeGroup of transform.incidence.get(selected.id) || []) {
      edgeGroup.classList.add("incident");
    }
  }
  // A focus the field could not draw leaves the picture whole.
  transform.viewport.classList.toggle("has-selection", group !== null);
  for (const stale of main.querySelectorAll(".banner")) stale.remove();
  if (selected) openPanel(selected, visibleEdges(accepted.graph.edges));
  else closePanel();
  if (banner) appendBanner(banner.kind, banner.value);
  renderStatus();
  if (group && focusOrphaned()) group.focus({preventScroll: true});
}

// Same drawn set, same lens, same token sheet: repaint rather than rebuild.
// currentTransform is non-null only after a completed render and while none
// is in flight (resetScreen is its sole writer of null), so it guards itself.
function repaintSelection(key, selected, banner, cutEdges) {
  const transform = currentTransform;
  if (!transform) return false;
  if (main.dataset.state !== "FIELD") return false;
  if (!transform.svg.isConnected) return false;
  if (transform.key !== key) return false;
  // The Routes lens keeps the layout and changes the drawn edges, so an equal
  // key is not an equal picture across it.
  if (transform.routes !== routesToggle.checked) return false;
  // A stub fan aims away from the focus (#99), so two focuses over one reached
  // set are two different pictures.
  if (transform.stubs || cutEdges.length > 0) return false;
  paintSelection(selected, banner);
  bringSelectionIntoFrame(transform, selected);
  return true;
}

// The camera is the reader's, up to the point where it stops being readable:
// a selection inside an engaged density tier (A11) returns to the node's own
// scale, and otherwise the picture only moves if the selection is off frame.
function bringSelectionIntoFrame(transform, selected) {
  if (!selected) return;
  const position = transform.positions.get(selected.id);
  if (!position) return;
  const margin = 3 * plateRadius();
  const screenX = position.x * transform.zoom + transform.x;
  const screenY = position.y * transform.zoom + transform.y;
  const unreadable = (transform.dropped || []).length > 0;
  const offFrame = screenX < margin || screenX > VIEW_WIDTH - margin
    || screenY < margin || screenY > VIEW_HEIGHT - margin;
  if (!unreadable && !offFrame) return;
  if (unreadable) transform.zoom = 1;
  transform.x = VIEW_WIDTH / 2 - position.x * transform.zoom;
  transform.y = VIEW_HEIGHT / 2 - position.y * transform.zoom;
  applyTransform(transform);
}

// §16.2: the Routes lens is coherent across surfaces — hidden routes leave
// the detail panel too, not only the SVG overlay.
function visibleEdges(edges) {
  if (routesToggle.checked) return edges;
  const nodeById = new Map(accepted.graph.nodes.map((node) => [node.id, node]));
  return edges.filter((edge) => !isRouteEdge(edge, nodeById));
}

let statusCounts = null;

function renderStatus() {
  if (!statusCounts) return;
  let copy = statusCounts.nodes + " nodes · " + statusCounts.edges + " edges in view";
  if (accepted.graph.generated_at) copy += " · as of " + accepted.graph.generated_at.slice(0, 10);
  // #99: words, never a count — a running total of what lies ahead is a
  // progress reading (§3, §4).
  if (fieldContinuesPastHorizon) copy += " · the field continues past the focus horizon — widen it to see further";
  const dropped = currentTransform && currentTransform.dropped ? currentTransform.dropped : [];
  if (dropped.length) copy += " · not drawn at this density: " + dropped.join(", ") + " — open a node to read them";
  statusBar.textContent = copy;
}

function setStatus(nodeCount, edgeCount) {
  statusCounts = {nodes: nodeCount, edges: edgeCount};
  renderStatus();
}

function makeDefinitions() {
  const defs = svgElement("defs");
  const marker = svgElement("marker");
  marker.setAttribute("id", "arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  // The tip is the endpoint reference: the complete stroke-scaled triangle
  // extends back toward the source, outside the target's glyph clearance.
  marker.setAttribute("refX", "10");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", String(ARROW_UNITS));
  marker.setAttribute("markerHeight", String(ARROW_UNITS));
  marker.setAttribute("orient", "auto-start-reverse");
  const path = svgElement("path");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  path.setAttribute("fill", "context-stroke");
  marker.append(path);
  defs.append(marker);
  // §16.2 A1 textures. A <pattern>'s content cannot inherit the referencing
  // element's colour, so each (texture, kind) pair is its own definition and
  // the tile's ink takes the kind hue from its own class.
  const u = plateUnit();
  const pitch = tokenNumber("--tx-hatch-pitch", 1.5556) * u;
  const strokeWidth = tokenNumber("--tx-hatch-weight", 0.5833) * u;
  for (const kind of TEXTURE_KINDS) {
    for (const texture of ["hatch", "cross"]) {
      const pattern = svgElement("pattern");
      pattern.setAttribute("id", "tx-" + texture + "-" + kind);
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.setAttribute("width", pitch);
      pattern.setAttribute("height", pitch);
      pattern.setAttribute("patternTransform", "rotate(45)");
      const ground = svgElement("rect", "tx-ground");
      ground.setAttribute("width", pitch);
      ground.setAttribute("height", pitch);
      pattern.append(ground);
      const stroke = svgElement("line", "tx-ink-" + kind);
      stroke.setAttribute("x1", "0"); stroke.setAttribute("y1", "0");
      stroke.setAttribute("x2", "0"); stroke.setAttribute("y2", pitch);
      stroke.setAttribute("stroke-width", strokeWidth.toFixed(2));
      pattern.append(stroke);
      if (texture === "cross") {
        const across = svgElement("line", "tx-ink-" + kind);
        across.setAttribute("x1", "0"); across.setAttribute("y1", "0");
        across.setAttribute("x2", pitch); across.setAttribute("y2", "0");
        across.setAttribute("stroke-width", strokeWidth.toFixed(2));
        pattern.append(across);
      }
      defs.append(pattern);
    }
  }
  return defs;
}

function isRouteEdge(edge, nodeById) {
  if (ROUTE_TYPES.has(edge.type)) return true;
  if (edge.type !== "primary_for" && edge.type !== "supporting_for") return false;
  const target = nodeById.get(edge.target);
  return target && target.type === "suggested_route";
}

function edgeFamily(edge, nodeById) {
  if (isRouteEdge(edge, nodeById)) return "route";
  if (TRAIL_TYPES.has(edge.type)) return "trail";
  if (AUTHORED_TYPES.has(edge.type)) return "authored";
  if (STRUCTURAL_TYPES.has(edge.type)) return "structural";
  return "journal";
}

function edgeClass(edge, nodeById) {
  return EDGE_FAMILY_CLASSES[edgeFamily(edge, nodeById)];
}

function setEnds(item, from, to) {
  item.setAttribute("x1", from.x.toFixed(3));
  item.setAttribute("y1", from.y.toFixed(3));
  item.setAttribute("x2", to.x.toFixed(3));
  item.setAttribute("y2", to.y.toFixed(3));
}

// §16.2 A3: an edge's own geometry, so the stroke stays free to carry family.
function edgeAxis(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return {
    length,
    mid: {x: (source.x + target.x) / 2, y: (source.y + target.y) / 2},
    unit: {x: dx / length, y: dy / length}
  };
}

function offsetFrom(point, vector, distance) {
  return {x: point.x + vector.x * distance, y: point.y + vector.y * distance};
}

function rayCircleExit(direction, centerX, centerY, radius) {
  const projection = centerX * direction.x + centerY * direction.y;
  if (projection < 0) return null;
  const perpendicularSquared = centerX * centerX + centerY * centerY
    - projection * projection;
  if (perpendicularSquared > radius * radius) return null;
  return projection + Math.sqrt(Math.max(radius * radius - perpendicularSquared, 0));
}

function rayRectExit(direction, left, top, right, bottom) {
  let entry = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;
  for (const [component, minimum, maximum] of [
    [direction.x, left, right],
    [direction.y, top, bottom],
  ]) {
    if (Math.abs(component) < 1e-9) {
      if (minimum > 0 || maximum < 0) return null;
      continue;
    }
    const first = minimum / component;
    const second = maximum / component;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (exit < Math.max(entry, 0)) return null;
  return exit >= 0 ? exit : null;
}

// Direction-sensitive distance from a node centre to the outermost kind/state
// mark on that ray. The primary shape keeps its conservative circumradius;
// asymmetric payload dots and decision rails extend only the approaches that
// actually cross them.
function completeGlyphExtent(node, direction) {
  const u = plateUnit();
  let extent = radialExtent(node.type);
  if (node.type === "question") extent = Math.max(extent, glyphExtent(node));
  if (node.sensitivity) {
    const dotExit = rayCircleExit(direction, 8 * u, -8 * u, 2.5 * u);
    if (dotExit !== null) extent = Math.max(extent, dotExit);
  }
  const entry = STATE_TYPES.has(node.type)
    ? accepted.graph.state[node.id] : undefined;
  const dimensions = entry === undefined ? [] : railDimensions(node);
  if (dimensions.length) {
    const bounds = railBounds(node, dimensions);
    const railExit = rayRectExit(
      direction, bounds.left, bounds.top, bounds.right, bounds.bottom,
    );
    if (railExit !== null) extent = Math.max(extent, railExit);
  }
  return extent;
}

// Several edges between one pair stack exactly on the shared axis. Each takes
// its own lane — a slot for telling strokes apart, never a weight or a rank
// (A3) — ordered by (type, source, target), so the picture is seeded (§27.8).
function edgeLanes(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = edge.source < edge.target
      ? edge.source + "\0" + edge.target
      : edge.target + "\0" + edge.source;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const lanes = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) {
      lanes.set(group[0], 0);
      continue;
    }
    const ordered = [...group].sort((left, right) => {
      const leftKey = left.type + "\0" + left.source + "\0" + left.target;
      const rightKey = right.type + "\0" + right.source + "\0" + right.target;
      return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
    });
    ordered.forEach((edge, index) => {
      lanes.set(edge, index - (ordered.length - 1) / 2);
    });
  }
  return lanes;
}

function makeEdge(edge, positions, nodeById, lane) {
  let source = positions.get(edge.source);
  let target = positions.get(edge.target);
  // At plate scale an untrimmed stroke buries its arrowhead under the target
  // glyph; ends stop at every mark on their approach ray so direction stays
  // readable without leaving rail-sized gaps on the opposite side.
  const rawAxis = edgeAxis(source, target);
  if (rawAxis && lane) {
    // A parallel translation, so the trims below stay valid. The normal is
    // taken along the pair's own axis, low id to high: derived from the edge's
    // direction, a reciprocal a→b / b→a pair would cancel back onto one offset.
    const spacing = tokenNumber("--edge-lane", 7);
    const sense = edge.source < edge.target ? 1 : -1;
    const normal = {x: -rawAxis.unit.y * sense, y: rawAxis.unit.x * sense};
    source = offsetFrom(source, normal, lane * spacing);
    target = offsetFrom(target, normal, lane * spacing);
  }
  if (rawAxis) {
    const sourceTrim = completeGlyphExtent(
      nodeById.get(edge.source), rawAxis.unit,
    ) + 2;
    const targetTrim = completeGlyphExtent(
      nodeById.get(edge.target),
      {x: -rawAxis.unit.x, y: -rawAxis.unit.y},
    ) + 2;
    if (rawAxis.length > sourceTrim + targetTrim + 8) {
      source = offsetFrom(source, rawAxis.unit, sourceTrim);
      target = offsetFrom(target, rawAxis.unit, -targetTrim);
    }
  }
  const group = svgElement("g", "edge-group");
  // Endpoints and family ride the group so a selection restyles what is drawn
  // (A9) instead of drawing it again. Family is data, not a class: a family
  // class here would dash the invisible hit stroke, which would then only
  // answer the hand between the dashes.
  group.dataset.source = edge.source;
  group.dataset.target = edge.target;
  group.dataset.family = edgeFamily(edge, nodeById);
  const lineClass = "edge-line " + edgeClass(edge, nodeById);
  const hit = svgElement("line", "edge-hit");
  setEnds(hit, source, target);
  const directed = !SYMMETRIC_TYPES.has(edge.type);
  const axis = edgeAxis(source, target);
  // §14.9 weight leaves the stroke entirely (§16.2 A3): an asserted weight is
  // a midpoint tick whose extent carries the level, unassessed opens the
  // stroke where the claim would have been — silence reads as a hole, never
  // as a middling line — and a type that admits no weight keeps an unbroken
  // stroke, so "no claim to make" stays distinct from "none recorded".
  const strokes = [];
  if (edge.weight === "unassessed" && axis) {
    const gap = Math.min(tokenNumber("--w-gap", 8), axis.length * 0.4);
    const before = svgElement("line", lineClass + " weight-detail");
    setEnds(before, source, offsetFrom(axis.mid, axis.unit, -gap / 2));
    const after = svgElement("line", lineClass + " weight-detail");
    setEnds(after, offsetFrom(axis.mid, axis.unit, gap / 2), target);
    // §16.2 A11: the weight channel drops whole, so the gap closes with the
    // ticks rather than surviving as the only weight mark left on screen.
    const dropped = svgElement("line", lineClass + " weight-dropped");
    setEnds(dropped, source, target);
    if (directed) {
      after.setAttribute("marker-end", "url(#arrow)");
      dropped.setAttribute("marker-end", "url(#arrow)");
    }
    strokes.push(before, after, dropped);
  } else {
    const line = svgElement("line", lineClass);
    setEnds(line, source, target);
    if (directed) line.setAttribute("marker-end", "url(#arrow)");
    strokes.push(line);
    if (axis && WEIGHT_TICK_TOKENS[edge.weight]) {
      const extent = tokenNumber(WEIGHT_TICK_TOKENS[edge.weight], 8);
      const normal = {x: -axis.unit.y, y: axis.unit.x};
      const tick = svgElement("line", "edge-weight");
      setEnds(tick, offsetFrom(axis.mid, normal, -extent / 2), offsetFrom(axis.mid, normal, extent / 2));
      strokes.push(tick);
    }
  }
  const label = svgElement("text", "edge-label");
  label.setAttribute("x", ((source.x + target.x) / 2).toFixed(3));
  label.setAttribute("y", ((source.y + target.y) / 2 - 6).toFixed(3));
  label.textContent = edge.type;
  group.addEventListener("mouseenter", () => label.classList.add("visible"));
  group.addEventListener("mouseleave", () => label.classList.remove("visible"));
  group.append(...strokes, hit, label);
  return group;
}

// #99: a bound on the view must not read as a bound in the graph, so an edge
// cut by the horizon is drawn from its own plate outward and stops. It claims
// nothing about the far node — family and nothing else, no arrowhead and no
// weight tick, with the relation still named in the panel (A3, A5, A8). Order
// is fixed by id, so the fan is the same picture on every render (§27.8).
function makeStubs(cutEdges, positions, nodeById, focusPosition) {
  const byInside = new Map();
  for (const edge of cutEdges) {
    const insideId = positions.has(edge.source) ? edge.source : edge.target;
    const outsideId = insideId === edge.source ? edge.target : edge.source;
    if (!positions.has(insideId)) continue;
    if (!byInside.has(insideId)) byInside.set(insideId, []);
    byInside.get(insideId).push({edge, outsideId});
  }
  const length = tokenNumber("--edge-stub", 14);
  const fan = tokenNumber("--edge-stub-fan", 1);
  const groups = [];
  for (const insideId of [...byInside.keys()].sort()) {
    const cuts = byInside.get(insideId).sort((left, right) => {
      if (left.edge.type !== right.edge.type) return left.edge.type < right.edge.type ? -1 : 1;
      return left.outsideId < right.outsideId ? -1 : (left.outsideId > right.outsideId ? 1 : 0);
    });
    const position = positions.get(insideId);
    // Outward is away from where the reader is standing: the horizon is a
    // disc around the focus, so its rim is the direction the field continues.
    let outward = {x: position.x - focusPosition.x, y: position.y - focusPosition.y};
    const reach = Math.hypot(outward.x, outward.y);
    outward = reach < 0.01 ? {x: 0, y: -1} : {x: outward.x / reach, y: outward.y / reach};
    cuts.forEach(({edge}, at) => {
      const turn = cuts.length > 1 ? -fan / 2 + fan * at / (cuts.length - 1) : 0;
      const unit = {
        x: outward.x * Math.cos(turn) - outward.y * Math.sin(turn),
        y: outward.x * Math.sin(turn) + outward.y * Math.cos(turn)
      };
      const trim = completeGlyphExtent(nodeById.get(insideId), unit) + 2;
      const group = svgElement("g", "edge-group edge-stub-group");
      // Only the on-screen end is named: the far id is what the horizon is
      // holding back (§16.3).
      group.dataset.source = insideId;
      group.dataset.family = edgeFamily(edge, nodeById);
      const line = svgElement("line", "edge-line edge-stub " + edgeClass(edge, nodeById));
      const from = offsetFrom(position, unit, trim);
      const to = offsetFrom(position, unit, trim + length);
      setEnds(line, from, to);
      const hit = svgElement("line", "edge-hit");
      setEnds(hit, from, to);
      const label = svgElement("text", "edge-label");
      label.setAttribute("x", ((from.x + to.x) / 2).toFixed(3));
      label.setAttribute("y", ((from.y + to.y) / 2 - 6).toFixed(3));
      label.textContent = edge.type + " — past the horizon";
      group.addEventListener("mouseenter", () => label.classList.add("visible"));
      group.addEventListener("mouseleave", () => label.classList.remove("visible"));
      group.append(line, hit, label);
      groups.push(group);
    });
  }
  return groups;
}

function polygon(points, u) {
  const shape = svgElement("polygon", "node-shape");
  shape.setAttribute("points", points
    .map(([x, y]) => (x * u).toFixed(2) + "," + (y * u).toFixed(2)).join(" "));
  return shape;
}

function scaledRect(className, x, y, width, height, radius, u) {
  const shape = svgElement("rect", className);
  shape.setAttribute("x", (x * u).toFixed(2));
  shape.setAttribute("y", (y * u).toFixed(2));
  shape.setAttribute("width", (width * u).toFixed(2));
  shape.setAttribute("height", (height * u).toFixed(2));
  if (radius) shape.setAttribute("rx", (radius * u).toFixed(2));
  return shape;
}

function primaryShape(node) {
  const u = plateUnit();
  if (["concept", "pattern", "question", "personal_trail"].includes(node.type)) {
    const shape = svgElement("circle", "node-shape");
    shape.setAttribute("r", (7 * u).toFixed(2));
    return shape;
  }
  if (node.type === "material") return scaledRect("node-shape", -6.5, -6.5, 13, 13, 3, u);
  if (node.type === "material_part") return scaledRect("node-shape", -4.5, -4.5, 9, 9, 0, u);
  if (node.type === "suggested_route") return polygon([[0, -7], [7, 0], [0, 7], [-7, 0]], u);
  if (node.type === "direction") return polygon([[0, -8], [8, 6], [-8, 6]], u);
  if (node.type === "probe") return polygon([[-6.5, 0], [-3.25, -5.6], [3.25, -5.6], [6.5, 0], [3.25, 5.6], [-3.25, 5.6]], u);
  if (node.type === "artifact") return polygon([[0, -7], [6.7, -2.2], [4.1, 5.7], [-4.1, 5.7], [-6.7, -2.2]], u);
  if (node.type === "trail_segment") return polygon([[0, -7], [4, -3.5], [4, 3.5], [0, 7], [-4, 3.5], [-4, -3.5]], u);
  if (node.type === "plan") return scaledRect("node-shape", -8, -5.5, 16, 11, 0, u);
  const shape = svgElement("circle", "node-shape");
  shape.setAttribute("r", node.type === "encounter" ? (4.5 * u).toFixed(2) : (7 * u).toFixed(2));
  return shape;
}

// The taught rung's inner keyline, per plate shape (§16.2 A1).
function keylineShape(node) {
  const u = plateUnit();
  const inset = tokenNumber("--tx-keyline-inset", 1.5556) * u;
  if (node.type === "concept") {
    const shape = svgElement("circle", "plate-keyline");
    shape.setAttribute("r", (7 * u - inset).toFixed(2));
    return shape;
  }
  const half = node.type === "material" ? 6.5 * u : 4.5 * u;
  const shape = svgElement("rect", "plate-keyline");
  shape.setAttribute("x", (-half + inset).toFixed(2));
  shape.setAttribute("y", (-half + inset).toFixed(2));
  shape.setAttribute("width", (2 * (half - inset)).toFixed(2));
  shape.setAttribute("height", (2 * (half - inset)).toFixed(2));
  if (node.type === "material") shape.setAttribute("rx", Math.max(3 * u - inset, 0).toFixed(2));
  return shape;
}

// The kind-distinguishing marks beyond the base shape — question ring,
// personal-trail inner circle, sensitivity dot — shared by field nodes, list
// glyphs, and the legend so no kind collapses to color alone.
function appendKindMarks(target, node) {
  const u = plateUnit();
  if (node.type === "question") {
    const pull = svgElement("circle", "question-ring");
    pull.setAttribute("r", (11 * u).toFixed(2));
    target.append(pull);
  }
  target.append(primaryShape(node));
  if (node.type === "personal_trail") {
    const inner = svgElement("circle", "node-shape");
    inner.setAttribute("r", (4 * u).toFixed(2));
    target.append(inner);
  }
  if (node.sensitivity) {
    const dot = svgElement("circle", "sensitivity-dot");
    dot.setAttribute("cx", (8 * u).toFixed(2));
    dot.setAttribute("cy", (-8 * u).toFixed(2));
    dot.setAttribute("r", (2.5 * u).toFixed(2));
    target.append(dot);
  }
}

function appendNodeGlyph(parent, node) {
  const glyph = svgElement("svg", "node-glyph " + NODE_CLASSES[node.type]);
  glyph.setAttribute("viewBox", "0 0 16 16");
  glyph.setAttribute("aria-hidden", "true");
  glyph.setAttribute("focusable", "false");
  const contents = svgElement("g");
  // Shapes are drawn at plate scale; the glyph shows them at the 16px box
  // the list and legend always used (0.8 of the old 7-unit grid).
  contents.setAttribute("transform", "translate(8 8) scale(" + (0.8 / plateUnit()).toFixed(4) + ")");
  appendKindMarks(contents, node);
  glyph.append(contents);
  parent.append(glyph);
}

function displayTitle(node) {
  return node.title || node.id.slice(node.id.indexOf(":") + 1);
}

// §16.2 A8: one vocabulary for every state wherever it appears — the marks'
// legend, the detail panel's words, and the list columns all speak these.
const NO_DECISION = "no decision";
const NO_CONTACT = "no contact";

function stateWords(node, entry) {
  const decided = new Set(entry ? entry.decided : []);
  const gated = (dimension) => decided.has(dimension) ? entry[dimension] : NO_DECISION;
  const contact = () => entry && entry.freshness
    ? entry.freshness + " — last seen " + entry.last_seen
    : NO_CONTACT;
  let words = [];
  if (node.type === "concept") {
    words = [
      ["exposure", entry.exposure],
      ["confidence", gated("confidence")],
      ["clarity", gated("clarity")],
      ["coverage", gated("coverage")],
      ["freshness", contact()]
    ];
  } else if (node.type === "material" || node.type === "material_part") {
    words = [
      ["depth reached", entry ? entry.depth_reached : NO_CONTACT],
      ["freshness", contact()]
    ];
  } else if (node.type === "question") {
    // Question status is gated too (§14.6): undecided reads as the unstruck
    // form, never as a value indistinguishable from a confirmed one.
    words = [["status", gated("status")]];
  }
  return words;
}

function plainRect(className, x, y, width, height, radius) {
  const shape = svgElement("rect", className);
  shape.setAttribute("x", x.toFixed(2));
  shape.setAttribute("y", y.toFixed(2));
  shape.setAttribute("width", width.toFixed(2));
  shape.setAttribute("height", height.toFixed(2));
  if (radius) shape.setAttribute("rx", radius.toFixed(2));
  return shape;
}

function railGeometry() {
  const u = plateUnit();
  return {
    gap: tokenNumber("--rail-gap", 1.9444) * u,
    width: tokenNumber("--rail-w", 1.75) * u,
    slotH: tokenNumber("--rail-slot-h", 4.6667) * u,
    pitch: tokenNumber("--rail-slot-pitch", 5.0556) * u
  };
}

function railDimensions(node) {
  if (node.type === "concept") return CONCEPT_RAIL_DIMENSIONS;
  if (node.type === "question") return QUESTION_RAIL_DIMENSIONS;
  return [];
}

function railBounds(node, dimensions) {
  const {gap, width, slotH, pitch} = railGeometry();
  const left = glyphExtent(node) + gap;
  const top = -(slotH + pitch * (dimensions.length - 1)) / 2;
  return {
    left,
    right: left + width,
    top,
    bottom: top + slotH + pitch * (dimensions.length - 1),
    width,
    slotH,
    pitch,
  };
}

// §16.2 A1/A2: the decision rail — review-gated dimensions only, one drawn
// slot each in fixed order. Undecided stays an unstruck slot; a decided
// ordinal level is a struck mark whose extent carries it; disputed is the
// fork. A non-ordinal question status uses one uniform baseline strike. Shared
// bounds anchor it beyond the complete kind-mark footprint and also drive edge
// trimming. Only kinds that admit gated dimensions call this at all.
function makeRail(entry, dimensions, bounds) {
  const {left: x, top, width, slotH, pitch} = bounds;
  const u = plateUnit();
  const radius = tokenNumber("--rail-radius", 0.4667) * u;
  const split = tokenNumber("--rail-mark-split", 1.3611) * u;
  const rail = svgElement("g", "rail");
  const decided = new Set(entry.decided);
  dimensions.forEach((slot, index) => {
    const y = top + index * pitch;
    const groove = plainRect("rail-slot", x, y, width, slotH, radius);
    groove.dataset.dimension = slot.dimension;
    rail.append(groove);
    if (!decided.has(slot.dimension)) return;
    const value = entry[slot.dimension];
    const bottom = y + slotH;
    if (slot.fork === value) {
      const forkH = tokenNumber("--rail-mark-2", 3.1111) * u;
      const tineW = width / 3;
      rail.append(
        plainRect("rail-mark", x, bottom - forkH + split, width, forkH - split, radius),
        plainRect("rail-mark", x, bottom - forkH, tineW, split),
        plainRect("rail-mark", x + width - tineW, bottom - forkH, tineW, split)
      );
    } else {
      const markIndex = Number.isInteger(slot.uniformMark)
        ? slot.uniformMark : slot.marks[value];
      const markH = tokenNumber(RAIL_MARK_TOKENS[markIndex], 0.5833) * u;
      rail.append(plainRect("rail-mark", x, bottom - markH, width, markH, radius));
    }
  });
  return rail;
}

// The field-undefined hairline frame (A4 owns boundary dashes now).
function makeCartouche(leftExtent, rightExtent, halfHeight) {
  const pad = tokenNumber("--cartouche-pad", 4);
  return plainRect("cartouche",
    -(leftExtent + pad), -(halfHeight + pad),
    leftExtent + rightExtent + 2 * pad, 2 * (halfHeight + pad));
}

// The selection is not baked in here. Every plate is drawn the same way and
// the one that is selected is marked afterwards by paintSelection, so both
// render paths build the identical tree and a change of focus never has to
// rebuild one.
function makeNode(node, position, placement) {
  const u = plateUnit();
  const entry = STATE_TYPES.has(node.type) ? accepted.graph.state[node.id] : undefined;
  const texture = STATE_TYPES.has(node.type) ? plateTexture(node, entry) : null;
  const classes = ["node", NODE_CLASSES[node.type]];
  if (node.fields.length === 0) classes.push("field-undefined");
  if (texture) classes.push("tx-" + texture);
  if (entry && entry.freshness) classes.push("fresh-" + entry.freshness);
  const group = svgElement("g", classes.join(" "));
  group.setAttribute("transform", "translate(" + position.x.toFixed(3) + " " + position.y.toFixed(3) + ")");
  group.setAttribute("role", "button");
  // Only the selection joins the tab order — near the 2,400-node ceiling a
  // per-node tab stop buries everything after the graph. The list lens is
  // the dense keyboard path; click-focus still works via tabindex="-1".
  group.setAttribute("tabindex", "-1");
  group.dataset.nodeId = node.id;
  const accessible = svgElement("title");
  accessible.textContent = (node.title || node.id) + ", " + node.type.replaceAll("_", " ");
  group.append(accessible);
  // Concentric outside the selection ring so "selected" and "focused"
  // stay readable at the same time.
  const focusRing = svgElement("circle", "focus-ring");
  focusRing.setAttribute("r", (19 * u).toFixed(2));
  group.append(focusRing);
  const ring = svgElement("circle", "selection-ring");
  ring.setAttribute("r", (15 * u).toFixed(2));
  group.append(ring);
  appendKindMarks(group, node);
  if (texture === "dot") {
    const dot = svgElement("circle", "plate-dot");
    dot.setAttribute("r", (tokenNumber("--tx-dot-r", 1.3222) * u).toFixed(2));
    group.append(dot);
  }
  if (texture === "keyline") group.append(keylineShape(node));
  const dimensions = entry === undefined ? [] : railDimensions(node);
  const hasRail = dimensions.length > 0;
  const drawnExtent = glyphExtent(node);
  const bounds = hasRail ? railBounds(node, dimensions) : null;
  if (bounds) group.append(makeRail(entry, dimensions, bounds));
  const rightExtent = Math.max(
    drawnExtent,
    bounds ? bounds.right : 0);
  if (node.fields.length === 0) {
    const halfHeight = Math.max(
      drawnExtent,
      bounds ? Math.max(-bounds.top, bounds.bottom) : 0);
    group.append(makeCartouche(
      drawnExtent, Math.max(rightExtent, drawnExtent), halfHeight));
  }
  const label = svgElement("text", "node-label");
  const gap = tokenNumber("--label-gap", 4);
  const slot = placement || {side: "right", offset: 4};
  if (slot.side === "left") {
    const leftExtent = Math.max(drawnExtent, bounds ? -bounds.left : 0);
    label.setAttribute("x", (-(leftExtent + gap)).toFixed(2));
    label.setAttribute("text-anchor", "end");
  } else {
    label.setAttribute("x", (rightExtent + gap).toFixed(2));
  }
  label.setAttribute("y", slot.offset.toFixed(2));
  label.textContent = displayTitle(node);
  group.append(label);
  group.addEventListener("click", (event) => {
    event.stopPropagation();
    updateFocus(node.id);
  });
  group.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    updateFocus(node.id);
  });
  return group;
}

function makeZoomControls() {
  const controls = htmlElement("div", "zoom-controls");
  const plus = htmlElement("button", "", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", "Zoom in");
  const minus = htmlElement("button", "", "−");
  minus.type = "button";
  minus.setAttribute("aria-label", "Zoom out");
  plus.addEventListener("click", () => zoomAt(1.25, VIEW_WIDTH / 2, VIEW_HEIGHT / 2));
  minus.addEventListener("click", () => zoomAt(0.8, VIEW_WIDTH / 2, VIEW_HEIGHT / 2));
  controls.append(plus, minus);
  return controls;
}

// The floor drops to whatever the opening view needed: on a field wider than
// the frame the fit zoom is already below ZOOM_MIN, and a reader who zooms out
// must be able to get back to the whole picture.
function clampZoom(value, floor) {
  return Math.max(floor ?? ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function renderedSvgScale(svg) {
  const bounds = svg.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return 1;
  return Math.min(bounds.width / VIEW_WIDTH, bounds.height / VIEW_HEIGHT);
}

function applyTransform(transform) {
  transform.viewport.setAttribute("transform", "translate(" + transform.x.toFixed(3) + " " + transform.y.toFixed(3) + ") scale(" + transform.zoom.toFixed(5) + ")");
  applyDashScale(transform);
  // §16.2 A11: channels drop whole and in the fixed order as density rises.
  // Density is the typical on-screen spacing — layout spacing × zoom × the
  // rendered-to-viewBox scale — so crowding, zoom, a narrow embed, and an open
  // panel degrade identically. The status line names every omission.
  const spacing = (transform.spacing ?? Number.POSITIVE_INFINITY)
    * transform.zoom * renderedSvgScale(transform.svg);
  const plateR = plateRadius();
  const independentlyEngaged = DENSITY_TIERS.map(
    (tier) => spacing < plateR * tokenNumber(tier.token, tier.fallbackX),
  );
  const engaged = new Array(DENSITY_TIERS.length);
  let deeperTierEngaged = false;
  for (let index = DENSITY_TIERS.length - 1; index >= 0; index -= 1) {
    deeperTierEngaged = deeperTierEngaged || independentlyEngaged[index];
    engaged[index] = deeperTierEngaged;
  }
  const dropped = [];
  DENSITY_TIERS.forEach((tier, index) => {
    transform.viewport.classList.toggle(tier.className, engaged[index]);
    if (engaged[index]) dropped.push(tier.copy);
  });
  transform.dropped = dropped;
  renderStatus();
}

// A3's dash has to survive being drawn: the period is in layout units, so a
// field held whole at a fiftieth of its size asks for fifty times the dashes
// it can show, on every edge — a quarter-second a frame. Below zoom 1 the dash
// holds its own size; at or above it the authored period is exact. Written
// only when it changes, so a pan does not restyle every edge.
function applyDashScale(transform) {
  const scale = 1 / Math.min(1, transform.zoom);
  if (transform.dashScale === scale) return;
  transform.dashScale = scale;
  transform.viewport.style.setProperty("--dash-scale", scale.toFixed(4));
  // The head is sized in stroke-width units, so the stroke's own floor would
  // multiply it by the same lift and a direction mark would outgrow the plate
  // it points at. The head keeps the picture's scale.
  const lift = Math.max(1, tokenNumber("--edge-hairline", 0.6) * scale);
  const marker = document.getElementById("arrow");
  if (marker) {
    marker.setAttribute("markerWidth", (ARROW_UNITS / lift).toFixed(4));
    marker.setAttribute("markerHeight", (ARROW_UNITS / lift).toFixed(4));
  }
}

function installDensityResize(transform) {
  densityResizeObserver = new ResizeObserver(() => {
    if (currentTransform === transform && transform.svg.isConnected) {
      applyTransform(transform);
    }
  });
  densityResizeObserver.observe(transform.svg);
}

function zoomAt(factor, x, y) {
  if (!currentTransform) return;
  const oldZoom = currentTransform.zoom;
  const nextZoom = clampZoom(oldZoom * factor, currentTransform.minZoom);
  const worldX = (x - currentTransform.x) / oldZoom;
  const worldY = (y - currentTransform.y) / oldZoom;
  currentTransform.x = x - worldX * nextZoom;
  currentTransform.y = y - worldY * nextZoom;
  currentTransform.zoom = nextZoom;
  applyTransform(currentTransform);
}

function installPanZoom(transform) {
  const {svg} = transform;
  let drag = null;
  let moved = false;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const bounds = svg.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * VIEW_WIDTH / bounds.width;
    const y = (event.clientY - bounds.top) * VIEW_HEIGHT / bounds.height;
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, x, y);
  }, {passive: false});
  // The whole picture is the only thing to take hold of, so a press anywhere
  // takes hold of it: requiring bare background failed wherever an edge's 12px
  // hit stroke lay, which on a dense field is most of the canvas.
  svg.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            originX: event.clientX, originY: event.clientY};
    moved = false;
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    // A press released outside the element never delivers its pointerup here,
    // so the drag would still be standing when the pointer wanders back and
    // would pan the field with no button held.
    if (event.buttons === 0) {
      drag = null;
      svg.classList.remove("dragging");
      return;
    }
    const screenDx = event.clientX - drag.x;
    const screenDy = event.clientY - drag.y;
    // How far the pointer is from where it landed, not how far it has walked:
    // a hand shaking inside one pixel covers no distance, and summing every
    // step would call the sixth shake a pan.
    const wandered = Math.abs(event.clientX - drag.originX)
      + Math.abs(event.clientY - drag.originY);
    // A press that wanders a pixel or two is still a press. Only a real
    // journey becomes a pan — and then the pointer is captured, so the
    // gesture survives leaving the node or edge it started on.
    if (!moved && wandered > DRAG_SLOP) {
      moved = true;
      svg.setPointerCapture(event.pointerId);
      svg.classList.add("dragging");
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    // Below the slop the picture holds still: a hand that shakes a pixel
    // while clicking must not leave the camera somewhere new.
    if (!moved) return;
    transform.x += screenDx * VIEW_WIDTH / svg.clientWidth;
    transform.y += screenDy * VIEW_HEIGHT / svg.clientHeight;
    applyTransform(transform);
  });
  const stopDrag = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    svg.classList.remove("dragging");
    // A cancelled sequence synthesises no click, so the suppression below
    // would still be armed and would eat the reader's next one.
    if (event.type === "pointercancel") moved = false;
  };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
  // A drag that happened to start on a node dragged the picture, not the
  // node: it must not also open the node. Caught on the way down, before the
  // node's own handler, so the two gestures never both fire.
  svg.addEventListener("click", (event) => {
    if (!moved) return;
    // Immediate: the background handler below sits on this same element, so
    // plain propagation still reaches it and a pan over bare ground would
    // close the reader's selection.
    event.stopImmediatePropagation();
    event.preventDefault();
    moved = false;
  }, true);
  svg.addEventListener("click", (event) => {
    if (event.target === svg && !moved) updateFocus(null);
    moved = false;
  });
}

function installKeyboardPanZoom(stage, transform) {
  stage.addEventListener("keydown", (event) => {
    const focusedNode = event.target.closest && event.target.closest(".node");
    if (event.target !== transform.svg && !focusedNode) return;
    // Map semantics: an arrow looks toward that side, so content slides the
    // opposite way (ArrowLeft reveals what lies to the left).
    const delta = 40;
    if (event.key === "ArrowLeft") transform.x += delta;
    else if (event.key === "ArrowRight") transform.x -= delta;
    else if (event.key === "ArrowUp") transform.y += delta;
    else if (event.key === "ArrowDown") transform.y -= delta;
    else if (event.key === "+" || event.key === "=") zoomAt(1.25, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
    else if (event.key === "-") zoomAt(0.8, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
    else return;
    event.preventDefault();
    if (event.key.startsWith("Arrow")) applyTransform(transform);
  });
}

function renderLegend() {
  legend.replaceChildren();
  const nodesSection = htmlElement("section", "legend-nodes");
  nodesSection.append(htmlElement("h2", "", "Nodes"));
  for (const type of NODE_TYPES) {
    // zone/pattern are body-field kinds; §29 freeze — the node-link view
    // never draws them, so the legend does not promise them.
    if (type === "zone" || type === "pattern") continue;
    const row = htmlElement("div", "legend-row");
    appendNodeGlyph(row, {type});
    row.append(htmlElement("span", "", type.replaceAll("_", " ")));
    nodesSection.append(row);
  }

  const edgesSection = htmlElement("section", "legend-edges");
  edgesSection.append(htmlElement("h2", "", "Edges"));
  for (const family of EDGE_FAMILIES) {
    const row = htmlElement("div", "legend-row");
    const sample = svgElement("svg", "legend-edge-sample");
    sample.setAttribute("viewBox", "0 0 34 12");
    sample.setAttribute("aria-hidden", "true");
    sample.setAttribute("focusable", "false");
    const line = svgElement("line", "edge-line " + family.className);
    line.setAttribute("x1", "2");
    line.setAttribute("y1", "6");
    line.setAttribute("x2", "32");
    line.setAttribute("y2", "6");
    sample.append(line);
    row.append(sample, htmlElement("span", "", family.label));
    edgesSection.append(row);
  }
  edgesSection.append(htmlElement("p", "legend-direction", "arrowhead = direction; related_to and alternative_to have none"));
  // §16.2 A2/A8: the open gap is spoken as well as drawn, and the panel says
  // the same words for the same state.
  edgesSection.append(htmlElement("p", "legend-direction", "weight: tick length is low, medium, or high; an open gap means no decision recorded; edge types that carry no weight stay unbroken"));

  // §16.2 A8: the plate, boundary, and rail marks each get their words here —
  // the same vocabulary the panel rows and list columns use.
  const plateSection = htmlElement("section", "legend-state");
  plateSection.append(htmlElement("h2", "", "Plate"));
  const textureRows = [
    ["plain", "unseen · no contact"],
    ["dot", "touched · skim"],
    ["hatch", "read"],
    ["cross", "summarized"],
    ["solid", "applied"],
    ["keyline", "taught"]
  ];
  for (const [texture, label] of textureRows) {
    const row = htmlElement("div", "legend-row");
    // Samples draw their hatching literally: the pattern defs live in the
    // field svg, and the legend must read the same in the list lens too.
    const sampleClass = texture === "solid" || texture === "keyline"
      ? "node-concept" : "node-concept tx-plain";
    row.append(makeStateSample(sampleClass, (contents) => {
      const shape = svgElement("circle", "node-shape");
      shape.setAttribute("r", "6");
      contents.append(shape);
      if (texture === "dot") {
        const dot = svgElement("circle", "plate-dot");
        dot.setAttribute("r", "1.8");
        contents.append(dot);
      }
      if (texture === "hatch" || texture === "cross") {
        for (const [x1, y1, x2, y2] of texture === "hatch"
          ? [[-4, 4, 4, -4], [-4, 0, 0, -4], [0, 4, 4, 0]]
          : [[-4, 4, 4, -4], [-4, 0, 0, -4], [0, 4, 4, 0], [-4, -4, 4, 4], [-4, 0, 0, 4], [0, -4, 4, 0]]) {
          const stroke = svgElement("line", "tx-ink-concept");
          stroke.setAttribute("x1", x1); stroke.setAttribute("y1", y1);
          stroke.setAttribute("x2", x2); stroke.setAttribute("y2", y2);
          contents.append(stroke);
        }
      }
      if (texture === "keyline") {
        const inner = svgElement("circle", "plate-keyline");
        inner.setAttribute("r", "3.6");
        contents.append(inner);
      }
    }));
    row.append(htmlElement("span", "", label));
    plateSection.append(row);
  }
  plateSection.append(htmlElement("p", "legend-direction", "texture is the node's own contact ladder — concept exposure, material depth reached; a container never borrows its parts' contact"));

  const boundarySection = htmlElement("section", "legend-state");
  boundarySection.append(htmlElement("h2", "", "Boundary"));
  for (const [freshness, label] of [["fresh", "fresh"], ["aging", "aging"], ["stale", "stale (label recedes)"]]) {
    const row = htmlElement("div", "legend-row");
    row.append(makeStateSample("node-concept tx-plain fresh-" + freshness, (contents) => {
      const shape = svgElement("circle", "node-shape");
      shape.setAttribute("r", "6");
      contents.append(shape);
    }));
    row.append(htmlElement("span", "", label));
    boundarySection.append(row);
  }
  boundarySection.append(htmlElement("p", "legend-direction", "a dash on a node boundary is always freshness; an empty plate with a solid boundary has no contact"));

  const railSection = htmlElement("section", "legend-state");
  railSection.append(htmlElement("h2", "", "Decision rail"));
  const railRows = [
    ["slot", "open slot = no decision recorded"],
    ["mark", "struck mark = confirmed; height = decided level where ordinal"],
    ["fork", "split mark = disputed"]
  ];
  for (const [kind, label] of railRows) {
    const row = htmlElement("div", "legend-row");
    row.append(makeStateSample("", (contents) => {
      contents.append(plainRect("rail-slot", -2.25, -6, 4.5, 12, 1.2));
      if (kind === "mark") contents.append(plainRect("rail-mark", -2.25, -2, 4.5, 8, 1.2));
      if (kind === "fork") {
        contents.append(
          plainRect("rail-mark", -2.25, -2 + 3.5, 4.5, 4.5, 1.2),
          plainRect("rail-mark", -2.25, -2, 1.5, 3.5),
          plainRect("rail-mark", 0.75, -2, 1.5, 3.5)
        );
      }
    }));
    row.append(htmlElement("span", "", label));
    railSection.append(row);
  }
  railSection.append(htmlElement("p", "legend-direction", "concept slots top to bottom: confidence, clarity, coverage; a question carries one status slot whose uniform strike means confirmed and whose words carry open, clarified, resolved, or stale; kinds without review-gated dimensions carry no rail"));

  legend.append(nodesSection, edgesSection, plateSection, boundarySection, railSection);
}

function makeStateSample(className, build) {
  const sample = svgElement("svg", "node-glyph legend-state-sample" + (className ? " " + className : ""));
  sample.setAttribute("viewBox", "0 0 16 16");
  sample.setAttribute("aria-hidden", "true");
  sample.setAttribute("focusable", "false");
  const contents = svgElement("g");
  contents.setAttribute("transform", "translate(8 8)");
  build(contents);
  sample.append(contents);
  return sample;
}

function setLegendOpen(open) {
  if (open && !legend.childNodes.length) renderLegend();
  const hadFocus = legend.contains(document.activeElement);
  legend.hidden = !open;
  legendToggle.setAttribute("aria-expanded", String(open));
  // The legend is a focusable scroll region: focus moves in on open so
  // keyboard users can scroll overflowing rows, and back on close.
  if (open) legend.focus({preventScroll: true});
  else if (hadFocus || focusOrphaned()) legendToggle.focus();
}

function updateFocus(nodeId) {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const address = parseFragment(raw);
  const entries = address.kind === "ADDRESS" ? address.entries.filter((entry) => entry.key !== "focus") : [];
  if (nodeId !== null) entries.push({key: "focus", value: nodeId});
  const next = entries.map((entry) => encodeURIComponent(entry.key) + "=" + encodeURIComponent(entry.value)).join("&");
  location.hash = next;
}

function appendKnownObject(parent, key, value) {
  const names = key === "source" ? ["artifact", "encounter"] : ["question", "artifact"];
  const parts = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) parts.push(name + ": " + value[name]);
  }
  parent.textContent = parts.join(" · ");
}

function appendDetailValue(parent, key, value) {
  if (key === "url") {
    let parsed = null;
    try { parsed = new URL(value); } catch (_error) { parsed = null; }
    if (parsed && parsed.protocol === "https:") {
      const link = htmlElement("a", "", value);
      link.setAttribute("href", value);
      // No target="_blank": the §16.5 sandbox grants no popups, so an
      // auxiliary context would make user-clicked links inert in a
      // conforming embed; same-context navigation stays the user's click.
      link.setAttribute("rel", "noopener noreferrer");
      parent.append(link);
    } else {
      parent.textContent = value;
    }
  } else if (Array.isArray(value)) {
    parent.textContent = value.length ? value.join(", ") : "—";
  } else if (value && typeof value === "object") {
    appendKnownObject(parent, key, value);
  } else {
    parent.textContent = String(value);
  }
}

function openPanel(node, edges) {
  details.hidden = false;
  shell.classList.add("details-open");
  detailContent.replaceChildren();
  detailContent.append(htmlElement("h2", "", node.title || node.id));
  const meta = htmlElement("div", "detail-meta");
  meta.append(htmlElement("span", "type-chip", node.type.replaceAll("_", " ")));
  detailContent.append(meta, htmlElement("div", "detail-id", node.id));
  const fieldsCopy = node.fields.length ? "fields: " + node.fields.join(", ") : "fields: — (field undefined)";
  detailContent.append(htmlElement("div", "detail-fields", fieldsCopy));
  if (node.formerly && node.formerly.length) detailContent.append(htmlElement("div", "detail-formerly", "formerly: " + node.formerly.join(", ")));
  const flags = htmlElement("div", "detail-flags");
  if (node.sensitivity) flags.append(htmlElement("span", "badge", "sensitivity: " + node.sensitivity));
  if (node.fields.length === 0) flags.append(htmlElement("span", "badge", "field undefined"));
  if (flags.childNodes.length) detailContent.append(flags);

  // §16.2 A8: every state drawn in the field is words here, same vocabulary.
  if (STATE_TYPES.has(node.type)) {
    const entry = accepted.graph.state[node.id];
    const section = htmlElement("section", "state-groups");
    section.append(htmlElement("h3", "", "state"));
    const stateRows = htmlElement("dl", "detail-rows");
    const spoken = stateWords(node, entry);
    for (const [label, words] of spoken) {
      const row = htmlElement("div", "detail-row");
      row.append(htmlElement("dt", "", label), htmlElement("dd", "", words));
      stateRows.append(row);
    }
    section.append(stateRows);
    detailContent.append(section);
  }

  const rows = htmlElement("dl", "detail-rows");
  for (const key of DETAIL_FIELDS[node.type]) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const row = htmlElement("div", "detail-row");
    const term = htmlElement("dt", "", key.replaceAll("_", " "));
    const description = htmlElement("dd");
    if (LONG_FIELDS.has(key)) {
      const paragraph = htmlElement("p", "detail-long");
      appendDetailValue(paragraph, key, node[key]);
      description.append(paragraph);
    } else {
      appendDetailValue(description, key, node[key]);
    }
    row.append(term, description);
    rows.append(row);
  }
  if (rows.childNodes.length) detailContent.append(rows);
  appendEdgeGroups(node, edges);
}

function appendEdgeGroups(node, edges) {
  const incident = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  if (!incident.length) return;
  const container = htmlElement("section", "edge-groups");
  for (const type of EDGE_TYPES) {
    const groupEdges = incident.filter((edge) => edge.type === type);
    if (!groupEdges.length) continue;
    const group = htmlElement("div");
    group.append(htmlElement("h3", "", type));
    const list = htmlElement("div", "edge-group-list");
    for (const edge of groupEdges) {
      const outgoing = edge.source === node.id;
      const otherId = outgoing ? edge.target : edge.source;
      const line = htmlElement("div");
      line.append(document.createTextNode(outgoing ? "→ " : "← "));
      const button = htmlElement("button", "", otherId);
      button.type = "button";
      button.addEventListener("click", () => updateFocus(otherId));
      line.append(button);
      if (edge.weight) line.append(document.createTextNode(" (weight: " + edge.weight + ")"));
      list.append(line);
      const meta = [];
      if (edge.step) meta.push("step: " + edge.step);
      if (edge.order) meta.push("order: " + edge.order);
      if (edge.context) meta.push("context: " + edge.context);
      if (meta.length) list.append(htmlElement("div", "edge-meta", meta.join(" · ")));
    }
    group.append(list);
    container.append(group);
  }
  detailContent.append(container);
}

// §25.8/§16.5: enforce the byte cap while streaming — an oversized graph is
// rejected as soon as byte cap+1 arrives, never fully downloaded and
// allocated first. Returns null on a breach.
async function readBounded(response, cap) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    void response.body?.cancel?.();
    return null;
  }
  if (!response.body || !response.body.getReader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > cap ? null : buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

async function loadGraph() {
  renderLoadState();
  let response;
  try {
    response = await fetch("../graph/atlas-graph.json", {cache: "no-store"});
  } catch (_error) {
    loadState = "MISSING";
    renderLoadState();
    return;
  }
  if (!response.ok) {
    loadState = "MISSING";
    renderLoadState();
    return;
  }
  let buffer;
  try {
    buffer = await readBounded(response, CEILINGS.graph_file_bytes);
  } catch (_error) {
    loadState = "REJECTED";
    renderLoadState();
    return;
  }
  const result = buffer === null
    ? {kind: "REJECTED", diagnostic: {path: "", rule: "graphFileBytes"}}
    : acceptGraphBuffer(buffer);
  if (result.kind === "REJECTED") {
    console.warn("Atlas graph rejected at " + result.diagnostic.path + ": " + result.diagnostic.rule);
    loadState = "REJECTED";
  } else if (result.kind === "UNSUPPORTED_VERSION") {
    unsupportedVersion = result.version;
    loadState = "UNSUPPORTED_VERSION";
  } else {
    accepted = result;
    loadState = "ACCEPTED";
    // A newly accepted graph must never draw on the previous one's
    // coordinates, and the ordinals the memo keys on are its ordinals.
    layoutMemo.clear();
    layoutOrdinals = null;
  }
  await dispatch();
}

window.addEventListener("hashchange", () => { void dispatch(); });
routesToggle.addEventListener("change", () => { void dispatch(); });
horizonSelect.addEventListener("change", () => { void dispatch(); });
graphView.addEventListener("click", () => {
  viewMode = "graph";
  void dispatch();
});
listView.addEventListener("click", () => {
  viewMode = "list";
  void dispatch();
});
legendToggle.addEventListener("click", () => setLegendOpen(legend.hidden));
closeDetails.addEventListener("click", () => updateFocus(null));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // Layered dismissal: one Escape closes one surface, topmost first.
  if (!legend.hidden) setLegendOpen(false);
  else if (!details.hidden) updateFocus(null);
});

void loadGraph();
