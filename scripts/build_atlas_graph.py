#!/usr/bin/env python3
"""Build graph/atlas-graph.json from curated atlas/ content (SDD §20, Phase 1).

Phase 1 scope (§29): concept / material / direction / suggested-route parsing,
reference validation, deterministic graph JSON. Journal folding, influence and
frontier are later phases — their §10 keys are emitted empty so the output
shape is final from the first build.

stdlib only (§20): json, pathlib, datetime, re.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURATED = ROOT / "atlas"
OUTPUT = ROOT / "graph" / "atlas-graph.json"

# §10.1 — closed set; a domain pass extends it in the same commit.
NODE_TYPES = {
    "plan", "concept", "material", "material_part", "direction",
    "suggested_route", "personal_trail", "trail_segment", "artifact",
    "encounter", "question", "probe", "zone", "pattern",
}

# id prefix → node type (§10.1: prefix is the hyphenated type name or `part:`).
ID_PREFIXES = {
    "concept": "concept",
    "material": "material",
    "part": "material_part",
    "direction": "direction",
    "suggested-route": "suggested_route",
    "trail-segment": "trail_segment",
    "personal-trail": "personal_trail",
    "artifact": "artifact",
    "encounter": "encounter",
    "question": "question",
    "probe": "probe",
    "plan": "plan",
    "zone": "zone",
    "pattern": "pattern",
}

# §10.2 — closed set; extended only by a domain pass in the same commit.
EDGE_TYPES = {
    "related_to", "prerequisite_of", "extends", "implements", "contradicts",
    "explains", "demonstrates", "critiques", "mentions", "loads", "has_part",
    "overall_concept", "supports", "part_of_direction", "step_of_route",
    "suggested_next", "visited", "moved_to", "via", "pulled_by",
    "produced_artifact", "updates_state", "influences", "probed_by",
    "primary_for", "supporting_for",
}

# §10.1 — id shape is part of the graph contract (§16.4 uses ids as URL focus
# values): kebab-case slugs, underscores never, parts carry the material slug.
_SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
PART_ID_RE = re.compile(rf"^part:{_SLUG}/{_SLUG}$")
NODE_ID_RE = re.compile(rf"^[a-z-]+:{_SLUG}$")

# §9.3/§32.1 — roles an author may write in concept_edges; the structural
# types (has_part, step_of_route, …) are created by the builder only.
AUTHORED_ROLES = {
    "related_to", "prerequisite_of", "extends", "implements", "contradicts",
    "explains", "demonstrates", "critiques", "mentions", "loads",
}

# §32.1: patterns are concept-kind nodes — a program part maps to patterns
# exactly as a chapter maps to concepts.
CONCEPT_KIND = {"concept", "pattern"}

# Endpoint-kind contract per emitted edge type (source kinds, target kinds).
# Authored roles default to part/pattern -> concept-kind; §32.1 pins loads;
# probes reveal understanding (concept-kind) or capacity (zones, §32.2).
ENDPOINT_RULES = {
    "related_to": (CONCEPT_KIND, CONCEPT_KIND),
    "overall_concept": ({"material"}, CONCEPT_KIND),
    "has_part": ({"material"}, {"material_part"}),
    "supports": ({"material", "material_part"}, {"material", "material_part"}),
    "part_of_direction": (CONCEPT_KIND, {"direction"}),
    "step_of_route": (CONCEPT_KIND, {"suggested_route"}),
    "probed_by": (CONCEPT_KIND | {"zone"}, {"probe"}),
    "loads": ({"pattern"}, {"zone"}),
    **{role: ({"material_part", "pattern"}, CONCEPT_KIND)
       for role in ("prerequisite_of", "extends", "implements", "contradicts",
                    "explains", "demonstrates", "critiques", "mentions")},
}

# §14.9 — authored edge weight is a closed scale (the import-time hypothesis).
EDGE_WEIGHTS = {"low", "medium", "high"}

# §9.2/§9.11 — lifecycle vocabulary for everything that is not a route.
LIFECYCLE_STATUSES = {"active", "archived"}

# §9.4 — route lifecycle vocabulary; task-state words are §4 leakage.
ROUTE_STATUSES = {"available", "hidden", "partially_followed", "ignored", "archived"}
FORBIDDEN_ROUTE_STATUSES = {"done", "failed", "late", "blocked"}


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- frontmatter

# A mapping key requires whitespace (or EOL) after the colon — bare ids like
# `material:mdn-http-methods` contain colons and must stay scalars.
_SCALAR_RE = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z_][\w-]*):(?:\s+(?P<value>.*))?$")
_ITEM_RE = re.compile(r"^(?P<indent>\s*)-\s*(?P<value>.*)$")


def _parse_scalar(raw: str):
    raw = raw.strip()
    if raw in ("", "|", ">"):
        return None
    if raw.startswith(("'", '"')) and raw.endswith(raw[0]) and len(raw) >= 2:
        return raw[1:-1]
    if raw == "[]":
        return []
    return raw


def parse_frontmatter(text: str, source: Path) -> dict:
    """Parse the SDD's YAML subset: nested maps, lists of scalars, lists of maps.

    Deliberately small (§20: "use simple frontmatter parser manually"); block
    scalars (`>`/`|`) are folded to a single joined string.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise BuildError(f"{source}: missing frontmatter opening '---'")
    try:
        end = next(i for i, l in enumerate(lines[1:], 1) if l.strip() == "---")
    except StopIteration:
        raise BuildError(f"{source}: missing frontmatter closing '---'") from None
    body = lines[1:end]

    def parse_block(start: int, stop: int, indent: int):
        # Returns (mapping-or-list, consumed-through-index).
        result = None
        i = start
        while i < stop:
            line = body[i]
            if not line.strip() or line.lstrip().startswith("#"):
                i += 1
                continue
            cur_indent = len(line) - len(line.lstrip())
            if cur_indent < indent:
                break
            item = _ITEM_RE.match(line)
            if item and cur_indent == indent:
                if result is None:
                    result = []
                if not isinstance(result, list):
                    raise BuildError(f"{source}: mixed list/map at line {i + end}")
                value = item.group("value")
                inner = _SCALAR_RE.match(value)
                if inner:  # list of maps: "- id: part:a/x"
                    rest, j = parse_block(i + 1, stop, cur_indent + 2)
                    entry = {inner.group("key"): _parse_scalar(inner.group("value") or "")}
                    if isinstance(rest, dict):
                        entry.update(rest)
                        i = j
                    else:
                        i += 1
                    result.append(entry)
                else:
                    result.append(_parse_scalar(value))
                    i += 1
                continue
            scalar = _SCALAR_RE.match(line)
            if scalar and cur_indent == indent:
                if result is None:
                    result = {}
                if not isinstance(result, dict):
                    raise BuildError(f"{source}: mixed list/map at line {i + end}")
                key, raw = scalar.group("key"), scalar.group("value") or ""
                if raw.strip() in ("|", ">"):
                    # block scalar: joined continuation lines
                    parts = []
                    j = i + 1
                    while j < stop and (not body[j].strip()
                                        or len(body[j]) - len(body[j].lstrip()) > cur_indent):
                        parts.append(body[j].strip())
                        j += 1
                    result[key] = " ".join(p for p in parts if p)
                    i = j
                elif raw.strip() == "":
                    nested, j = parse_block(i + 1, stop, cur_indent + 2)
                    result[key] = nested
                    i = j
                else:
                    result[key] = _parse_scalar(raw)
                    i += 1
                continue
            raise BuildError(f"{source}: cannot parse line {i + end + 1}: {line!r}")
        return result, i

    parsed, _ = parse_block(0, len(body), 0)
    if not isinstance(parsed, dict):
        raise BuildError(f"{source}: frontmatter is not a mapping")
    return parsed


