#!/usr/bin/env python3
"""Build OUTPUT_JSON from CURATED_TREE content (SDD §20, Phase 1).

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

from frontmatter import FrontmatterError, frontmatter_body, parse_frontmatter

ROOT = Path(__file__).resolve().parents[1]

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

# §9.1/§9.3/§32.1 — roles an author may write in concept_edges; the structural
# types (has_part, step_of_route, …) are created by the builder only.
AUTHORED_ROLES = {
    "related_to", "prerequisite_of", "extends", "implements", "contradicts",
    "explains", "demonstrates", "critiques", "mentions", "loads",
}

# §32.1: patterns are concept-kind nodes — a program part maps to patterns
# exactly as a chapter maps to concepts.
CONCEPT_KIND = {"concept", "pattern"}

# §10.2 endpoint-kind contract per emitted edge type (source kinds, target
# kinds), transcribed in full so check-constants can detect either-side drift.
ENDPOINT_RULES = {
    "related_to": (CONCEPT_KIND, CONCEPT_KIND),
    "prerequisite_of": (CONCEPT_KIND | {"material_part"}, CONCEPT_KIND),
    "extends": (CONCEPT_KIND | {"material_part"}, CONCEPT_KIND),
    "implements": ({"material_part"}, CONCEPT_KIND),
    "contradicts": (CONCEPT_KIND | {"material_part"}, CONCEPT_KIND),
    "explains": ({"material_part"}, CONCEPT_KIND),
    "demonstrates": ({"material_part"}, CONCEPT_KIND),
    "critiques": ({"material_part"}, CONCEPT_KIND),
    "mentions": ({"material_part"}, CONCEPT_KIND),
    "loads": ({"pattern"}, {"zone"}),
    "supports": ({"material", "material_part"}, {"material", "material_part"}),
    "has_part": ({"material"}, {"material_part"}),
    "overall_concept": ({"material"}, CONCEPT_KIND),
    "part_of_direction": (CONCEPT_KIND, {"direction"}),
    "step_of_route": (CONCEPT_KIND, {"suggested_route"}),
    "suggested_next": (CONCEPT_KIND, CONCEPT_KIND),
    "probed_by": (CONCEPT_KIND | {"zone"}, {"probe"}),
    "pulled_by": (CONCEPT_KIND | {"zone"}, {"question"}),
    "visited": ({"encounter"}, {"material", "material_part"}),
    "influences": ({"artifact"}, CONCEPT_KIND | {"zone"}),
    "updates_state": ({"artifact"}, CONCEPT_KIND | {"zone"}),
    "moved_to": (CONCEPT_KIND, CONCEPT_KIND),
    "via": ({"trail_segment"}, {"material", "material_part"}),
    "produced_artifact": ({"trail_segment"}, {"artifact"}),
    "primary_for": (
        {"material", "material_part"},
        {"suggested_route", "question", "trail_segment"},
    ),
    "supporting_for": (
        {"material", "material_part"},
        {"suggested_route", "question", "trail_segment"},
    ),
}

# §14.9 — authored edge weight is a closed scale (the import-time hypothesis).
EDGE_WEIGHTS = {"low", "medium", "high"}

# §9.2/§9.11 — lifecycle vocabulary for everything that is not a route.
LIFECYCLE_STATUSES = {"active", "archived"}

# §9.4 — route lifecycle vocabulary; task-state words are §4 leakage.
ROUTE_STATUSES = {"available", "hidden", "partially_followed", "ignored", "archived"}
FORBIDDEN_ROUTE_STATUSES = {"done", "failed", "late", "blocked"}


# ------------------------------------------------------------------- loading

def load_dir(curated: Path, subdir: str) -> list[tuple[dict, str, Path]]:
    directory = curated / subdir
    docs = []
    if not directory.is_dir():
        return docs
    for path in sorted(directory.glob("*.md")):
        if path.name.startswith("_"):
            continue
        data = path.read_bytes()
        docs.append((parse_frontmatter(data, path), frontmatter_body(data), path))
    return docs


def id_type(node_id: str) -> str | None:
    prefix = node_id.split(":", 1)[0]
    return ID_PREFIXES.get(prefix)


def build(curated: Path) -> tuple[dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    projections: dict[str, str] = {}  # zone -> figure region (§20 step 12, §32)
    field_refs: dict[str, list] = {}  # node -> refs its §10.4 fields derive from

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

    def add_edge(source_id, target_id, edge_type, origin, provenance, **meta):
        # §10.3: provenance is required on every edge — the direct derivation
        # basis, sorted; the authored species always carry the §14.9 fold
        # value, unassessed when nothing was authored.
        edge = {"source": source_id, "target": target_id, "type": edge_type,
                "provenance": sorted(provenance)}
        edge.update({k: v for k, v in meta.items() if v is not None})
        if edge_type in AUTHORED_ROLES | {"supports"} and "weight" not in edge:
            edge["weight"] = "unassessed"
        try:
            edge["_origin"] = str(origin.relative_to(ROOT))
        except ValueError:
            edge["_origin"] = str(origin)
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
            add_edge(owner_id, ce.get("to"), role, path, [owner_id], weight=weight)

    def add_supports(owner_id, entries, path):
        # §9.14: helper -> receiver; endpoint kinds enforced by ENDPOINT_RULES.
        # Authored on the receiving side — the receiver is the authoring node.
        for helper in entries or []:
            helper_id = helper["id"] if isinstance(helper, dict) else helper
            add_edge(helper_id, owner_id, "supports", path, [owner_id],
                     note=helper.get("note") if isinstance(helper, dict) else None)

    # §20 steps 1-2, 4-5: curated kinds. Zones/patterns dirs are read the same
    # way and are simply empty until the body domain lands (§32).
    for subdir, expected in (
        ("concepts", "concept"), ("zones", "zone"), ("patterns", "pattern"),
        ("materials", "material"), ("directions", "direction"),
        ("suggested-routes", "suggested_route"), ("probes", "probe"),
    ):
        for meta, body, path in load_dir(curated, subdir):
            declared = meta.get("type", expected)
            if declared != expected and not (subdir == "suggested-routes"
                                             and declared == "suggested_route"):
                errors.append(f"{path}: type {declared!r}, expected {expected!r}")
                continue
            # Authored lifecycle travels with the node: the viewer reads
            # atlas-graph.json and nothing else (§16.4), so a hidden route
            # must be distinguishable from an available one in the output.
            status = meta.get("status")
            if status is not None and expected in ("concept", "zone", "pattern"):
                # §9.1/§32.1: concept-kind files carry identity, links, and
                # content only — every state dimension is derived (§31.8).
                errors.append(f"{path}: {expected} files do not author status "
                              f"(state is derived, §9.1)")
                status = None
            elif (status is not None and expected != "suggested_route"
                    and status not in LIFECYCLE_STATUSES):
                errors.append(f"{path}: status {status!r} outside the §9.2/§9.11 "
                              f"lifecycle vocabulary (active|archived)")
            # §10.4: the per-kind payload embedded beyond id/type/title/fields;
            # formerly and sensitivity travel wherever persisted.
            extra = {"status": status} if status else {}
            if meta.get("formerly") is not None:
                extra["formerly"] = meta["formerly"]
            if meta.get("sensitivity") is not None:
                extra["sensitivity"] = meta["sensitivity"]
            if expected in ("concept", "pattern"):
                extra["aliases"] = meta.get("aliases") or []
            if expected == "zone":
                extra["notes"] = body  # file body: care notes (§32.2)
            if expected == "material":
                extra["kind"] = meta.get("kind")
                extra["url"] = meta.get("url")
            if expected == "direction":
                extra["attractor"] = meta.get("attractor")
            if expected in ("suggested_route", "probe") and meta.get("source_plan"):
                extra["source_plan"] = meta["source_plan"]
            if expected == "probe":
                extra["body"] = body  # the check itself (§9.11)
            extra = {k: v for k, v in extra.items() if v is not None}
            add_node(meta.get("id"), expected, meta.get("title", ""), path,
                     extra or None)
            node_id = meta.get("id")
            if node_id is None:
                continue

            if expected == "concept":
                for rel in meta.get("related_concepts") or []:
                    add_edge(node_id, rel, "related_to", path, [node_id])

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
                    add_edge(concept, node_id, "probed_by", path, [node_id])
                field_refs[node_id] = list(meta.get("concepts") or [])

            if expected == "material":
                for concept in meta.get("overall_concepts") or []:
                    add_edge(node_id, concept, "overall_concept", path, [node_id])
                add_supports(node_id, meta.get("supported_by"), path)
                field_refs[node_id] = list(meta.get("overall_concepts") or [])
                # §20 step 3: expand MaterialPart nodes.
                # add_node has already recorded the shape error for a
                # malformed id; don't let the slug derivation crash on it.
                material_slug = node_id.split(":", 1)[1] if ":" in node_id else None
                for part in meta.get("parts") or []:
                    part_id = part.get("id")
                    add_node(part_id, "material_part", part.get("title", ""), path,
                             {"material": node_id})
                    if part_id is None:
                        continue
                    if material_slug and not part_id.startswith(f"part:{material_slug}/"):
                        errors.append(
                            f"{path}: part id {part_id!r} does not carry its "
                            f"material's slug {material_slug!r} (§10.1)")
                    add_edge(node_id, part_id, "has_part", path, [node_id])
                    add_concept_edges(part_id, part.get("concept_edges"), path)
                    add_supports(part_id, part.get("supported_by"), path)
                    # §10.4: a part's fields come from its concept_edges
                    # targets; the material unions its parts' fields.
                    field_refs[part_id] = [
                        ce.get("to") for ce in part.get("concept_edges") or []
                        if ce.get("to")]
                    field_refs[node_id].append(part_id)

            if expected == "direction":
                for concept in meta.get("core_concepts") or []:
                    add_edge(concept, node_id, "part_of_direction", path, [node_id])
                field_refs[node_id] = list(meta.get("core_concepts") or [])

            if expected == "suggested_route":
                status = meta.get("status")
                if status in FORBIDDEN_ROUTE_STATUSES:
                    errors.append(
                        f"{path}: route status {status!r} is a §9.4 forbidden task-state")
                elif status not in ROUTE_STATUSES:
                    errors.append(f"{path}: route status {status!r} outside §9.4 vocabulary")
                steps = meta.get("steps") or []
                for order, step in enumerate(steps, 1):
                    add_edge(step, node_id, "step_of_route", path, [node_id],
                             order=order)
                # §10.2: consecutive steps of one route derive suggested_next,
                # context = the route id (part of edge identity, §10.3).
                for earlier, later in zip(steps, steps[1:]):
                    add_edge(earlier, later, "suggested_next", path, [node_id],
                             context=node_id)
                field_refs[node_id] = list(steps)
                # §11.1: the authored route context emits material(part) →
                # route edges carrying step metadata; per step the two lists
                # are disjoint (§9.4 — a §20.3 conflict otherwise).
                for role in meta.get("material_roles") or []:
                    if not isinstance(role, dict):
                        continue
                    step = role.get("step")
                    if step not in steps:
                        errors.append(
                            f"{path}: material_roles step {step!r} is not a "
                            f"member of steps (§9.4)")
                        continue
                    primary = role.get("primary_materials") or []
                    supporting = role.get("supporting_materials") or []
                    for shared in sorted(set(primary) & set(supporting)):
                        errors.append(
                            f"{path}: {shared} is both primary and supporting "
                            f"for step {step} (§9.4/§20.3)")
                    for material, role_type in (
                        [(m, "primary_for") for m in primary]
                        + [(m, "supporting_for") for m in supporting]
                    ):
                        add_edge(material, node_id, role_type, path, [node_id],
                                 step=step)
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

    # §10.4: fields = union of the fields of the region nodes reachable
    # through the kind's listed refs; chains bottom out at the §10.1
    # registry (concept → knowledge; zone, pattern → body), so resolution
    # is acyclic. Dangling refs contribute nothing; fields: [] is legal —
    # the viewer flags it, the builder never substitutes.
    REGISTRY_FIELDS = {"concept": {"knowledge"}, "zone": {"body"},
                       "pattern": {"body"}}

    def fields_of(node_id, seen=frozenset()):
        node = nodes.get(node_id)
        if node is None or node_id in seen:
            return set()
        registry = REGISTRY_FIELDS.get(node["type"])
        if registry is not None:
            return registry
        result = set()
        for ref in field_refs.get(node_id, []):
            result |= fields_of(ref, seen | {node_id})
        return result

    for node_id, node in nodes.items():
        node["fields"] = sorted(fields_of(node_id))

    graph = {
        "format": "atlas-graph",
        "version": 1,
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
    args = sys.argv[1:]
    check_only = "--check" in args
    if check_only:
        args.remove("--check")
    if len(args) != 2:
        print(
            f"usage: {Path(sys.argv[0]).name} [--check] CURATED_TREE OUTPUT_JSON",
            file=sys.stderr,
        )
        return 2

    curated = Path(args[0]).resolve()
    output = Path(args[1]).resolve()
    try:
        graph, errors, warnings = build(curated)
    except FrontmatterError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if not check_only:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    try:
        output_display = output.relative_to(ROOT)
    except ValueError:
        output_display = output
    print(f"{'checked' if check_only else 'built'}: "
          f"{len(graph['nodes'])} nodes, {len(graph['edges'])} edges"
          + ("" if check_only else f" -> {output_display}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
