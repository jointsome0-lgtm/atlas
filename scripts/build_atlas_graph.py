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

from atlas_reader import (
    AtlasReader,
    JsonDisciplineError,
    ReaderError,
    ReasonCode,
    strict_json_loads,
)
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

# §10.4: fields = union of the fields of the region nodes reachable through
# the kind's listed refs; chains bottom out at the §10.1 registry (concept →
# knowledge; zone, pattern → body), so resolution is acyclic.
REGISTRY_FIELDS = {"concept": {"knowledge"}, "zone": {"body"},
                   "pattern": {"body"}}
FIELD_DERIVED_KINDS = {"material", "material_part", "suggested_route",
                       "direction", "probe", "question", "artifact",
                       "encounter", "trail_segment", "plan"}
PART_EDGE_ROLES = {"prerequisite_of", "extends", "contradicts", "implements",
                   "explains", "demonstrates", "critiques", "mentions"}


def graph_field_expectations(instance: dict) -> dict[str, list[str]]:
    """§10.4 over an emitted graph: recompute every derived-kind node's
    fields from the instance's own edges and payload-held refs. Shared
    canon — the boundary validator checks emissions against it and
    redaction withholds nodes it strands — so it is hardened for
    arbitrary JSON, not just the builder's own output."""
    def as_list(value):
        return value if isinstance(value, list) else []

    types: dict[str, str | None] = {}
    for node in as_list(instance.get("nodes")):
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            # A non-string type already carries its schema diagnostic —
            # None keeps every set membership below hashable.
            node_type = node.get("type")
            types[node["id"]] = node_type if isinstance(node_type, str) else None
    refs: dict = {}
    for edge in as_list(instance.get("edges")):
        if not isinstance(edge, dict):
            continue
        src, tgt = edge.get("source"), edge.get("target")
        kind = edge.get("type")
        if not (isinstance(src, str) and isinstance(tgt, str)
                and isinstance(kind, str)):
            continue
        if kind in ("overall_concept", "has_part"):
            refs.setdefault(src, []).append(tgt)
        elif (kind in PART_EDGE_ROLES
                and types.get(src) == "material_part"):
            refs.setdefault(src, []).append(tgt)
        elif kind in ("step_of_route", "part_of_direction", "probed_by",
                      "pulled_by"):
            refs.setdefault(tgt, []).append(src)
        elif kind in ("influences", "updates_state", "visited"):
            refs.setdefault(src, []).append(tgt)

    for node in as_list(instance.get("nodes")):
        if not (isinstance(node, dict) and isinstance(node.get("id"), str)):
            continue
        # §10.4 payload-held refs: trail segments derive from ∪ to; a plan
        # derives its routes' fields through their source_plan.
        if (types.get(node["id"]) == "encounter"
                and isinstance(node.get("target"), str)):
            refs.setdefault(node["id"], []).append(node["target"])
        if types.get(node["id"]) == "trail_segment":
            origin = node.get("from")
            origins = origin if isinstance(origin, list) else [origin]
            for ref in origins + [node.get("to")]:
                if isinstance(ref, str):
                    refs.setdefault(node["id"], []).append(ref)
        source_plan = node.get("source_plan")
        if (types.get(node["id"]) == "suggested_route"
                and isinstance(source_plan, str)):
            refs.setdefault(source_plan, []).append(node["id"])

    def fields_of(node_id, seen=frozenset()):
        if node_id in seen:
            return set()
        registry = REGISTRY_FIELDS.get(types.get(node_id))
        if registry is not None:
            return set(registry)
        result = set()
        for ref in refs.get(node_id, []):
            result |= fields_of(ref, seen | {node_id})
        return result

    return {node_id: sorted(fields_of(node_id))
            for node_id, kind in types.items()
            if kind in FIELD_DERIVED_KINDS}

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

# §25.8: journal row byte ceiling — a policy ceiling shared with the
# boundary reader (validate_atlas aliases this constant).
JOURNAL_ROW_BYTES = 16_384
_JOURNAL_READ_BYTES = 8_192

# §8: at least one domain directory distinguishes the curated tree from a
# missing or mis-mounted instance path.
CURATED_SUBDIRECTORIES = (
    "concepts", "materials", "zones", "patterns", "directions",
    "suggested-routes", "trails", "probes",
)

# §9.6/§9.7/§9.8 (§25.7): the journal schemas close their key sets
# (additionalProperties: false) — a typo key must fail here too, never
# be silently ignored (a misspelled sensitivity drops a privacy marking).
JOURNAL_ROW_KEYS = {
    "artifacts": {"id", "type", "path", "observed_at", "summary", "touches",
                  "supports_state_updates", "evidence_strength", "probe",
                  "sensitivity", "intake"},
    "encounters": {"id", "date", "target", "depth", "mode", "context",
                   "sensitivity", "intake"},
    "questions": {"id", "type", "text", "created_at", "pulls", "source",
                  "sensitivity", "intake"},
}

# §9.6/§9.8: touches, supports_state_updates and pulls hold region ids —
# the journal schemas pin regionId to these three kinds.
REGION_PREFIXES = {"concept", "pattern", "zone"}

# §33.2 (§25.7): the optional intake provenance key — batch/entry#row.
INTAKE_KEY_RE = re.compile(rf"^{_SLUG}/{_SLUG}#[0-9]+$")

# §9.2/§9.11 — lifecycle vocabulary for everything that is not a route.
LIFECYCLE_STATUSES = {"active", "archived"}
# §9.2 material kinds, transcribed verbatim (checked by check-constants).
MATERIAL_KINDS = {"article", "docs", "paper", "book", "repo", "video",
                  "course", "spec", "tutorial", "internal"}

# §32.6/§33.2 sensitivity classes, transcribed verbatim.
SENSITIVITY_CLASSES = {"medical"}

# §9.7 — encounter scales, transcribed verbatim.
ENCOUNTER_DEPTHS = {"skim", "read", "summarized", "applied", "taught"}
ENCOUNTER_MODES = {"plan-driven", "question-driven", "artifact-driven",
                   "background"}
# §11.2 — deep use folds a question-context material primary.
DEEP_USE_DEPTHS = {"applied", "taught"}
# §9.6 — artifact evidence strengths, transcribed verbatim.
EVIDENCE_STRENGTHS = {"noticed", "read", "summarized", "applied",
                      "explained", "reviewed", "performed", "drilled"}