# ------------------------------------------------------------------- loading

def load_dir(subdir: str) -> list[tuple[dict, Path]]:
    directory = CURATED / subdir
    docs = []
    if not directory.is_dir():
        return docs
    for path in sorted(directory.glob("*.md")):
        if path.name.startswith("_"):
            continue
        docs.append((parse_frontmatter(path.read_text(encoding="utf-8"), path), path))
    return docs


def id_type(node_id: str) -> str | None:
    prefix = node_id.split(":", 1)[0]
    return ID_PREFIXES.get(prefix)


def build() -> tuple[dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    projections: dict[str, str] = {}  # zone -> figure region (§20 step 12, §32)

    def add_node(node_id, node_type, title, source, extra=None):
        if node_id is None:
            errors.append(f"{source}: record without id")
            return
        if node_id in nodes:
            errors.append(f"{source}: duplicate id {node_id}")
            return
        if node_type not in NODE_TYPES:
            errors.append(f"{source}: node type {node_type!r} outside §10.1 closed set")
            return
        if id_type(node_id) != node_type:
            errors.append(
                f"{source}: id {node_id!r} prefix does not match type {node_type!r} (§10.1)")
        shape = PART_ID_RE if node_type == "material_part" else NODE_ID_RE
        if not shape.match(node_id):
            errors.append(f"{source}: id {node_id!r} is not the canonical §10.1 shape "
                          f"({'part:material-slug/part-slug' if node_type == 'material_part' else 'prefix:kebab-case-slug'})")
        node = {"id": node_id, "type": node_type, "title": title}
        if extra:
            node.update(extra)
        nodes[node_id] = node

    def add_edge(source_id, target_id, edge_type, origin, **meta):
        edge = {"source": source_id, "target": target_id, "type": edge_type}
        edge.update({k: v for k, v in meta.items() if v is not None})
        edge["_origin"] = str(origin.relative_to(ROOT))
        edges.append(edge)

    def add_concept_edges(owner_id, entries, path):
        # One authored-edge species (§9.3): material parts and body patterns
        # (§32.1) alike; weight is the §14.9 closed scale.
        for ce in entries or []:
            weight = ce.get("weight")
            if weight is not None and weight not in EDGE_WEIGHTS:
                errors.append(f"{path}: weight {weight!r} on {owner_id} -> "
                              f"{ce.get('to')} outside the §14.9 scale")
            role = ce.get("role", "mentions")
            if role not in AUTHORED_ROLES:
                errors.append(f"{path}: role {role!r} on {owner_id} -> "
                              f"{ce.get('to')} is not an authored relationship "
                              f"role (§9.3/§32.1)")
            add_edge(owner_id, ce.get("to"), role, path, weight=weight)

    def add_supports(owner_id, entries, path):
        # §9.14: helper -> receiver; endpoint kinds enforced by ENDPOINT_RULES.
        for helper in entries or []:
            helper_id = helper["id"] if isinstance(helper, dict) else helper
            add_edge(helper_id, owner_id, "supports", path,
                     note=helper.get("note") if isinstance(helper, dict) else None)

    # §20 steps 1-2, 4-5: curated kinds. Zones/patterns dirs are read the same
    # way and are simply empty until the body domain lands (§32).
    for subdir, expected in (
        ("concepts", "concept"), ("zones", "zone"), ("patterns", "pattern"),
        ("materials", "material"), ("directions", "direction"),
        ("suggested-routes", "suggested_route"), ("probes", "probe"),
    ):
        for meta, path in load_dir(subdir):
            declared = meta.get("type", expected)
            if declared != expected and not (subdir == "suggested-routes"
                                             and declared == "suggested_route"):
                errors.append(f"{path}: type {declared!r}, expected {expected!r}")
                continue
            # Authored lifecycle travels with the node: the viewer reads
            # atlas-graph.json and nothing else (§16.4), so a hidden route
            # must be distinguishable from an available one in the output.
            status = meta.get("status")
            if (status is not None and expected != "suggested_route"
                    and status not in LIFECYCLE_STATUSES):
                errors.append(f"{path}: status {status!r} outside the §9.2/§9.11 "
                              f"lifecycle vocabulary (active|archived)")
            extra = {"status": status} if status else None
            add_node(meta.get("id"), expected, meta.get("title", ""), path, extra)
            node_id = meta.get("id")
            if node_id is None:
                continue

            if expected == "concept":
                for rel in meta.get("related_concepts") or []:
                    add_edge(node_id, rel, "related_to", path)

            if expected == "pattern":
                # §32.1: a pattern authors its loads/etc. edges as a part
                # authors concept_edges — same species, same gated weight.
                add_concept_edges(node_id, meta.get("concept_edges"), path)

            if expected == "zone" and meta.get("figure_region"):
                # §20 step 12: the silhouette mapping rides in the graph so
                # the viewer's single input stays single (§16.4).
                projections[node_id] = meta["figure_region"]

            if expected == "probe":
                # §9.11/§20 step 7: a probe targets concepts; the reference
                # loop validates them, the edge is the §10.2 probed_by.
                for concept in meta.get("concepts") or []:
                    add_edge(concept, node_id, "probed_by", path)

            if expected == "material":
                for concept in meta.get("overall_concepts") or []:
                    add_edge(node_id, concept, "overall_concept", path)
                add_supports(node_id, meta.get("supported_by"), path)
                # §20 step 3: expand MaterialPart nodes.
                material_slug = node_id.split(":", 1)[1]
                for part in meta.get("parts") or []:
                    part_id = part.get("id")
                    add_node(part_id, "material_part", part.get("title", ""), path,
                             {"material": node_id})
                    if part_id is None:
                        continue
                    if not part_id.startswith(f"part:{material_slug}/"):
                        errors.append(
                            f"{path}: part id {part_id!r} does not carry its "
                            f"material's slug {material_slug!r} (§10.1)")
                    add_edge(node_id, part_id, "has_part", path)
                    add_concept_edges(part_id, part.get("concept_edges"), path)
                    add_supports(part_id, part.get("supported_by"), path)

            if expected == "direction":
                for concept in meta.get("core_concepts") or []:
                    add_edge(concept, node_id, "part_of_direction", path)

            if expected == "suggested_route":
                status = meta.get("status")
                if status in FORBIDDEN_ROUTE_STATUSES:
                    errors.append(
                        f"{path}: route status {status!r} is a §9.4 forbidden task-state")
                elif status not in ROUTE_STATUSES:
                    errors.append(f"{path}: route status {status!r} outside §9.4 vocabulary")
                for order, step in enumerate(meta.get("steps") or [], 1):
                    add_edge(step, node_id, "step_of_route", path, order=order)
                if meta.get("source_plan"):
                    warnings.append(
                        f"{path}: source_plan {meta['source_plan']!r} kept as metadata "
                        "(plan nodes land with the §12 importer)")

    # §20 step 11: broken curated links are errors; only references to
    # user-deletable records (trail segments, artifacts, encounters, §5.2)
    # may downgrade to warnings — none of those kinds is curated in Phase 1.
    DELETABLE = {"trail_segment", "artifact", "encounter"}
    for edge in edges:
        if edge["type"] not in EDGE_TYPES:
            errors.append(
                f"{edge['_origin']}: edge type {edge['type']!r} outside the §10.2 "
                f"closed set ({edge['source']} -> {edge['target']})")
        rule = ENDPOINT_RULES.get(edge["type"])
        if rule:
            for endpoint, allowed in zip(("source", "target"), rule):
                kind = id_type(edge[endpoint]) if edge[endpoint] else None
                if kind is not None and kind not in allowed:
                    errors.append(
                        f"{edge['_origin']}: {edge['type']} {endpoint} "
                        f"{edge[endpoint]!r} must be {'/'.join(sorted(allowed))}")
        for endpoint in ("source", "target"):
            ref = edge[endpoint]
            if ref in nodes:
                continue
            kind = id_type(ref) if ref else None
            if kind is None:
                errors.append(f"{edge['_origin']}: reference {ref!r} has no §10.1 prefix")
            elif kind in DELETABLE:
                warnings.append(
                    f"{edge['_origin']}: {ref} missing — skipped (deletion is the owner's right)")
            else:
                errors.append(
                    f"{edge['_origin']}: broken curated link {edge['source']} "
                    f"-[{edge['type']}]-> {edge['target']} ({ref} not found)")

    edges = [e for e in edges
             if e["source"] in nodes and e["target"] in nodes]
    for edge in edges:
        edge.pop("_origin", None)

    graph = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nodes": sorted(nodes.values(), key=lambda n: n["id"]),
        "edges": sorted(edges, key=lambda e: (e["source"], e["target"], e["type"])),
        "trails": [],       # §29 Phase 3
        "state": {},        # §29 Phase 3 (fold, §14.5-14.8)
        "influence": {},    # §29 Phase 4 (§9.10)
        "frontier": [],     # §29 Phase 4 (§15)
        "projections": dict(sorted(projections.items())),  # §20 step 12, §32
    }
    return graph, errors, warnings


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    try:
        graph, errors, warnings = build()
    except BuildError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if not check_only:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    print(f"{'checked' if check_only else 'built'}: "
          f"{len(graph['nodes'])} nodes, {len(graph['edges'])} edges"
          + ("" if check_only else f" -> {OUTPUT.relative_to(ROOT)}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
