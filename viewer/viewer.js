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
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const ROUTE_TYPES = new Set(["step_of_route", "suggested_next"]);
const TRAIL_TYPES = new Set(["moved_to", "via", "produced_artifact"]);
const AUTHORED_TYPES = new Set(["related_to", "prerequisite_of", "extends", "implements", "contradicts", "explains", "demonstrates", "critiques", "mentions", "loads", "supports"]);
const STRUCTURAL_TYPES = new Set(["has_part", "overall_concept", "part_of_direction"]);
const EDGE_FAMILIES = [
  {key: "route", className: "edge-route", label: "routes (hideable)"},
  {key: "trail", className: "edge-trail", label: "trail"},
  {key: "authored", className: "edge-authored", label: "authored (opacity shows weight)"},
  {key: "structural", className: "edge-structural", label: "structure"},
  {key: "journal", className: "edge-journal", label: "journal-derived"}
];
const EDGE_FAMILY_CLASSES = Object.fromEntries(EDGE_FAMILIES.map((family) => [family.key, family.className]));
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
const graphView = document.querySelector("#graph-view");
const listView = document.querySelector("#list-view");
const legendToggle = document.querySelector("#legend-toggle");
const legend = document.querySelector("#legend");

let accepted = null;
let loadState = "LOADING";
let unsupportedVersion = null;
let renderGeneration = 0;
let currentTransform = null;
let viewMode = "graph";

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
  currentTransform = null;
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
  const pastCeiling = nodes.length > RENDER_NODE_LINK_CEILING;
  setLensControls(pastCeiling);
  if (pastCeiling || viewMode === "list") {
    renderList(field, nodes, edges, selected, banner, pastCeiling);
    return;
  }
  await renderField(field, nodes, edges, selected, banner);
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

// An accepted graph may hold up to the §25.8 node ceiling; the list stays
// responsive by previewing each section and expanding on explicit request
// (never silently), in frame-sized chunks.
const LIST_SECTION_PREVIEW = 500;
const LIST_EXPAND_CHUNK = 1000;