# §9.4 — route lifecycle vocabulary; task-state words are §4 leakage.
ROUTE_STATUSES = {"available", "hidden", "partially_followed", "ignored", "archived"}
FORBIDDEN_ROUTE_STATUSES = {"done", "failed", "late", "blocked"}


# ------------------------------------------------------------------- loading

def load_dir(
    reader: AtlasReader, curated_prefix: Path, subdir: str
) -> list[tuple[dict, str, Path]]:
    docs = []
    for source in reader.scan(curated_prefix / subdir, suffix=".md"):
        path = source.path
        if path.name.startswith("_"):
            continue
        data = source.read_bytes()
        docs.append((parse_frontmatter(data, path), frontmatter_body(data), path))
    return docs


def id_type(node_id: str) -> str | None:
    prefix = node_id.split(":", 1)[0]
    return ID_PREFIXES.get(prefix)


def build(curated: Path, as_of: str | None = None) -> tuple[
        dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        reader = AtlasReader(curated.parent if curated.name == "atlas" else curated)
        curated_prefix = Path("atlas") if curated.name == "atlas" else Path()
        if curated.name == "atlas" and not reader.is_directory(curated_prefix):
            raise ReaderError(ReasonCode.INVALID_ROOT)
    except ReaderError as exc:
        reader = None
        curated_prefix = Path()
        errors.append(str(exc))
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    projections: dict[str, str] = {}  # zone -> figure region (§20 step 12, §32)
    field_refs: dict[str, list] = {}  # node -> refs its §10.4 fields derive from
    segments: list = []  # (id, origins, via, path) — §9.9/§11.3 derivation
    artifact_touches: dict = {}  # artifact id -> touched region ids (§9.9)
    question_records: dict = {}  # question id -> (source object, pulls)
    encounter_records: list = []  # (id, target, depth, ctx question/artifact, origin)
    activity_dates: list = []  # §20.1 — the dated-input universe
    skipped_dated_inputs = 0

    date_shape = re.compile(r"^\d{4}-\d{2}-\d{2}$")

    def note_activity(value):
        # §20.1: the default as-of is the max activity date across journal
        # rows and trail segments; malformed dates never anchor a graph.
        if isinstance(value, str) and date_shape.fullmatch(value):
            activity_dates.append(value)

    def skip_after_as_of(value):
        # §20.1: an explicit as-of is an inclusive upper bound over every
        # dated input; a skipped input contributes no nodes or derived edges.
        nonlocal skipped_dated_inputs
        if as_of is not None and value is not None and value > as_of:
            skipped_dated_inputs += 1
            return True
        return False

    def kinded_ref(value, origin, field, prefixes, cite):
        # §25.8: a payload ref embeds only in its contract kind and full
        # §10.1 shape — a wrong-kind or bare-prefix ref fails the build
        # here, never as a graph the boundary rejects after exit 0.
        value = str_field(value, origin, field)
        if value is None:
            return None
        prefix = value.split(":", 1)[0]
        shape = PART_ID_RE if prefix == "part" else NODE_ID_RE
        if prefix not in prefixes or not shape.fullmatch(value):
            errors.append(f"{origin}: {field} {value!r} is not a "
                          f"{'/'.join(sorted(prefixes))} id ({cite})")
            return None
        return value

    def date_field(value, origin, field):
        # §9/§10: dated payloads are YYYY-MM-DD — a malformed date fails
        # the build closed instead of emitting a schema-invalid graph or
        # silently dropping the row from the §20.1 as-of universe.
        value = str_field(value, origin, field)
        if value is None:
            return None
        if not date_shape.fullmatch(value):
            errors.append(f"{origin}: {field} {value!r} is not a "
                          f"YYYY-MM-DD date (§9/§10)")
            return None
        return value

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
        node = {"id": node_id, "type": node_type, "title": title,
                "_origin": str(source)}
        if extra:
            node.update(extra)
        nodes[node_id] = node

    def add_edge(source_id, target_id, edge_type, origin, provenance,
                 lenient=False, **meta):
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
        if lenient:
            # §20 step 11 origin rule: a journal- or segment-derived edge
            # downgrades broken refs and off-matrix kinds to warnings —
            # deletion is the owner's right (§5.2, §34.2).
            edge["_lenient"] = True
        try:
            edge["_origin"] = str(origin.relative_to(ROOT))
        except (AttributeError, ValueError):
            edge["_origin"] = str(origin)
        edges.append(edge)

    def add_concept_edges(owner_id, owner_kind, entries, path):
        # One authored-edge species (§9.1/§9.3/§32.1): concepts, material
        # parts, and body patterns alike; weight is the §14.9 closed scale.
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
            # §10.2 (#31): role legality is per author kind — the matrix is
            # normative, ENDPOINT_RULES transcribes it.
            if owner_kind not in ENDPOINT_RULES[role][0]:
                errors.append(f"{path}: role {role} on {owner_id} -> "
                              f"{ce.get('to')} is not authorable from a "
                              f"{owner_kind} source (§10.2)")
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
        ("suggested-routes", "suggested_route"), ("trails", "trail_segment"),
        ("probes", "probe"),
    ):
        try:
            documents = (
                load_dir(reader, curated_prefix, subdir)
                if reader is not None else []
            )
        except ReaderError as exc:
            errors.append(str(exc))
            documents = []
        for meta, body, path in documents:
            segment_date = None
            if expected == "trail_segment":
                # §20.1: read and validate the segment date first; a segment
                # beyond an explicit cut is skipped whole before other fields.
                segment_date = date_field(meta.get("date"), path, "date")
                if skip_after_as_of(segment_date):
                    continue
                note_activity(segment_date)
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
            if status is not None and expected in ("concept", "zone",
                                                   "pattern", "trail_segment"):
                # §9.1/§32.1: concept-kind files carry identity, links, and
                # content only — every state dimension is derived (§31.8);
                # §10.4 embeds no lifecycle on a trail segment either.
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
                if expected == "trail_segment":
                    # §34.4: journal record ids get no redirect machinery —
                    # hand-editing the row is the owner's mechanism (§5.2).
                    errors.append(f"{path}: trail segment records get no "
                                  f"formerly redirect (§34.4)")
                else:
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
            if expected == "trail_segment":
                # §9.9 (#31): the record payload and its typed edges are two
                # faces of one record (§10.4) — embed the row verbatim.
                origin_ref = meta.get("from")
                if isinstance(origin_ref, list):
                    raw_origins = id_list(origin_ref, path, "from")
                elif origin_ref is None or isinstance(origin_ref, str):
                    raw_origins = [origin_ref] if origin_ref else []
                else:
                    errors.append(f"{path}: from {origin_ref!r} is not an id "
                                  f"or list of ids (§9.9)")
                    origin_ref, raw_origins = None, []
                # §9.9: movement origins are concept-kind ids.
                trail_origins = [
                    ref for ref in (
                        kinded_ref(ref, path, "from",
                                   {"concept", "pattern"}, "§9.9")
                        for ref in raw_origins)
                    if ref is not None]
                # §9.9/§10.4: via holds material(part) and artifact ids
                # only — an off-kind or malformed id must fail before it
                # is embedded, not merely lose its derived edge in the
                # lenient pass.
                trail_via = [
                    ref for ref in (
                        kinded_ref(ref, path, "via",
                                   {"material", "part", "artifact"},
                                   "§9.9/§10.4")
                        for ref in id_list(meta.get("via"), path, "via"))
                    if ref is not None]
                extra["date"] = segment_date
                extra["direction"] = kinded_ref(meta.get("direction"), path,
                                                "direction", {"direction"},
                                                "§9.9/§10.4")
                extra["to"] = kinded_ref(meta.get("to"), path, "to",
                                         {"concept", "pattern"},
                                         "§9.9/§10.4")
                extra["via"] = trail_via
                extra["reason"] = str_field(meta.get("reason"), path,
                                            "reason")
                if isinstance(origin_ref, str) and trail_origins:
                    extra["from"] = origin_ref
                elif isinstance(origin_ref, list):
                    extra["from"] = trail_origins
                if meta.get("resulting_questions") is not None:
                    extra["resulting_questions"] = [
                        ref for ref in (
                            kinded_ref(ref, path, "resulting_questions",
                                       {"question"}, "§9.9/§10.4")
                            for ref in id_list(
                                meta.get("resulting_questions"), path,
                                "resulting_questions"))
                        if ref is not None]
            # §10.4/§25.7: these authored payload fields are required on the
            # emitted node — a missing one fails the build here rather than
            # emitting a graph the boundary validator rejects.
            for field in {"material": ("kind", "url", "status"),
                          "direction": ("attractor", "status"),
                          "trail_segment": ("date", "direction", "to", "via",
                                            "reason"),
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
                # §9.1 (#31): concepts are the authored species' third
                # author; related_concepts stays sugar for role: related_to
                # with no weight.
                add_concept_edges(node_id, "concept",
                                  meta.get("concept_edges"), path)
                for rel in id_list(meta.get("related_concepts"), path,
                                   "related_concepts"):
                    add_edge(node_id, rel, "related_to", path, [node_id])

            if expected == "pattern":
                # §32.1: a pattern authors its loads/etc. edges as a part
                # authors concept_edges — same species, same gated weight.
                add_concept_edges(node_id, "pattern",
                                  meta.get("concept_edges"), path)

            if expected == "trail_segment":
                # §10.2: one moved_to per from-origin -> to; material(part)
                # via entries derive via, artifact entries produced_artifact.
                # Segment-derived edges are lenient — deletion elsewhere
                # downgrades them, never fails the trail (§5.2, §34.2).
                destination = extra.get("to")
                if isinstance(destination, str):
                    for origin_id in trail_origins:
                        add_edge(origin_id, destination, "moved_to", path,
                                 [node_id], lenient=True)
                for ref in trail_via:
                    edge_kind = ("produced_artifact"
                                 if ref.startswith("artifact:") else "via")
                    add_edge(node_id, ref, edge_kind, path, [node_id],
                             lenient=True)
                field_refs[node_id] = trail_origins + (
                    [destination] if isinstance(destination, str) else [])
                segments.append((node_id, trail_origins, trail_via,
                                 path))

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
                    if sensitivity is not None:
                        # §32.6: taint is union by provenance — the part
                        # is derived from this classed curated file, so
                        # it carries the class (and everything citing it
                        # unions through the node, via included).
                        part_extra["sensitivity"] = sensitivity
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
                        part_id, "material_part", part.get("concept_edges"),
                        path)
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
                        f"{path}: source_plan {meta['source_plan']!r} embedded; "
                        "plan nodes are not emitted until the §12 importer lands, "
                        "so the ref dangles in this build (§20 step 5)")

    # §20 step 8 (#31): the structural journal projection — artifact,
    # encounter, and question rows become nodes plus their §10.2 derived
    # edges. State folds and influence/frontier (§20 steps 9-10) stay
    # §29 Phase 3/4; every projected row obeys §20.1's as-of bound.
    def strict_row(raw):
        # §25.7/§25.8: the journal is a persisted format — the builder
        # reads it exactly as strictly as the boundary (validate_atlas),
        # or its output can embed rows the boundary reader rejects
        # (duplicate keys keep-last, non-finite constants).
        return strict_json_loads(raw.decode("utf-8"))

    def journal_rows(stem, date_key):
        if reader is None:
            return
        paths = []
        try:
            direct = reader.optional_file(Path("state") / f"{stem}.jsonl")
            if direct is not None:
                paths.append(direct)
            # §8: per-year rotation concatenates lexicographically (§20.1).
            paths.extend(reader.scan(Path("state") / stem, suffix=".jsonl"))
        except ReaderError as exc:
            errors.append(str(exc))
            return
        # §20.1: the rotated files' lexicographic concatenation IS the
        # journal — duplicate detection spans it, not each file.
        seen_rows: set = set()
        for path in paths:
            try:
                for number, raw, oversized in _journal_lines(path):
                    if oversized:
                        # §25.8: the boundary reader enforces the same ceiling
                        # — an oversize row must never project.
                        errors.append(f"{path}:{number}: journal row exceeds "
                                      f"{JOURNAL_ROW_BYTES} bytes")
                        continue
                    if not raw:
                        errors.append(f"{path}:{number}: blank journal row")
                        continue
                    if raw in seen_rows:
                        # §20.1: a byte-identical row repeated within a journal
                        # folds once, with a WARNING.
                        warnings.append(f"{path}:{number}: byte-identical "
                                        "duplicate row folded once (§20.1)")
                        continue
                    seen_rows.add(raw)
                    if b"\r" in raw:
                        # §25.7: LF-only, same as the boundary reader.
                        errors.append(f"{path}:{number}: CR/CRLF is "
                                      "unsupported; use LF")
                        continue
                    try:
                        row = strict_row(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        errors.append(f"{path}:{number}: invalid JSONL row")
                        continue
                    except JsonDisciplineError as exc:
                        errors.append(f"{path}:{number}: {exc}")
                        continue
                    if not isinstance(row, dict):
                        errors.append(f"{path}:{number}: journal row is not an "
                                      "object")
                        continue
                    origin = f"{path}:{number}"
                    # §20.1: the dated field is the first row field read. A row
                    # beyond an explicit cut is skipped whole, without unrelated
                    # schema diagnostics or any projection.
                    row_date = date_field(row.get(date_key), origin, date_key)
                    if skip_after_as_of(row_date):
                        continue
                    nulls = sorted(k for k, v in row.items() if v is None)
                    if nulls:
                        # §25.7: no journal schema admits null anywhere — an
                        # explicit null must fail closed, never collapse to
                        # an absent optional field.
                        errors.append(f"{path}:{number}: null journal "
                                      f"value(s) for {', '.join(nulls)} "
                                      "(§25.7)")
                        continue
                    intake = row.get("intake")
                    if intake is not None and (
                            not isinstance(intake, str)
                            or not INTAKE_KEY_RE.fullmatch(intake)):
                        # §25.7: a present-but-malformed intake provenance
                        # fails closed like every other schema-shaped field.
                        errors.append(f"{path}:{number}: intake {intake!r} is "
                                      "not an intake key (§33.2)")
                        continue
                    unknown = set(row) - JOURNAL_ROW_KEYS[stem]
                    if unknown:
                        # The schema closes the key set — an unknown key is a
                        # malformed row, never silently ignored content.
                        errors.append(
                            f"{path}:{number}: unknown journal key(s) "
                            f"{', '.join(sorted(unknown))} (§25.7)")
                        continue
                    note_activity(row_date)
                    yield origin, row, row_date
            except ReaderError as exc:
                errors.append(str(exc))

    for origin, row, row_date in journal_rows("artifacts", "observed_at"):
        # §9.6/§10.4: the authored type: embeds as kind (type is §10.1's).
        touches = [
            ref for ref in (
                kinded_ref(ref, origin, "touches", REGION_PREFIXES, "§9.6")
                for ref in id_list(row.get("touches"), origin, "touches"))
            if ref is not None]
        supports_updates = [
            ref for ref in (
                kinded_ref(ref, origin, "supports_state_updates",
                           REGION_PREFIXES, "§9.6")
                for ref in id_list(row.get("supports_state_updates"), origin,
                                   "supports_state_updates"))
            if ref is not None]
        extra = {
            "kind": str_field(row.get("type"), origin, "type"),
            "path": str_field(row.get("path"), origin, "path"),
            "observed_at": row_date,
            "summary": str_field(row.get("summary"), origin, "summary"),
            "evidence_strength": str_field(row.get("evidence_strength"),
                                           origin, "evidence_strength",
                                           EVIDENCE_STRENGTHS),
            "probe": kinded_ref(row.get("probe"), origin, "probe",
                                {"probe"}, "§9.6/§10.4"),
            "sensitivity": str_field(row.get("sensitivity"), origin,
                                     "sensitivity", SENSITIVITY_CLASSES),
        }
        for field in ("kind", "path", "observed_at", "summary",
                      "evidence_strength"):
            if row.get("type" if field == "kind" else field) is None:
                errors.append(f"{origin}: artifact row requires "
                              f"{'type' if field == 'kind' else field} "
                              "(§9.6/§10.4)")
        add_node(row.get("id"), "artifact", "", origin,
                 {k: v for k, v in extra.items() if v is not None})
        aid = row.get("id")
        if not isinstance(aid, str):
            continue
        for field in ("touches", "supports_state_updates"):
            # §9.6: both relation arrays are required on every evidence
            # row — an absent one is a malformed row, never an artifact
            # silently projected as touching nothing.
            if row.get(field) is None:
                errors.append(f"{origin}: artifact row requires {field} "
                              "(§9.6)")
        artifact_touches[aid] = set(touches)
        for target in touches:
            add_edge(aid, target, "influences", origin, [aid], lenient=True)
        for target in supports_updates:
            add_edge(aid, target, "updates_state", origin, [aid],
                     lenient=True)
        field_refs[aid] = touches + supports_updates

    for origin, row, row_date in journal_rows("encounters", "date"):
        # §9.7/§10.4: the journal row embeds whole — date, target, depth,
        # mode, context — and derives the visited edge.
        context = row.get("context")
        if context is not None and (
                not isinstance(context, dict) or not context
                or any(key not in ("question", "artifact")
                       or not isinstance(value, str)
                       or value.split(":", 1)[0] != key
                       or not NODE_ID_RE.fullmatch(value)
                       for key, value in context.items())):
            # Fail closed (§25.8): a malformed context silently dropped
            # would silently change the §11.2 derivation.
            errors.append(f"{origin}: context {context!r} is not a §9.7 "
                          "context object")
            context = None
        extra = {
            "date": row_date,
            "target": kinded_ref(row.get("target"), origin, "target",
                                 {"material", "part"}, "§9.7/§10.4"),
            "depth": str_field(row.get("depth"), origin, "depth",
                               ENCOUNTER_DEPTHS),
            "mode": str_field(row.get("mode"), origin, "mode",
                              ENCOUNTER_MODES),
            "context": context,
            "sensitivity": str_field(row.get("sensitivity"), origin,
                                     "sensitivity", SENSITIVITY_CLASSES),
        }
        for field in ("date", "target", "depth", "mode"):
            if row.get(field) is None:
                errors.append(f"{origin}: encounter row requires {field} "
                              "(§9.7/§10.4)")
        add_node(row.get("id"), "encounter", "", origin,
                 {k: v for k, v in extra.items() if v is not None})
        eid = row.get("id")
        if not isinstance(eid, str):
            continue
        if isinstance(extra["target"], str):
            add_edge(eid, extra["target"], "visited", origin, [eid],
                     lenient=True)
            field_refs[eid] = [extra["target"]]
        encounter_records.append(
            (eid, extra["target"], extra["depth"],
             (context or {}).get("question"), (context or {}).get("artifact"),
             origin))

    for origin, row, row_date in journal_rows("questions", "created_at"):
        # §9.8/§10.4: text, created_at, source embed; pulls derive the
        # pulled_by edges; status is derived, never stored (§31.8).
        pulls = [
            ref for ref in (
                kinded_ref(ref, origin, "pulls", REGION_PREFIXES, "§9.8")
                for ref in id_list(row.get("pulls"), origin, "pulls"))
            if ref is not None]
        source_ref = row.get("source")
        if source_ref is not None and (
                not isinstance(source_ref, dict) or not source_ref
                or any(key not in ("artifact", "encounter")
                       or not isinstance(value, str)
                       or value.split(":", 1)[0] != key
                       or not NODE_ID_RE.fullmatch(value)
                       for key, value in source_ref.items())):
            # Fail closed (§25.8): a present-but-malformed source must be
            # a build error, never a question node emitted without its
            # §10.4-required provenance.
            errors.append(f"{origin}: source {source_ref!r} is not a §9.8 "
                          "source object")
            source_ref = None
        extra = {
            "text": str_field(row.get("text"), origin, "text"),
            "created_at": row_date,
            "source": source_ref,
            "sensitivity": str_field(row.get("sensitivity"), origin,
                                     "sensitivity", SENSITIVITY_CLASSES),
        }
        for field in ("text", "created_at", "source"):
            if row.get(field) is None:
                errors.append(f"{origin}: question row requires {field} "
                              "(§9.8/§10.4)")
        if row.get("pulls") is None:
            # §9.8: pulls is required — a question that pulls nothing is a
            # malformed row, not an empty-field node.
            errors.append(f"{origin}: question row requires pulls (§9.8)")
        if row.get("type") != "question":
            # §9.8: type is the schema's fixed discriminant — an off-type
            # row must never project as a question node.
            errors.append(f"{origin}: question row requires "
                          "type \"question\" (§9.8)")
        add_node(row.get("id"), "question", "", origin,
                 {k: v for k, v in extra.items() if v is not None})
        qid = row.get("id")
        if not isinstance(qid, str):
            continue
        question_records[qid] = (source_ref or {}, pulls)
        for region in pulls:
            add_edge(region, qid, "pulled_by", origin, [qid], lenient=True)
        field_refs[qid] = pulls

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

    # Journal payload refs resolve like edge refs: the embedded row and its
    # typed edges are two faces of one record (§10.4) — §34.4 resolution
    # must not fork them.
    def quietly(ref):
        return retired.get(ref, ref) if isinstance(ref, str) else ref

    def warn_dangling(ref, origin):
        # §20 step 11: a payload-only journal ref that survived a deletion
        # dangles with a warning, never fails retained history (§34.2).
        if isinstance(ref, str) and ref not in nodes:
            warnings.append(f"{origin}: {ref} missing — kept dangling "
                            "(deletion is the owner's right)")

    for node in nodes.values():
        origin = node.get("_origin", node["id"])
        if node["type"] == "encounter":
            if isinstance(node.get("target"), str):
                node["target"] = resolve_ref(node["target"], origin)
            if isinstance(node.get("context"), dict):
                node["context"] = {key: resolve_ref(value, origin)
                                   for key, value in node["context"].items()}
                for value in node["context"].values():
                    warn_dangling(value, origin)
        if node["type"] == "trail_segment":
            for key in ("to", "from", "direction"):
                if isinstance(node.get(key), str):
                    node[key] = resolve_ref(node[key], origin)
            for key in ("from", "via", "resulting_questions"):
                if isinstance(node.get(key), list):
                    node[key] = [resolve_ref(ref, origin)
                                 for ref in node[key]]
            # direction and resulting_questions are payload-only (no
            # derived edge carries them), so their resolution is checked
            # here — a dangling ref in retained history warns, never
            # fails (§34.2, §20 step 11).
            warn_dangling(node.get("direction"), origin)
            for ref in node.get("resulting_questions") or []:
                warn_dangling(ref, origin)
            if not node.get("from"):
                # With no origin — from absent or the []-landing (§9.9)
                # — no moved_to edge carries to: the destination is
                # payload-only here and its dangle must be reported like
                # the fields above (§20 step 11).
                warn_dangling(node.get("to"), origin)
        if node["type"] == "artifact" and isinstance(node.get("probe"), str):
            node["probe"] = resolve_ref(node["probe"], origin)
            warn_dangling(node["probe"], origin)
        if node["type"] == "question" and isinstance(node.get("source"), dict):
            node["source"] = {key: resolve_ref(value, origin)
                              for key, value in node["source"].items()}
            for value in node["source"].values():
                warn_dangling(value, origin)

    # §11.2 (#31): question roles derive from encounters citing the question
    # — the target folds primary when any citing encounter is deep use
    # (applied|taught), else supporting; nothing is stored (§31.8), and
    # provenance lists every deriving encounter (§10.3).
    question_citing: dict = {}
    for eid, target, depth, ctx_question, _ctx_artifact, origin in (
            encounter_records):
        target, ctx_question = quietly(target), quietly(ctx_question)
        if isinstance(ctx_question, str) and isinstance(target, str):
            question_citing.setdefault((target, ctx_question), []).append(
                (eid, depth, origin))
    for (material, question), citing in sorted(question_citing.items()):
        role = ("primary_for"
                if any(depth in DEEP_USE_DEPTHS for _, depth, _ in citing)
                else "supporting_for")
        add_edge(material, question, role, citing[0][2],
                 sorted({eid for eid, _, _ in citing}), lenient=True)

    # §11.3 (#31): a material cited in a segment's via is primary for the
    # segment — the movement went through it; the target of an encounter
    # citing one of the segment's via artifacts, not itself in via, is
    # supporting. Provenance lists the segment, and for the supporting
    # join the deriving encounters too (§10.3).
    for seg_id, seg_origins, seg_via, origin in segments:
        seg_via = [quietly(ref) for ref in seg_via]
        via_materials = {ref for ref in seg_via
                         if not ref.startswith("artifact:")}
        via_artifacts = {ref for ref in seg_via
                         if ref.startswith("artifact:")}

        # §9.9/§13.2 step 9: every listed origin must be evidenced by the
        # segment's own context — co-touched in a via artifact, or the
        # concept whose question the artifact answers. An unevidenced
        # origin is a proposed correction, never a build failure (§5.2),
        # and deleted evidence rows keep history quiet (§34.2).
        emitted_via_artifacts = {aid for aid in via_artifacts
                                 if aid in artifact_touches}
        if emitted_via_artifacts == via_artifacts:
            evidenced: set = set()
            for aid in sorted(emitted_via_artifacts):
                evidenced |= {quietly(ref)
                              for ref in artifact_touches[aid]}
                for _qid, (source_ref, pulls) in question_records.items():
                    if quietly(source_ref.get("artifact")) == aid:
                        evidenced |= {quietly(ref) for ref in pulls}
            for raw in seg_origins:
                if quietly(raw) not in evidenced:
                    warnings.append(
                        f"{origin}: from {raw} is not evidenced by the "
                        "segment's own via context (§9.9/§13.2 step 9)")
        for material in sorted(via_materials):
            add_edge(material, seg_id, "primary_for", origin, [seg_id],
                     lenient=True)
        supporting: dict = {}
        for eid, target, _depth, _ctx_q, ctx_artifact, _enc_origin in (
                encounter_records):
            target = quietly(target)
            if (isinstance(target, str)
                    and quietly(ctx_artifact) in via_artifacts
                    and target not in via_materials):
                supporting.setdefault(target, set()).add(eid)
        for material in sorted(supporting):
            add_edge(material, seg_id, "supporting_for", origin,
                     [seg_id] + sorted(supporting[material]), lenient=True)

    # §20 step 12 / §32.6: a trail segment with classed via is emitted with
    # the class — the union reads the resolved refs.
    for node in nodes.values():
        if node["type"] == "trail_segment" and "sensitivity" not in node:
            for ref in node.get("via") or []:
                marked = (nodes.get(ref, {}).get("sensitivity")
                          if isinstance(ref, str) else None)
                if marked:
                    node["sensitivity"] = marked
                    break

    # §20.3 normalization: related_to is the one symmetric type — endpoints
    # sort lexicographically before anything else sees the edge, so
    # two-sided authoring becomes one identity (provenance unions in the
    # collapse below). Sorted after §34.4 resolution: renames re-sort.
    for edge in edges:
        if (edge["type"] == "related_to"
                and isinstance(edge.get("source"), str)
                and isinstance(edge.get("target"), str)
                and edge["target"] < edge["source"]):
            edge["source"], edge["target"] = edge["target"], edge["source"]

    # §20.3 dedup: one identity emits one edge — provenance unions, a
    # weight conflict on one identity is a build ERROR.
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

    # §20.3 cycles: a prerequisite_of cycle is a WARNING carrying the cycle
    # path — usually a too-coarse concept cut, never a build failure and
    # never a dependency alarm (§15.3, §25.4). supports cycles are normal
    # (§9.14); no other type is checked. Iterative DFS, sorted order, so
    # the report is deterministic and deep chains cannot overflow.
    prereq: dict = {}
    for edge in edges:
        if (edge["type"] == "prerequisite_of"
                and isinstance(edge.get("source"), str)
                and isinstance(edge.get("target"), str)):
            prereq.setdefault(edge["source"], set()).add(edge["target"])
    color: dict = {}  # 1 = on the current path, 2 = done
    for start in sorted(prereq):
        if color.get(start):
            continue
        path_stack = [start]
        iters = [iter(sorted(prereq.get(start, ())))]
        color[start] = 1
        while iters:
            nxt = next(iters[-1], None)
            if nxt is None:
                color[path_stack.pop()] = 2
                iters.pop()
                continue
            mark = color.get(nxt)
            if mark == 1:
                cycle = path_stack[path_stack.index(nxt):] + [nxt]
                warnings.append(
                    "prerequisite_of cycle (usually a too-coarse concept "
                    "cut, §20.3): " + " -> ".join(cycle))
            elif mark is None:
                color[nxt] = 1
                path_stack.append(nxt)
                iters.append(iter(sorted(prereq.get(nxt, ()))))

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

    # §20 step 11: a broken reference classifies by the ref's ORIGIN — a
    # journal- or segment-derived edge (lenient) downgrades to a warning
    # and is skipped, whatever it targets (§5.2, §34.2); a ref authored in
    # living curation is an error, unless it targets a user-deletable
    # record kind (trail segments, artifacts, encounters).
    DELETABLE = {"trail_segment", "artifact", "encounter"}
    dropped: set = set()
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
                    if edge.get("_lenient"):
                        # §20.3: a journal-derived edge whose ref resolves
                        # outside the matrix row is skipped with a warning.
                        warnings.append(
                            f"{edge['_origin']}: {edge['type']} {endpoint} "
                            f"{edge[endpoint]!r} outside the §10.2 row — "
                            "skipped")
                        dropped.add(id(edge))
                    else:
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
            elif edge.get("_lenient") or kind in DELETABLE:
                warnings.append(
                    f"{edge['_origin']}: {ref} missing — skipped (deletion is the owner's right)")
            else:
                errors.append(
                    f"{edge['_origin']}: broken curated link {edge['source']} "
                    f"-[{edge['type']}]-> {edge['target']} ({ref} not found)")

    edges = [e for e in edges
             if e["source"] in nodes and e["target"] in nodes
             and id(e) not in dropped]
    for edge in edges:
        edge.pop("_origin", None)
        edge.pop("_lenient", None)

    # §10.4 (REGISTRY_FIELDS at module level). Dangling refs contribute
    # nothing; fields: [] is legal — the viewer flags it, the builder
    # never substitutes.
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
        node.pop("_origin", None)

    # §20.1: generated_at is the fold's as-of date at UTC midnight, never
    # the wall clock (determinism: same inputs ⇒ byte-identical output).
    # The default as-of is the max activity date across the dated inputs —
    # journal rows and trail segments; with no dated input the key stays
    # absent, not invented. An explicit as-of is the inclusive upper bound
    # over every journal row and trail segment projected above.
    graph = {
        "format": "atlas-graph",
        "version": 1,
        "nodes": sorted(nodes.values(), key=lambda n: n["id"]),
        # §20.3 determinism: canonical identity order — type, source,
        # target, then the meta discriminant.
        "edges": sorted(edges, key=lambda e: (
            e["type"], e["source"], e["target"], e.get("context") or "",
            e.get("order") or 0, e.get("step") or "")),
        "trails": [],       # §29 Phase 3
        "state": {},        # §29 Phase 3 (fold, §14.5-14.8)
        "influence": {},    # §29 Phase 4 (§9.10)
        "frontier": [],     # §29 Phase 4 (§15)
        "projections": dict(sorted(projections.items())),  # §20 step 12, §32
    }
    effective_as_of = (as_of
                       or (max(activity_dates) if activity_dates else None))
    if effective_as_of is not None:
        graph["generated_at"] = effective_as_of + "T00:00:00Z"
    if skipped_dated_inputs:
        warnings.append(
            f"skipped {skipped_dated_inputs} dated input(s) after as-of "
            f"{as_of} (§20.1)")
    return graph, errors, warnings


def _journal_lines(path: Path):
    """Yield bounded journal rows, discarding an oversize row in place."""
    number = 1
    row = bytearray()
    discarding = False
    with path.open("rb") as stream:
        while chunk := stream.read(_JOURNAL_READ_BYTES):
            offset = 0
            while offset < len(chunk):
                newline = chunk.find(b"\n", offset)
                end = len(chunk) if newline < 0 else newline
                if not discarding:
                    room = JOURNAL_ROW_BYTES + 1 - len(row)
                    row.extend(chunk[offset:end][:room])
                    if end - offset > room or len(row) > JOURNAL_ROW_BYTES:
                        # §25.8: report as soon as byte N+1 arrives, then
                        # drain to LF without retaining rejected content.
                        yield number, b"", True
                        row.clear()
                        discarding = True
                if newline < 0:
                    break
                if not discarding:
                    yield number, bytes(row), False
                number += 1
                row.clear()
                discarding = False
                offset = newline + 1
    if row:
        yield number, bytes(row), False


def main() -> int:
    args = sys.argv[1:]
    check_only = False
    redact = False
    as_of = None
    positional = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--check":
            if check_only:
                print("ERROR: --check may be specified only once",
                      file=sys.stderr)
                return _print_usage()
            check_only = True
        elif arg == "--redact":
            if redact:
                print("ERROR: --redact may be specified only once",
                      file=sys.stderr)
                return _print_usage()
            redact = True
        elif arg == "--as-of":
            if as_of is not None:
                print("ERROR: --as-of may be specified only once",
                      file=sys.stderr)
                return _print_usage()
            index += 1
            if index >= len(args) or not _valid_as_of(args[index]):
                print("ERROR: --as-of requires YYYY-MM-DD", file=sys.stderr)
                return _print_usage()
            as_of = args[index]
        else:
            positional.append(arg)
        index += 1
    if len(positional) != 2:
        return _print_usage()
    if check_only and redact:
        print("ERROR: --check and --redact cannot be combined",
              file=sys.stderr)
        return _print_usage()

    curated = Path(positional[0])

    # §20.2 (#60): reject a missing or mis-mounted input before the
    # output-derived lock or any output path is touched, including --check.
    try:
        input_reader = AtlasReader(
            curated.parent if curated.name == "atlas" else curated
        )
        curated_prefix = Path("atlas") if curated.name == "atlas" else Path()
        if curated.name == "atlas" and not input_reader.is_directory("atlas"):
            raise ReaderError(ReasonCode.INVALID_ROOT)
        has_entries = input_reader.has_entries(curated_prefix)
        has_curated_directory = any(
            input_reader.is_directory(curated_prefix / name)
            for name in CURATED_SUBDIRECTORIES
        )
    except ReaderError as exc:
        print(f"ERROR: {curated}: {exc}", file=sys.stderr)
        return 1
    # §20.1: an EMPTY curated tree is a valid fresh instance and still
    # builds; a mis-mount is a directory with content but none of the §8
    # curated subdirectories.
    if has_entries and not has_curated_directory:
        print(f"ERROR: {curated}: not shaped like a curated tree "
              f"(expected at least one §8 curated subdirectory)",
              file=sys.stderr)
        return 1
    curated = input_reader.root.joinpath(*curated_prefix.parts)

    output = Path(positional[1]).resolve()
    if output.name != "atlas-graph.json" or output.parent.name != "graph":
        print(f"ERROR: {output}: OUTPUT_JSON must end in "
              f"graph/atlas-graph.json", file=sys.stderr)
        return _print_usage()
    # §25.6: with the normal layout the curated tree is INSTANCE/atlas and
    # its journals are read from the same instance — the output-derived
    # lock must guard exactly that root, or a held input-instance lock
    # would be bypassed and the builder could race another writer.
    if curated.name == "atlas" and curated.parent != output.parent.parent:
        print(f"ERROR: {curated} belongs to instance {curated.parent}, but "
              f"OUTPUT_JSON derives instance {output.parent.parent} — one "
              f"instance, one lock (§25.6)", file=sys.stderr)
        return 1

    # §25.6 (#36): the instance is single-writer — every writing flow takes
    # .atlas-lock at the output-derived instance root, acquire-if-absent
    # (O_CREAT|O_EXCL), and refuses when it is already held; stale locks are
    # removed by hand.
    lock_fd = None
    # §20.2/§25.6 (#60): canonical output is
    # INSTANCE/graph/atlas-graph.json, so its grandparent owns the lock.
    instance_root = output.parent.parent
    lock = instance_root / ".atlas-lock"
    if not check_only:
        try:
            lock_fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            print(f"ERROR: {lock} is already held — the instance is "
                  f"single-writer (§25.6); if its holder crashed, inspect "
                  f"and remove the lock by hand", file=sys.stderr)
            return 1
        except OSError as exc:
            print(f"ERROR: cannot acquire {lock}: {exc}", file=sys.stderr)
            return 1
        try:
            os.write(lock_fd, (json.dumps({
                "pid": os.getpid(),
                "started_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }) + "\n").encode("utf-8"))
        except OSError as exc:
            _release_lock(lock_fd, lock)
            print(f"ERROR: cannot write {lock}: {exc}", file=sys.stderr)
            return 1
    try:
        return _run(curated, output, check_only, as_of, redact)
    finally:
        if lock_fd is not None:
            _release_lock(lock_fd, lock)


def _print_usage() -> int:
    print(
        f"usage: {Path(sys.argv[0]).name} [--check | --redact] "
        "[--as-of YYYY-MM-DD] CURATED_TREE "
        "OUTPUT_JSON (graph/atlas-graph.json)",
        file=sys.stderr,
    )
    return 2


def _release_lock(lock_fd: int, lock: Path) -> None:
    # §25.6: remove only the inode this process acquired. If another actor
    # replaced the path, its foreign lock survives this writer's cleanup.
    try:
        own_stat = os.fstat(lock_fd)
        try:
            path_stat = lock.stat()
        except FileNotFoundError:
            path_stat = None
        if path_stat is not None and os.path.samestat(own_stat, path_stat):
            lock.unlink()
    finally:
        os.close(lock_fd)


def _valid_as_of(value: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        time.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _run(curated: Path, output: Path, check_only: bool,
         as_of: str | None = None, redact: bool = False) -> int:
    try:
        graph, errors, warnings = build(curated, as_of)
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
        if not _emit_graph(output, graph):
            return 1
        redacted_output = output.with_name("atlas-graph.redacted.json")
        if redact:
            if not _emit_graph(redacted_output, _redact_graph(graph)):
                return 1
        else:
            # §32.6: a stale agent-facing variant must never outlive the
            # build that obsoleted it — content classed after the variant
            # was emitted would keep leaking through the old file.
            try:
                redacted_output.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                print(f"ERROR: cannot remove stale {redacted_output}: {exc}",
                      file=sys.stderr)
                return 1
            else:
                # §25.6: the removal is only durable once graph/'s entry
                # is synced — a crash before that could resurrect the
                # stale variant next to a newer full graph.
                try:
                    _sync_dir(redacted_output.parent)
                except OSError as exc:
                    print(f"ERROR: cannot remove stale {redacted_output}: "
                          f"{exc}", file=sys.stderr)
                    return 1
    try:
        output_display = output.relative_to(ROOT)
    except ValueError:
        output_display = output
    print(f"{'checked' if check_only else 'built'}: "
          f"{len(graph['nodes'])} nodes, {len(graph['edges'])} edges"
          + ("" if check_only else f" -> {output_display}"))
    return 0


def _redact_graph(graph: dict) -> dict:
    # §20 step 12/§32.6: Phase 1 taint lives on whole nodes. Edges resting
    # on those ids and silhouette entries for those zones leave as units;
    # nothing is rewritten and the full graph remains untouched.
    withheld_ids = {
        node["id"] for node in graph["nodes"] if "sensitivity" in node
    }

    def payload_text(mapping, skip):
        # Every string anywhere in the payload except the identity fields
        # the caller already checks exactly — reference fields (target,
        # context/source values, via items, probe, direction) and free
        # text (summary, reason, notes) alike.
        parts = []
        stack = [value for key, value in mapping.items() if key not in skip]
        while stack:
            value = stack.pop()
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, list):
                stack.extend(value)
            elif isinstance(value, dict):
                stack.extend(value.values())
        return "\x00".join(parts)

    # An edge leaves whole when ANY id it carries is withheld: endpoints,
    # provenance, and the identity metadata that also holds node ids —
    # context (a route id) and step (a concept id) — or its own class.
    # Its remaining metadata (note, weight) gets the same substring scan
    # as node payloads: a withheld id in edge free text is the same leak.
    def keep_edge(edge):
        if (edge["source"] in withheld_ids
                or edge["target"] in withheld_ids
                or edge.get("context") in withheld_ids
                or edge.get("step") in withheld_ids
                or "sensitivity" in edge
                or withheld_ids.intersection(edge["provenance"])):
            return False
        text = payload_text(
            edge, {"source", "target", "context", "step", "provenance"})
        return not any(marked in text for marked in withheld_ids)

    # One withheld set, one fixpoint, two growth rules; `withheld`
    # discloses counts only (§32.6), so no withheld id — classed, tainted,
    # or consistency-stranded — may survive anywhere in the output:
    # - §32.6 citation taint: a retained node whose payload carries a
    #   withheld id rests on it and leaves whole too. Substring
    #   containment on purpose: a withheld id embedded in surviving free
    #   text is the same leak as a reference field, and a deliberate
    #   prose mention taints by construction.
    # - §10.4 consistency: fields must stay derivable from the surviving
    #   edges. A surviving node whose stored fields the surviving graph
    #   no longer derives rests on redacted refs — a derived value
    #   resting on classed data is marked by the union, and payloads are
    #   never rewritten, so the node leaves whole. Withholding it drops
    #   its edges, which can strand further derivations or surface new
    #   free-text mentions.
    while True:
        changed = True
        while changed:
            changed = False
            for node in graph["nodes"]:
                if node["id"] in withheld_ids:
                    continue
                text = payload_text(node, {"id"})
                if any(marked in text for marked in withheld_ids):
                    withheld_ids.add(node["id"])
                    changed = True
        nodes = [node for node in graph["nodes"]
                 if node["id"] not in withheld_ids]
        edges = [edge for edge in graph["edges"] if keep_edge(edge)]
        expected = graph_field_expectations({"nodes": nodes, "edges": edges})
        stale = {node["id"] for node in nodes
                 if node["id"] in expected
                 and node.get("fields") != expected[node["id"]]}
        if not stale:
            break
        withheld_ids |= stale

    projections = {
        zone: region for zone, region in graph["projections"].items()
        if zone not in withheld_ids
    }
    redacted = dict(graph)
    redacted["nodes"] = nodes
    redacted["edges"] = edges
    redacted["projections"] = projections
    # atlas-graph.schema.json requires every §10 payload key, zeros included.
    redacted["withheld"] = {
        "nodes": len(graph["nodes"]) - len(nodes),
        "edges": len(graph["edges"]) - len(edges),
        "trails": 0,
        "state": 0,
        "influence": 0,
        "frontier": 0,
        "projections": len(graph["projections"]) - len(projections),
    }
    return redacted


def _sync_dir(directory: Path) -> None:
    fd = os.open(str(directory), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _emit_graph(output: Path, graph: dict) -> bool:
    payload = (json.dumps(graph, ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8")
    tmp = output.with_name(output.name + ".tmp")
    replaced = False
    had_previous = False
    previous = b""
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        had_previous = output.exists()
        if had_previous:
            previous = output.read_bytes()

        # §20.2/§25.6: the temp stays beside the canonical output inside
        # the instance. Sync its bytes, atomically replace, then sync graph/
        # so the directory entry itself is durable.
        with tmp.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, output)
        replaced = True
        _sync_dir(output.parent)
    except OSError as exc:
        # A post-rename directory-sync failure is observable as a failed
        # emission too; restore the last good bytes before returning.
        if replaced:
            try:
                if had_previous:
                    with tmp.open("wb") as stream:
                        stream.write(previous)
                        stream.flush()
                    os.replace(tmp, output)
                else:
                    output.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"ERROR: cannot emit {output}: {exc}", file=sys.stderr)
        return False
    return True


if __name__ == "__main__":
    sys.exit(main())
