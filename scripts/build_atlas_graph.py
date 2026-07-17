#!/usr/bin/env python3
"""Build OUTPUT_JSON from CURATED_TREE content (SDD §20, Phase 1).

Phase 1 scope (§29): concept / material / direction / suggested-route parsing,
reference validation, deterministic graph JSON. Journal folding, influence and
frontier are later phases — their §10 keys are emitted empty so the output
shape is final from the first build.

stdlib only (§20): json, os, pathlib, re, time.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
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
# §9.2 material kinds, transcribed verbatim (checked by check-constants).
MATERIAL_KINDS = {"article", "docs", "paper", "book", "repo", "video",
                  "course", "spec", "tutorial", "internal"}

# §32.6/§33.2 sensitivity classes, transcribed verbatim.
SENSITIVITY_CLASSES = {"medical"}

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
        if not isinstance(node_id, str):
            errors.append(f"{source}: id {node_id!r} is not a string (§10.1)")
            return
        if not isinstance(title, str):
            errors.append(
                f"{source}: title {title!r} on {node_id} is not a string")
            title = ""
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
        # Endpoints must be id strings before any membership or prefix
        # check hashes them — malformed curated refs fail closed (§25.8).
        if not (isinstance(source_id, str) and isinstance(target_id, str)):
            errors.append(f"{origin}: {edge_type} endpoint {source_id!r} -> "
                          f"{target_id!r} is not an id (§10.2)")
            return
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
        targets: list[str] = []
        if entries is not None and not isinstance(entries, list):
            errors.append(f"{path}: concept_edges on {owner_id} must be a "
                          f"list of edge mappings (§9.3)")
            return targets
        for ce in entries or []:
            if not isinstance(ce, dict):
                errors.append(f"{path}: concept_edges item {ce!r} on "
                              f"{owner_id} is not an edge mapping (§9.3)")
                continue
            weight = ce.get("weight")
            if weight is not None and (not isinstance(weight, str)
                                       or weight not in EDGE_WEIGHTS):
                errors.append(f"{path}: weight {weight!r} on {owner_id} -> "
                              f"{ce.get('to')} outside the §14.9 scale")
                continue
            role = ce.get("role")
            if not isinstance(role, str) or role not in AUTHORED_ROLES:
                errors.append(f"{path}: role {role!r} on {owner_id} -> "
                              f"{ce.get('to')} is not an authored relationship "
                              f"role (§9.3/§32.1)")
                continue
            add_edge(owner_id, ce.get("to"), role, path, [owner_id], weight=weight)
            if isinstance(ce.get("to"), str):
                targets.append(ce["to"])
        return targets

    def add_supports(owner_id, entries, path):
        # §9.14: helper -> receiver; endpoint kinds enforced by ENDPOINT_RULES.
        # Authored on the receiving side — the receiver is the authoring node.
        if entries is not None and not isinstance(entries, list):
            errors.append(f"{path}: supported_by on {owner_id} must be a "
                          f"list of entries (§9.14)")
            return
        for helper in entries or []:
            if isinstance(helper, dict):
                helper_id = helper.get("id")
                if helper_id is None:
                    errors.append(f"{path}: supported_by entry on {owner_id} "
                                  f"has no id (§9.14)")
                    continue
                note = str_field(helper.get("note"), path,
                                 f"supported_by note on {owner_id}")
            elif isinstance(helper, str):
                helper_id, note = helper, None
            else:
                errors.append(f"{path}: supported_by entry {helper!r} on "
                              f"{owner_id} is not an id or mapping (§9.14)")
                continue
            add_edge(helper_id, owner_id, "supports", path, [owner_id],
                     note=note)

    def id_list(value, origin, field, noun="id"):
        # Curated string lists fail closed (§25.8): a scalar value or a
        # non-string item is a build error, never char iteration or an
        # unhashable ref downstream.
        if value is None:
            return []
        if not isinstance(value, list):
            errors.append(f"{origin}: {field} must be a list of {noun}s")
            return []
        result = []
        for item in value:
            if isinstance(item, str):
                result.append(item)
            else:
                errors.append(
                    f"{origin}: {field} item {item!r} is not a {noun}"
                    if noun != "id" else
                    f"{origin}: {field} item {item!r} is not an id")
        return result

    def str_field(value, origin, field, vocabulary=None):
        # §10.4 string payloads fail closed: a container value or a value
        # outside the field's vocabulary is a build ERROR, never an invalid
        # payload in the emitted node.
        if value is None:
            return None
        if not isinstance(value, str):
            errors.append(f"{origin}: {field} {value!r} is not a string")
            return None
        if vocabulary is not None and value not in vocabulary:
            errors.append(f"{origin}: {field} {value!r} outside the "
                          f"vocabulary {sorted(vocabulary)}")
            return None
        return value

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
            if status is not None and not isinstance(status, str):
                errors.append(f"{path}: status {status!r} is not a string "
                              f"(§9.2/§9.4/§9.11)")
                status = None
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
            sensitivity = str_field(meta.get("sensitivity"), path,
                                    "sensitivity", SENSITIVITY_CLASSES)
            if sensitivity is not None:
                extra["sensitivity"] = sensitivity
            if expected in ("concept", "pattern"):
                # §10.4: aliases embed as an array of strings — gate the
                # authored shape before it reaches the emitted node.
                extra["aliases"] = id_list(meta.get("aliases"), path,
                                           "aliases", noun="string")
            if expected == "zone":
                extra["notes"] = body  # file body: care notes (§32.2)
            if expected == "material":
                kind = meta.get("kind")
                if kind is not None and (not isinstance(kind, str)
                                         or kind not in MATERIAL_KINDS):
                    errors.append(f"{path}: material kind {kind!r} outside "
                                  f"the §9.2 vocabulary")
                extra["kind"] = kind
                extra["url"] = str_field(meta.get("url"), path, "url")
            if expected == "direction":
                extra["attractor"] = str_field(meta.get("attractor"),
                                               path, "attractor")
            if expected in ("suggested_route", "probe"):
                source_plan = str_field(meta.get("source_plan"), path,
                                        "source_plan")
                if source_plan is not None and not (
                        source_plan.startswith("plan:")
                        and NODE_ID_RE.match(source_plan)):
                    errors.append(f"{path}: source_plan {source_plan!r} is "
                                  f"not a plan id (§9.4/§10.4)")
                    source_plan = None
                if source_plan is not None:
                    extra["source_plan"] = source_plan
            if expected == "probe":
                extra["body"] = body  # the check itself (§9.11)
            # §10.4/§25.7: these authored payload fields are required on the
            # emitted node — a missing one fails the build here rather than
            # emitting a graph the boundary validator rejects.
            for field in {"material": ("kind", "url", "status"),
                          "direction": ("attractor", "status"),
                          "probe": ("status",)}.get(expected, ()):
                if meta.get(field) is None:
                    errors.append(
                        f"{path}: {expected} requires {field} (§10.4)")
            extra = {k: v for k, v in extra.items() if v is not None}
            add_node(meta.get("id"), expected, meta.get("title", ""), path,
                     extra or None)
            node_id = meta.get("id")
            if not isinstance(node_id, str):
                continue  # add_node already recorded the shape error

            if expected == "concept":
                for rel in meta.get("related_concepts") or []:
                    add_edge(node_id, rel, "related_to", path, [node_id])

            if expected == "pattern":
                # §32.1: a pattern authors its loads/etc. edges as a part
                # authors concept_edges — same species, same gated weight.
                add_concept_edges(node_id, meta.get("concept_edges"), path)

            if expected == "zone":
                # §20 step 12: the silhouette mapping rides in the graph so
                # the viewer's single input stays single (§16.4); every zone
                # authors its figure_region (§32.1) — a zone the silhouette
                # cannot place never leaves the build.
                figure_region = meta.get("figure_region")
                if figure_region is None:
                    errors.append(
                        f"{path}: zone requires figure_region (§32.1)")
                elif (not isinstance(figure_region, str)
                        or not re.fullmatch(_SLUG, figure_region)):
                    errors.append(f"{path}: figure_region {figure_region!r} "
                                  f"is not a slug (§32.1)")
                else:
                    projections[node_id] = figure_region

            if expected == "probe":
                # §9.11/§20 step 7: a probe targets concepts; the reference
                # loop validates them, the edge is the §10.2 probed_by.
                probe_concepts = id_list(meta.get("concepts"), path,
                                         "concepts")
                for concept in probe_concepts:
                    add_edge(concept, node_id, "probed_by", path, [node_id])
                field_refs[node_id] = probe_concepts

            if expected == "material":
                overall = id_list(meta.get("overall_concepts"), path,
                                  "overall_concepts")
                for concept in overall:
                    add_edge(node_id, concept, "overall_concept", path, [node_id])
                add_supports(node_id, meta.get("supported_by"), path)
                field_refs[node_id] = list(overall)
                # §20 step 3: expand MaterialPart nodes.
                # add_node has already recorded the shape error for a
                # malformed id; don't let the slug derivation crash on it.
                material_slug = node_id.split(":", 1)[1] if ":" in node_id else None
                parts = meta.get("parts")
                if parts is not None and not isinstance(parts, list):
                    errors.append(f"{path}: parts must be a list (§9.3)")
                    parts = []
                for part in parts or []:
                    if not isinstance(part, dict):
                        errors.append(
                            f"{path}: parts item {part!r} is not a "
                            f"MaterialPart mapping (§9.3)")
                        continue
                    part_id = part.get("id")
                    # §10.4/§34.4: formerly travels wherever the id is
                    # persisted — a part rename keeps its redirects.
                    part_extra = {"material": node_id}
                    if part.get("formerly") is not None:
                        part_extra["formerly"] = part["formerly"]
                    add_node(part_id, "material_part", part.get("title", ""),
                             path, part_extra)
                    if not isinstance(part_id, str):
                        continue  # add_node already recorded the shape error
                    if material_slug and not part_id.startswith(f"part:{material_slug}/"):
                        errors.append(
                            f"{path}: part id {part_id!r} does not carry its "
                            f"material's slug {material_slug!r} (§10.1)")
                    add_edge(node_id, part_id, "has_part", path, [node_id])
                    # §10.4: a part's fields come from its concept_edges
                    # targets; the material unions its parts' fields.
                    field_refs[part_id] = add_concept_edges(
                        part_id, part.get("concept_edges"), path)
                    add_supports(part_id, part.get("supported_by"), path)
                    field_refs[node_id].append(part_id)

            if expected == "direction":
                core = id_list(meta.get("core_concepts"), path,
                               "core_concepts")
                for concept in core:
                    add_edge(concept, node_id, "part_of_direction", path, [node_id])
                field_refs[node_id] = list(core)

            if expected == "suggested_route":
                status = meta.get("status")
                if status is not None and not isinstance(status, str):
                    status = None  # the string gate above recorded the error
                if status in FORBIDDEN_ROUTE_STATUSES:
                    errors.append(
                        f"{path}: route status {status!r} is a §9.4 forbidden task-state")
                elif status not in ROUTE_STATUSES:
                    errors.append(f"{path}: route status {status!r} outside §9.4 vocabulary")
                steps = meta.get("steps")
                if steps is not None and not isinstance(steps, list):
                    errors.append(
                        f"{path}: steps must be a list of ids (§9.4)")
                    steps = []
                for item in steps or []:
                    if not isinstance(item, str):
                        errors.append(
                            f"{path}: steps item {item!r} is not an id (§9.4)")
                steps = [s for s in steps or [] if isinstance(s, str)]
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
                roles = meta.get("material_roles")
                if roles is not None and not isinstance(roles, list):
                    errors.append(
                        f"{path}: material_roles must be a list of role "
                        f"mappings (§9.4)")
                    roles = []
                for role in roles or []:
                    if not isinstance(role, dict):
                        errors.append(
                            f"{path}: material_roles item {role!r} is not a "
                            f"role mapping (§9.4)")
                        continue
                    step = role.get("step")
                    if step is not None and not isinstance(step, str):
                        errors.append(
                            f"{path}: material_roles step {step!r} is not "
                            f"an id (§9.4)")
                        continue
                    # Membership and disjointness are checked post-pass on
                    # §34.4-resolved ids — a stale spelling must resolve,
                    # not fail (§34.4).
                    # Fail closed on non-string items before set math and
                    # edge emission — a schema-invalid role list must error,
                    # never traceback or emit a malformed endpoint.
                    def role_ids(key):
                        items = role.get(key)
                        if items is None:
                            return []
                        if not isinstance(items, list):
                            errors.append(
                                f"{path}: material_roles {key} must be a "
                                f"list of material ids (§9.4)")
                            return []
                        ids = []
                        for item in items:
                            if isinstance(item, str):
                                ids.append(item)
                            else:
                                errors.append(
                                    f"{path}: material_roles {key} item "
                                    f"{item!r} is not a material id (§9.4)")
                        return ids

                    primary = role_ids("primary_materials")
                    supporting = role_ids("supporting_materials")
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

    # §34.4: the retired→living map — every retired id lives in exactly one
    # living formerly list, and a retired id that is also living, or present
    # in two lists, is a build error (a 1→n redirect is unrepresentable).
    retired: dict[str, str] = {}
    for node_id in sorted(nodes):
        redirects = nodes[node_id].get("formerly")
        if redirects is not None and not isinstance(redirects, list):
            errors.append(
                f"formerly on {node_id} must be a list of ids (§34.4)")
            continue
        for old in redirects or []:
            if not isinstance(old, str):
                errors.append(
                    f"formerly entry {old!r} on {node_id} is not an id (§34.4)")
                continue
            shape = PART_ID_RE if old.startswith("part:") else NODE_ID_RE
            if id_type(old) is None or not shape.match(old):
                errors.append(
                    f"formerly entry {old!r} on {node_id} is not a canonical "
                    f"§10.1 id (§34.4)")
                continue
            if id_type(old) != nodes[node_id].get("type"):
                errors.append(
                    f"formerly entry {old!r} on {node_id} changes kind — "
                    f"identity continuation is per-kind (§34.4)")
                continue
            if old in nodes:
                errors.append(
                    f"formerly {old} on {node_id} is still a living id (§34.4)")
            survivor = retired.get(old)
            if survivor is not None:
                errors.append(
                    f"retired id {old} redirects to both {survivor} and "
                    f"{node_id} (§34.4)")
            else:
                retired[old] = node_id

    # §34.4: curated refs resolve through the map — stale refs converge on
    # the survivor and are listed in the build report, never failed.
    def resolve_ref(ref, origin):
        survivor = retired.get(ref) if isinstance(ref, str) else None
        if survivor is None:
            return ref
        warnings.append(
            f"{origin}: stale curated ref {ref} resolved to {survivor} (§34.4)")
        return survivor

    for edge in edges:
        for key in ("source", "target", "context", "step"):
            if key in edge:
                edge[key] = resolve_ref(edge[key], edge["_origin"])
        if isinstance(edge.get("provenance"), list):
            edge["provenance"] = sorted(
                resolve_ref(ref, edge["_origin"]) for ref in edge["provenance"])
    for refs in field_refs.values():
        refs[:] = [retired.get(ref, ref) if isinstance(ref, str) else ref
                   for ref in refs]

    # §20.3 (minimal V1 slice): exact-identity duplicates collapse before
    # emission — provenance unions, a weight conflict on one identity is a
    # build ERROR. Symmetric related_to canonicalization and the rest of
    # §20.3 land with PR E1 (#31).
    canonical: dict = {}
    deduped: list[dict] = []
    for edge in edges:
        identity = (edge["type"], edge["source"], edge["target"],
                    edge.get("context"), edge.get("order"), edge.get("step"))
        kept = canonical.get(identity)
        if kept is None:
            canonical[identity] = edge
            deduped.append(edge)
            continue
        if kept.get("weight") != edge.get("weight"):
            # §14.9: unassessed is the no-hypothesis default — a lone
            # authored weight on the identity wins; two different
            # authored weights are the §20.3 conflict.
            authored = ({kept.get("weight"), edge.get("weight")}
                        - {"unassessed"})
            if len(authored) == 1:
                kept["weight"] = authored.pop()
            else:
                errors.append(
                    f"{edge['_origin']}: conflicting weights "
                    f"{kept.get('weight')!r} vs {edge.get('weight')!r} on "
                    f"{edge['type']} {edge['source']} -> {edge['target']} "
                    f"(§20.3)")
                continue
        kept["provenance"] = sorted(
            set(kept["provenance"]) | set(edge["provenance"]))
    edges = deduped


    # §9.4 on §34.4-resolved ids: a role step must be a member of its
    # route's steps, and per (route, step) the two lists stay disjoint —
    # a rename cannot fail a stale spelling or bypass disjointness.
    route_steps = {(edge["target"], edge["source"]) for edge in edges
                   if edge["type"] == "step_of_route"}
    role_seen: dict = {}
    for edge in edges:
        if edge["type"] not in ("primary_for", "supporting_for"):
            continue
        route, step = edge["target"], edge.get("step")
        if not (isinstance(route, str)
                and route.startswith("suggested-route:")):
            continue
        if (route, step) not in route_steps:
            errors.append(
                f"{edge['_origin']}: material_roles step {step!r} is not a "
                f"member of steps (§9.4)")
        key = (route, step, edge["source"])
        previous = role_seen.get(key)
        if previous is not None and previous != edge["type"]:
            errors.append(
                f"{edge['_origin']}: {edge['source']} is both primary and "
                f"supporting for step {step} (§9.4/§20.3)")
        role_seen[key] = edge["type"]

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

    # §20.1: generated_at is the fold's as-of date at UTC midnight, never
    # the wall clock (determinism: same inputs ⇒ byte-identical output).
    # This phase reads no dated records, so the key is absent — consumers
    # must tolerate that (§10).
    graph = {
        "format": "atlas-graph",
        "version": 1,
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
    # §25.6 (#36): the instance is single-writer — every writing flow takes
    # .atlas-lock at the instance root, acquire-if-absent (O_CREAT|O_EXCL),
    # and refuses when it is already held; stale locks are removed by hand.
    lock_fd = None
    # §8/§25.6: the lock lives at the instance root — with the normal
    # layout the curated tree is INSTANCE/atlas, so lock its parent; a
    # bare curated tree (fixtures) is its own root.
    instance_root = curated.parent if curated.name == "atlas" else curated
    lock = instance_root / ".atlas-lock"
    if not check_only:
        try:
            lock_fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            print(f"ERROR: {lock} is already held — the instance is "
                  f"single-writer (§25.6); if its holder crashed, inspect "
                  f"and remove the lock by hand", file=sys.stderr)
            return 1
        os.write(lock_fd, (json.dumps({
            "pid": os.getpid(),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }) + "\n").encode("utf-8"))
    try:
        return _run(curated, output, check_only)
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
            lock.unlink(missing_ok=True)


def _run(curated: Path, output: Path, check_only: bool) -> int:
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
        # §20.2: write a temp file beside the output and atomically rename
        # it into place — a crash or concurrent read never sees a torn
        # graph (§16.4 reads exactly one file).
        tmp = output.with_name(output.name + ".tmp")
        tmp.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        tmp.replace(output)
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