function makeListRow(node, selected) {
  const row = htmlElement("button", "node-list-row");
  row.type = "button";
  row.dataset.nodeId = node.id;
  appendNodeGlyph(row, node);
  row.append(htmlElement("span", "node-list-title", displayTitle(node)));
  row.append(htmlElement("span", "node-list-id", node.id));
  if (node.fields.length === 0) row.append(htmlElement("span", "badge", "field undefined"));
  if (selected && selected.id === node.id) row.classList.add("selected");
  row.addEventListener("click", () => updateFocus(node.id));
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

function renderList(field, nodes, edges, selected, banner, pastCeiling) {
  resetScreen(field);
  setMainState("LIST");
  setStatus(nodes.length, edges.length);
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

function layoutIteration(sorted, positions, edges) {
  const force = new Map(sorted.map((node) => [node.id, {x: 0, y: 0}]));
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = positions.get(sorted[leftIndex].id);
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = positions.get(sorted[rightIndex].id);
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 0.01) {
        dx = 0.1 + leftIndex * 0.001;
        dy = 0.1 + rightIndex * 0.001;
        distanceSquared = dx * dx + dy * dy;
      }
      const distance = Math.sqrt(distanceSquared);
      const magnitude = 1800 / distanceSquared;
      const fx = magnitude * dx / distance;
      const fy = magnitude * dy / distance;
      force.get(sorted[leftIndex].id).x -= fx;
      force.get(sorted[leftIndex].id).y -= fy;
      force.get(sorted[rightIndex].id).x += fx;
      force.get(sorted[rightIndex].id).y += fy;
    }
  }
  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
    const magnitude = (distance - 86) * 0.018;
    const fx = magnitude * dx / distance;
    const fy = magnitude * dy / distance;
    force.get(edge.source).x += fx;
    force.get(edge.source).y += fy;
    force.get(edge.target).x -= fx;
    force.get(edge.target).y -= fy;
  }
  for (const node of sorted) {
    const position = positions.get(node.id);
    const delta = force.get(node.id);
    position.x += Math.max(-8, Math.min(8, delta.x * 0.08 - position.x * 0.004));
    position.y += Math.max(-8, Math.min(8, delta.y * 0.08 - position.y * 0.004));
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function calculateLayout(nodes, edges, generation) {
  const {sorted, positions} = initialPositions(nodes);
  for (let iteration = 0; iteration < 120; iteration += 1) {
    layoutIteration(sorted, positions, edges);
    if ((iteration + 1) % 4 === 0) {
      await nextFrame();
      if (generation !== renderGeneration) return null;
    }
  }
  if (sorted.length === 0) return positions;
  const xs = sorted.map((node) => positions.get(node.id).x);
  const ys = sorted.map((node) => positions.get(node.id).y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min((VIEW_WIDTH - 110) / Math.max(maxX - minX, 1), (VIEW_HEIGHT - 100) / Math.max(maxY - minY, 1));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  for (const node of sorted) {
    const position = positions.get(node.id);
    position.x = VIEW_WIDTH / 2 + (position.x - centerX) * scale;
    position.y = VIEW_HEIGHT / 2 + (position.y - centerY) * scale;
  }
  return positions;
}

async function renderField(field, nodes, edges, selected, banner) {
  resetScreen(field);
  const generation = renderGeneration;
  const renderedEdges = visibleEdges(edges);
  setMainState("LAYOUT");
  main.append(htmlElement("div", "layout-message", "Laying out " + nodes.length + " nodes…"));
  setStatus(nodes.length, renderedEdges.length);
  const positions = await calculateLayout(nodes, edges, generation);
  if (!positions || generation !== renderGeneration) return;
  main.replaceChildren();
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
  for (const edge of renderedEdges) {
    viewport.append(makeEdge(edge, positions, nodeById));
  }
  let selectedGroup = null;
  for (const node of nodes) {
    const group = makeNode(node, positions.get(node.id), selected && selected.id === node.id);
    viewport.append(group);
    if (selected && selected.id === node.id) selectedGroup = group;
  }

  const focusedPosition = selected ? positions.get(selected.id) : null;
  const transform = {
    x: focusedPosition ? VIEW_WIDTH / 2 - focusedPosition.x : 0,
    y: focusedPosition ? VIEW_HEIGHT / 2 - focusedPosition.y : 0,
    zoom: 1
  };
  currentTransform = {svg, viewport, ...transform};
  applyTransform(currentTransform);
  installPanZoom(currentTransform);
  installKeyboardPanZoom(stage, currentTransform);
  if (selected) openPanel(selected, visibleEdges(accepted.graph.edges));
  if (banner) appendBanner(banner.kind, banner.value);
  if (selectedGroup && focusOrphaned()) selectedGroup.focus({preventScroll: true});
}

// §16.2: the Routes lens is coherent across surfaces — hidden routes leave
// the detail panel too, not only the SVG overlay.
function visibleEdges(edges) {
  if (routesToggle.checked) return edges;
  const nodeById = new Map(accepted.graph.nodes.map((node) => [node.id, node]));
  return edges.filter((edge) => !isRouteEdge(edge, nodeById));
}

function setStatus(nodeCount, edgeCount) {
  let copy = nodeCount + " nodes · " + edgeCount + " edges in view";
  if (accepted.graph.generated_at) copy += " · as of " + accepted.graph.generated_at.slice(0, 10);
  statusBar.textContent = copy;
}

function makeDefinitions() {
  const defs = svgElement("defs");
  const marker = svgElement("marker");
  marker.setAttribute("id", "arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const path = svgElement("path");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  path.setAttribute("fill", "context-stroke");
  marker.append(path);
  defs.append(marker);
  return defs;
}

function isRouteEdge(edge, nodeById) {
  if (ROUTE_TYPES.has(edge.type)) return true;
  if (edge.type !== "primary_for" && edge.type !== "supporting_for") return false;
  const target = nodeById.get(edge.target);
  return target && target.type === "suggested_route";
}

function edgeClass(edge, nodeById) {
  if (isRouteEdge(edge, nodeById)) return EDGE_FAMILY_CLASSES.route;
  if (TRAIL_TYPES.has(edge.type)) return EDGE_FAMILY_CLASSES.trail;
  if (AUTHORED_TYPES.has(edge.type)) return EDGE_FAMILY_CLASSES.authored;
  if (STRUCTURAL_TYPES.has(edge.type)) return EDGE_FAMILY_CLASSES.structural;
  return EDGE_FAMILY_CLASSES.journal;
}

function makeEdge(edge, positions, nodeById) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  const group = svgElement("g", "edge-group");
  const line = svgElement("line", "edge-line " + edgeClass(edge, nodeById));
  const hit = svgElement("line", "edge-hit");
  for (const item of [line, hit]) {
    item.setAttribute("x1", source.x.toFixed(3));
    item.setAttribute("y1", source.y.toFixed(3));
    item.setAttribute("x2", target.x.toFixed(3));
    item.setAttribute("y2", target.y.toFixed(3));
  }
  if (edge.type !== "related_to") line.setAttribute("marker-end", "url(#arrow)");
  const opacity = {"low": 0.45, "medium": 0.7, "high": 1, "unassessed": 0.7}[edge.weight] || 0.7;
  line.setAttribute("stroke-opacity", String(opacity));
  const label = svgElement("text", "edge-label");
  label.setAttribute("x", ((source.x + target.x) / 2).toFixed(3));
  label.setAttribute("y", ((source.y + target.y) / 2 - 6).toFixed(3));
  label.textContent = edge.type;
  group.addEventListener("mouseenter", () => label.classList.add("visible"));
  group.addEventListener("mouseleave", () => label.classList.remove("visible"));
  group.append(line, hit, label);
  return group;
}

function polygon(points) {
  const shape = svgElement("polygon", "node-shape");
  shape.setAttribute("points", points);
  return shape;
}

function primaryShape(node) {
  let shape;
  if (["concept", "pattern", "question"].includes(node.type)) {
    shape = svgElement("circle", "node-shape");
    shape.setAttribute("r", "7");
  } else if (node.type === "material") {
    shape = svgElement("rect", "node-shape");
    shape.setAttribute("x", "-6.5"); shape.setAttribute("y", "-6.5"); shape.setAttribute("width", "13"); shape.setAttribute("height", "13"); shape.setAttribute("rx", "3");
  } else if (node.type === "material_part") {
    shape = svgElement("rect", "node-shape");
    shape.setAttribute("x", "-4.5"); shape.setAttribute("y", "-4.5"); shape.setAttribute("width", "9"); shape.setAttribute("height", "9");
  } else if (node.type === "suggested_route") {
    shape = polygon("0,-7 7,0 0,7 -7,0");
  } else if (node.type === "direction") {
    shape = polygon("0,-8 8,6 -8,6");
  } else if (node.type === "probe") {
    shape = polygon("-6.5,0 -3.25,-5.6 3.25,-5.6 6.5,0 3.25,5.6 -3.25,5.6");
  } else if (node.type === "artifact") {
    shape = polygon("0,-7 6.7,-2.2 4.1,5.7 -4.1,5.7 -6.7,-2.2");
  } else if (node.type === "encounter") {
    shape = svgElement("circle", "node-shape");
    shape.setAttribute("r", "4.5");
  } else if (node.type === "trail_segment") {
    shape = polygon("0,-7 4,-3.5 4,3.5 0,7 -4,3.5 -4,-3.5");
  } else if (node.type === "personal_trail") {
    shape = svgElement("circle", "node-shape");
    shape.setAttribute("r", "7");
  } else if (node.type === "plan") {
    shape = svgElement("rect", "node-shape");
    shape.setAttribute("x", "-8"); shape.setAttribute("y", "-5.5"); shape.setAttribute("width", "16"); shape.setAttribute("height", "11");
  } else {
    shape = svgElement("circle", "node-shape");
    shape.setAttribute("r", "7");
  }
  return shape;
}

// The kind-distinguishing marks beyond the base shape — question ring,
// personal-trail inner circle, sensitivity dot — shared by field nodes, list
// glyphs, and the legend so no kind collapses to color alone.
function appendKindMarks(target, node) {
  if (node.type === "question") {
    const pull = svgElement("circle", "question-ring");
    pull.setAttribute("r", "11");
    target.append(pull);
  }
  target.append(primaryShape(node));
  if (node.type === "personal_trail") {
    const inner = svgElement("circle", "node-shape");
    inner.setAttribute("r", "4");
    target.append(inner);
  }
  if (node.sensitivity) {
    const dot = svgElement("circle", "sensitivity-dot");
    dot.setAttribute("cx", "8"); dot.setAttribute("cy", "-8"); dot.setAttribute("r", "2.5");
    target.append(dot);
  }
}

function appendNodeGlyph(parent, node) {
  const glyph = svgElement("svg", "node-glyph " + NODE_CLASSES[node.type]);
  glyph.setAttribute("viewBox", "0 0 16 16");
  glyph.setAttribute("aria-hidden", "true");
  glyph.setAttribute("focusable", "false");
  const contents = svgElement("g");
  contents.setAttribute("transform", "translate(8 8) scale(0.8)");
  appendKindMarks(contents, node);
  glyph.append(contents);
  parent.append(glyph);
}

function displayTitle(node) {
  return node.title || node.id.slice(node.id.indexOf(":") + 1);
}

function makeNode(node, position, selected) {
  const classes = ["node", NODE_CLASSES[node.type]];
  if (selected) classes.push("selected");
  if (node.fields.length === 0) classes.push("field-undefined");
  const group = svgElement("g", classes.join(" "));
  group.setAttribute("transform", "translate(" + position.x.toFixed(3) + " " + position.y.toFixed(3) + ")");
  group.setAttribute("role", "button");
  // Only the selection joins the tab order — near the 2,400-node ceiling a
  // per-node tab stop buries everything after the graph. The list lens is
  // the dense keyboard path; click-focus still works via tabindex="-1".
  group.setAttribute("tabindex", selected ? "0" : "-1");
  group.dataset.nodeId = node.id;
  const accessible = svgElement("title");
  accessible.textContent = (node.title || node.id) + ", " + node.type.replaceAll("_", " ");
  group.append(accessible);
  // Concentric outside the r=15 selection ring so "selected" and "focused"
  // stay readable at the same time.
  const focusRing = svgElement("circle", "focus-ring");
  focusRing.setAttribute("r", "19");
  group.append(focusRing);
  if (selected) {
    const ring = svgElement("circle", "selection-ring");
    ring.setAttribute("r", "15");
    group.append(ring);
  }
  appendKindMarks(group, node);
  const label = svgElement("text", "node-label");
  label.setAttribute("x", "11");
  label.setAttribute("y", "4");
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

function clampZoom(value) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function applyTransform(transform) {
  transform.viewport.setAttribute("transform", "translate(" + transform.x.toFixed(3) + " " + transform.y.toFixed(3) + ") scale(" + transform.zoom.toFixed(5) + ")");
  transform.viewport.classList.toggle("zoom-low", transform.zoom < 0.8);
}

function zoomAt(factor, x, y) {
  if (!currentTransform) return;
  const oldZoom = currentTransform.zoom;
  const nextZoom = clampZoom(oldZoom * factor);
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
  svg.addEventListener("pointerdown", (event) => {
    if (event.target !== svg) return;
    drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY};
    moved = false;
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.x) * VIEW_WIDTH / svg.clientWidth;
    const dy = (event.clientY - drag.y) * VIEW_HEIGHT / svg.clientHeight;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
    transform.x += dx;
    transform.y += dy;
    drag.x = event.clientX;
    drag.y = event.clientY;
    applyTransform(transform);
  });
  const stopDrag = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
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
  edgesSection.append(htmlElement("p", "legend-direction", "arrowhead = direction; related_to has none"));
  legend.append(nodesSection, edgesSection);
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
  }
  await dispatch();
}

window.addEventListener("hashchange", () => { void dispatch(); });
routesToggle.addEventListener("change", () => { void dispatch(); });
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
