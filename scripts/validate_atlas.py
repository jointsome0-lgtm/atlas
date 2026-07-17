#!/usr/bin/env python3
"""Validate Atlas persisted formats with a fail-closed stdlib subset.

The interpreter intentionally supports only the JSON Schema 2020-12 keywords
used by the authored schemas in ``spec/schemas``.  Encountering any other
schema keyword is a validation error, never an ignored annotation.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import build_atlas_graph as _builder
from frontmatter import (
    FrontmatterError,
    MAX_DOCUMENT_BYTES,
    MAX_FILE_BYTES,
    MAX_LINE_BYTES,
    MAX_NODES,
    MAX_SCALAR_BYTES,
    MAX_SEQUENCE_ENTRIES,
    parse_document,
    parse_frontmatter,
)

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "spec" / "schemas"
GRAMMAR_DIR = ROOT / "fixtures" / "grammar"
JOURNAL_ROW_BYTES = _builder.JOURNAL_ROW_BYTES  # §25.8 — one source

SCHEMA_NAMES = {
    "concept",
    "zone",
    "pattern",
    "material",
    "direction",
    "suggested-route",
    "trail-segment",
    "probe",
    "plan-extract",
    "journal-artifact",
    "journal-encounter",
    "journal-question",
    "journal-decision",
    "journal-mapping-decision",
    "journal-receipt",
    "journal-purge",
    "atlas-graph",
    "atlas-snapshot",
    "atlas-intake",
}

SUPPORTED_KEYWORDS = {
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "pattern",
    "oneOf",
    "anyOf",
    "allOf",
    "if",
    "then",
    "minimum",
    "minItems",
    "uniqueItems",
    "minProperties",
}


class SchemaSubsetError(ValueError):
    pass


class JsonInputError(ValueError):
    pass


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise JsonInputError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value):
    raise JsonInputError(f"non-finite JSON number {value!r} is unsupported")


def _json_loads(text: str):
    return json.loads(
        text, object_pairs_hook=_strict_object, parse_constant=_reject_constant
    )


def _read_json(path: Path, delivered: bool = False):
    """Read one JSON file; `delivered` relaxes the Atlas-authored text rules.

    §25.8 scopes UTF-8/LF/no-BOM to Atlas-authored files; delivered intake
    batches stay as delivered (§33.2), so their reader tolerates CRLF and a
    BOM while the structural JSON checks stay fail-closed.
    """
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        if not delivered:
            raise JsonInputError(f"{path}: UTF-8 BOM is unsupported")
        data = data[3:]
    if not delivered and b"\r" in data:
        line = data.count(b"\n", 0, data.index(b"\r")) + 1
        raise JsonInputError(f"{path}:{line}: CR/CRLF is unsupported; use LF")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        line = data.count(b"\n", 0, exc.start) + 1
        raise JsonInputError(f"{path}:{line}: input is not strict UTF-8") from None
    try:
        return _json_loads(text)
    except (json.JSONDecodeError, JsonInputError) as exc:
        if isinstance(exc, json.JSONDecodeError):
            raise JsonInputError(
                f"{path}:{exc.lineno}: invalid JSON: {exc.msg}"
            ) from None
        raise JsonInputError(f"{path}: {exc}") from None


def _schema_children(schema: dict):
    for keyword in ("properties", "$defs"):
        value = schema.get(keyword)
        if isinstance(value, dict):
            for name, child in value.items():
                yield f"{keyword}/{name}", child
    for keyword in ("items", "additionalProperties", "if", "then"):
        value = schema.get(keyword)
        if isinstance(value, dict):
            yield keyword, value
    for keyword in ("oneOf", "anyOf", "allOf"):
        value = schema.get(keyword)
        if isinstance(value, list):
            for index, child in enumerate(value):
                yield f"{keyword}/{index}", child


def _check_schema_subset(schema, path="#"):
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaSubsetError(f"{path}: schema must be an object or boolean")
    for keyword in schema:
        if keyword not in SUPPORTED_KEYWORDS:
            raise SchemaSubsetError(f"{path}: unsupported schema keyword {keyword!r}")
    for suffix, child in _schema_children(schema):
        _check_schema_subset(child, f"{path}/{suffix}")


_PATTERN_CACHE: dict[str, re.Pattern] = {}


def _ecma_search(pattern: str, instance: str) -> bool:
    """Match a schema pattern with JSON Schema's ECMA-262 `$` semantics.

    Python's `$` also matches before a trailing newline, so an id like
    "concept:bad\\n" would pass an `^...$` shape check. Every unescaped `$`
    compiles as `\\Z` (absolute end), inside groups and lookaheads included;
    a `$` in a character class fails to compile and so fails closed.
    """
    compiled = _PATTERN_CACHE.get(pattern)
    if compiled is None:
        parts: list[str] = []
        escaped = False
        for char in pattern:
            if escaped:
                parts.append(char)
                escaped = False
                continue
            if char == "\\":
                parts.append(char)
                escaped = True
                continue
            parts.append(r"\Z" if char == "$" else char)
        try:
            compiled = re.compile("".join(parts))
        except re.error as exc:
            raise SchemaSubsetError(f"invalid schema pattern: {exc}") from None
        _PATTERN_CACHE[pattern] = compiled
    return compiled.search(instance) is not None


def _json_equal(left, right):
    if type(left) is not type(right):
        return False
    return left == right


class SchemaValidator:
    """The authored, fail-closed JSON Schema subset."""

    def __init__(self, schema: dict):
        _check_schema_subset(schema)
        self.root = schema

    def resolve(self, ref: str):
        if not ref.startswith("#/"):
            raise SchemaSubsetError(f"unsupported non-local schema reference {ref!r}")
        value = self.root
        for raw in ref[2:].split("/"):
            key = raw.replace("~1", "/").replace("~0", "~")
            if not isinstance(value, dict) or key not in value:
                raise SchemaSubsetError(f"unresolved schema reference {ref!r}")
            value = value[key]
        return value

    def validate(self, instance) -> list[str]:
        errors: list[str] = []
        self._validate(instance, self.root, "$", errors)
        return errors

    def _matches(self, instance, schema) -> bool:
        errors: list[str] = []
        self._validate(instance, schema, "$", errors)
        return not errors

    def _validate(self, instance, schema, path: str, errors: list[str]):
        if schema is True:
            return
        if schema is False:
            errors.append(f"{path}: rejected by false schema")
            return
        if "$ref" in schema:
            self._validate(instance, self.resolve(schema["$ref"]), path, errors)

        expected = schema.get("type")
        if expected is not None:
            predicates = {
                "object": lambda value: isinstance(value, dict),
                "array": lambda value: isinstance(value, list),
                "string": lambda value: isinstance(value, str),
                "integer": lambda value: isinstance(value, int)
                and not isinstance(value, bool),
            }
            if expected not in predicates:
                raise SchemaSubsetError(f"unsupported schema type {expected!r}")
            if not predicates[expected](instance):
                errors.append(f"{path}: expected {expected}, got {type(instance).__name__}")
                return

        if "const" in schema and not _json_equal(instance, schema["const"]):
            errors.append(f"{path}: expected constant {schema['const']!r}")
        if "enum" in schema and not any(
            _json_equal(instance, choice) for choice in schema["enum"]
        ):
            errors.append(f"{path}: value {instance!r} is outside {schema['enum']!r}")
        if "pattern" in schema and isinstance(instance, str):
            if not _ecma_search(schema["pattern"], instance):
                errors.append(f"{path}: string {instance!r} does not match {schema['pattern']!r}")
        if "minimum" in schema and isinstance(instance, int) and not isinstance(instance, bool):
            if instance < schema["minimum"]:
                errors.append(f"{path}: value {instance} is below minimum {schema['minimum']}")

        if isinstance(instance, dict):
            required = schema.get("required", [])
            for key in required:
                if key not in instance:
                    errors.append(f"{path}: missing required property {key!r}")
            if "minProperties" in schema and len(instance) < schema["minProperties"]:
                errors.append(
                    f"{path}: has {len(instance)} properties; minimum is {schema['minProperties']}"
                )
            properties = schema.get("properties", {})
            for key, value in instance.items():
                child_path = f"{path}.{key}"
                if key in properties:
                    self._validate(value, properties[key], child_path, errors)
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{path}: unknown property {key!r}")
                elif isinstance(schema.get("additionalProperties"), dict):
                    self._validate(
                        value, schema["additionalProperties"], child_path, errors
                    )

        if isinstance(instance, list):
            if "minItems" in schema and len(instance) < schema["minItems"]:
                errors.append(
                    f"{path}: has {len(instance)} items; minimum is {schema['minItems']}"
                )
            if schema.get("uniqueItems"):
                for index, item in enumerate(instance):
                    if any(_json_equal(item, prior) for prior in instance[:index]):
                        errors.append(f"{path}[{index}]: duplicate item")
            if isinstance(schema.get("items"), dict):
                for index, item in enumerate(instance):
                    self._validate(item, schema["items"], f"{path}[{index}]", errors)

        for keyword, minimum in (("oneOf", 1), ("anyOf", 1)):
            if keyword in schema:
                matches = sum(self._matches(instance, branch) for branch in schema[keyword])
                if keyword == "oneOf" and matches != 1:
                    errors.append(f"{path}: expected exactly one oneOf match, got {matches}")
                if keyword == "anyOf" and matches < minimum:
                    errors.append(f"{path}: did not match any anyOf branch")
        for branch in schema.get("allOf", []):
            self._validate(instance, branch, path, errors)
        if "if" in schema:
            branch = "then" if self._matches(instance, schema["if"]) else None
            if branch and branch in schema:
                self._validate(instance, schema[branch], path, errors)


def _load_registry() -> tuple[dict[str, dict], list[str]]:
    errors: list[str] = []
    schemas: dict[str, dict] = {}
    paths = sorted(SCHEMA_DIR.glob("*.schema.json"))
    found = {path.name.removesuffix(".schema.json") for path in paths}
    if found != SCHEMA_NAMES:
        errors.append(
            "schema inventory mismatch: "
            f"expected {sorted(SCHEMA_NAMES)!r}, found {sorted(found)!r}"
        )
    for path in paths:
        name = path.name.removesuffix(".schema.json")
        try:
            schema = _read_json(path)
            if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
                errors.append(f"{path}: $schema must name JSON Schema 2020-12")
            expected_id = f"https://atlas-sdd.local/schemas/{path.name}"
            if schema.get("$id") != expected_id:
                errors.append(f"{path}: $id must be {expected_id!r}")
            SchemaValidator(schema)
            schemas[name] = schema
        except (JsonInputError, SchemaSubsetError, AttributeError) as exc:
            errors.append(str(exc))
    return schemas, errors


def _schema_errors(instance, schema, source: Path | str):
    return [f"{source}: {message}" for message in SchemaValidator(schema).validate(instance)]


CURATED_DIRS = {
    "concepts": "concept",
    "zones": "zone",
    "patterns": "pattern",
    "materials": "material",
    "directions": "direction",
    "suggested-routes": "suggested-route",
    "trails": "trail-segment",
    "probes": "probe",
}

JOURNALS = {
    "artifacts": "journal-artifact",
    "encounters": "journal-encounter",
    "questions": "journal-question",
    "decisions": "journal-decision",
    "mapping-decisions": "journal-mapping-decision",
    "receipts": "journal-receipt",
    "purges": "journal-purge",
}


def _journal_paths(state: Path, stem: str):
    direct = state / f"{stem}.jsonl"
    if direct.is_file():
        yield direct
    rotated = state / stem
    if rotated.is_dir():
        yield from sorted(rotated.glob("*.jsonl"))


def _read_jsonl(path: Path):
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        raise JsonInputError(f"{path}:1: UTF-8 BOM is unsupported")
    if b"\r" in data:
        line = data.count(b"\n", 0, data.index(b"\r")) + 1
        raise JsonInputError(f"{path}:{line}: CR/CRLF is unsupported; use LF")
    for number, raw in enumerate(data.split(b"\n"), 1):
        if not raw and number == len(data.split(b"\n")):
            continue
        if not raw:
            raise JsonInputError(f"{path}:{number}: blank JSONL row is unsupported")
        if len(raw) > JOURNAL_ROW_BYTES:
            raise JsonInputError(
                f"{path}:{number}: journal row exceeds {JOURNAL_ROW_BYTES} bytes"
            )
        try:
            text = raw.decode("utf-8", errors="strict")
            yield number, _json_loads(text)
        except UnicodeDecodeError:
            raise JsonInputError(f"{path}:{number}: input is not strict UTF-8") from None
        except (json.JSONDecodeError, JsonInputError) as exc:
            message = exc.msg if isinstance(exc, json.JSONDecodeError) else str(exc)
            raise JsonInputError(f"{path}:{number}: invalid JSON: {message}") from None


_EVIDENCE_PREFIXES = ("artifact:", "encounter:", "question:")
_SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_REGION_ID_RE = re.compile(rf"^(?:concept|pattern|zone):{_SLUG}$")
_EVIDENCE_ID_RE = re.compile(rf"^(?:artifact|encounter|question):{_SLUG}$")
_MATERIAL_ID_RE = re.compile(rf"^(?:material:{_SLUG}|part:{_SLUG}/{_SLUG})$")
_ZONE_ID_RE = re.compile(rf"^zone:{_SLUG}$")



_REGISTRY_FIELDS = {"concept": {"knowledge"}, "zone": {"body"},
                    "pattern": {"body"}}
_FIELD_DERIVED_KINDS = {"material", "material_part", "suggested_route",
                        "direction", "probe", "question", "artifact",
                        "encounter", "trail_segment", "plan"}
_PART_EDGE_ROLES = {"prerequisite_of", "extends", "contradicts", "implements",
                    "explains", "demonstrates", "critiques", "mentions"}
# §10.3: provenance is the direct derivation basis, so per edge kind it must
# name the owning record — the authored species' authoring endpoint (§9.3
# concept_edges on the source, §9.14 supported_by on the receiving target),
# a derived species' deriving payload node (§10.2/§10.4 ownership).
_PROVENANCE_SOURCE_OWNED = (_builder.AUTHORED_ROLES - {"related_to"}) | {
    "overall_concept", "has_part", "visited", "influences",
    "updates_state", "via", "produced_artifact"}
_PROVENANCE_TARGET_OWNED = {
    "supports", "probed_by", "part_of_direction", "step_of_route",
    "pulled_by"}
# primary_for/supporting_for ownership is contextual (§11.1–§11.3):
# authored on a route target, derived from journal records on question
# and trail targets — checked against the payload-backing sets.


def _graph_field_errors(instance: dict, path: Path) -> list[str]:
    """§10.4: fields membership is derivable from the emitted edges —
    recompute it for the derived kinds and require the persisted value to
    match (region kinds are pinned by the schema itself)."""
    errors: list[str] = []
    types = {}
    for node in _as_list(instance.get("nodes")):
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            # A non-string type already carries its schema diagnostic —
            # None keeps every set membership below hashable.
            node_type = node.get("type")
            types[node["id"]] = node_type if isinstance(node_type, str) else None
    refs: dict = {}
    for edge in _as_list(instance.get("edges")):
        if not isinstance(edge, dict):
            continue
        src, tgt = edge.get("source"), edge.get("target")
        kind = edge.get("type")
        if not (isinstance(src, str) and isinstance(tgt, str)
                and isinstance(kind, str)):
            continue
        if kind in ("overall_concept", "has_part"):
            refs.setdefault(src, []).append(tgt)
        elif (kind in _PART_EDGE_ROLES
                and types.get(src) == "material_part"):
            refs.setdefault(src, []).append(tgt)
        elif kind in ("step_of_route", "part_of_direction", "probed_by",
                      "pulled_by"):
            refs.setdefault(tgt, []).append(src)
        elif kind in ("influences", "updates_state", "visited"):
            refs.setdefault(src, []).append(tgt)

    for node in _as_list(instance.get("nodes")):
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
        registry = _REGISTRY_FIELDS.get(types.get(node_id))
        if registry is not None:
            return set(registry)
        result = set()
        for ref in refs.get(node_id, []):
            result |= fields_of(ref, seen | {node_id})
        return result

    for node in _as_list(instance.get("nodes")):
        if not (isinstance(node, dict) and isinstance(node.get("id"), str)):
            continue
        if types.get(node["id"]) not in _FIELD_DERIVED_KINDS:
            continue
        expected = sorted(fields_of(node["id"]))
        found = node.get("fields")
        if (isinstance(found, list)
                and sorted(x for x in found if isinstance(x, str)) != expected):
            errors.append(
                f"{path}: node {node['id']} fields {found!r} do not match "
                f"the §10.4 derivation {expected!r}"
            )
    return errors


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _as_list(value):
    return value if isinstance(value, list) else []

def _snapshot_dangling_refs(snapshot: dict, path: Path) -> list[str]:
    """§33.4: every §9.12 evidence id in an evidence-bearing field resolves
    in the top-level evidence_refs table; curated node ids `via` may carry
    (a material part) are node refs, never table entries."""
    table = snapshot.get("evidence_refs")
    known = set(table) if isinstance(table, dict) else set()
    errors: list[str] = []

    # The table maps §9.12 evidence ids to {kind, date}; the key's prefix is
    # its kind — a mismatch corrupts the provenance table (§33.4).
    for key, entry in (table or {}).items() if isinstance(table, dict) else ():
        if not (isinstance(key, str) and _EVIDENCE_ID_RE.fullmatch(key)):
            errors.append(
                f"{path}: evidence_refs key {key!r} is not a §9.12 evidence id"
            )
            continue
        kind = entry.get("kind") if isinstance(entry, dict) else None
        if isinstance(kind, str) and key.split(":", 1)[0] != kind:
            errors.append(
                f"{path}: evidence_refs[{key}] kind {kind!r} does not match "
                "the id prefix (§33.4)"
            )

    # §33.4: materials is material contact state (§14.8) — keys are
    # material(part) ids only.
    for key in _as_dict(snapshot.get("materials")):
        if not (isinstance(key, str) and _MATERIAL_ID_RE.fullmatch(key)):
            errors.append(
                f"{path}: materials key {key!r} is not a material(part) id "
                "(§33.4, §14.8)"
            )

    def check(refs, where):
        for ref in _as_list(refs):
            if (isinstance(ref, str) and ref.startswith(_EVIDENCE_PREFIXES)
                    and ref not in known):
                errors.append(
                    f"{path}: {where} cites {ref}, absent from evidence_refs (§33.4)"
                )

    for node, entry in _as_dict(snapshot.get("state")).items():
        if isinstance(entry, dict):
            check(entry.get("evidence"), f"state.{node}.evidence")
            for index, decision in enumerate(_as_list(entry.get("decisions"))):
                if isinstance(decision, dict):
                    check(decision.get("evidence"),
                          f"state.{node}.decisions[{index}].evidence")
    for node, entry in _as_dict(snapshot.get("materials")).items():
        if isinstance(entry, dict):
            check(entry.get("evidence"), f"materials.{node}.evidence")
    for index, segment in enumerate(_as_list(snapshot.get("trail"))):
        if isinstance(segment, dict):
            check(segment.get("via"), f"trail[{index}].via")
    for index, question in enumerate(_as_list(snapshot.get("questions"))):
        if isinstance(question, dict):
            check(question.get("source"), f"questions[{index}].source")
    return errors


_STATE_DIMENSIONS = {
    "concept": {"exposure", "confidence", "clarity", "coverage", "freshness"},
    "pattern": {"exposure", "confidence", "clarity", "coverage", "freshness"},
    "zone": {"contact", "strength", "endurance", "mobility", "condition", "freshness"},
}
# §14.8/§33.4: the material contact ladder lives under `materials` — a
# region state entry never carries it, so it is cross-kind everywhere.
_MATERIAL_STATE_DIMENSIONS = {"depth_reached"}
_ALL_STATE_DIMENSIONS = (set().union(*_STATE_DIMENSIONS.values())
                         | _MATERIAL_STATE_DIMENSIONS)
_EXPOSURE_VALUES = {
    "concept": {"unseen", "touched", "read", "summarized", "applied", "taught"},
    "pattern": {"unseen", "touched", "studied", "tried", "drilled", "reviewed"},
}
_DECISION_DIMENSIONS = {
    "concept": {"confidence", "clarity", "coverage"},
    "pattern": {"confidence", "clarity", "coverage"},
    "zone": {"strength", "endurance", "mobility", "condition"},
}
_ALL_DECISION_DIMENSIONS = set().union(*_DECISION_DIMENSIONS.values())


def _snapshot_state_kind_errors(snapshot: dict, path: Path) -> list[str]:
    """§33.4: per-node state exports on the node's own scales — a concept
    never carries a zone ladder. Only cross-kind dimension keys are errors;
    unknown keys stay additive (§25.7)."""
    errors: list[str] = []
    for node, entry in _as_dict(snapshot.get("state")).items():
        if not (isinstance(node, str) and _REGION_ID_RE.fullmatch(node)):
            errors.append(
                f"{path}: state key {node!r} is not a region node id (§33.4)"
            )
            continue
        kind = node.split(":", 1)[0]
        allowed = _STATE_DIMENSIONS[kind]
        if not isinstance(entry, dict):
            continue
        for key in entry:
            if key in _ALL_STATE_DIMENSIONS and key not in allowed:
                errors.append(
                    f"{path}: state.{node} carries {key!r} — not a {kind} "
                    "dimension (§33.4: a node exports its own scales)"
                )
        exposure = entry.get("exposure")
        ladder = _EXPOSURE_VALUES.get(kind)
        if (isinstance(exposure, str) and ladder is not None
                and exposure not in ladder):
            errors.append(
                f"{path}: state.{node} exposure {exposure!r} is outside the "
                f"{kind} ladder (§14.1/§32.3)"
            )
        gated = _DECISION_DIMENSIONS.get(kind, set())
        for index, decision in enumerate(_as_list(entry.get("decisions"))):
            if not isinstance(decision, dict):
                continue
            dimension = decision.get("dimension")
            if (isinstance(dimension, str)
                    and dimension in _ALL_DECISION_DIMENSIONS
                    and dimension not in gated):
                errors.append(
                    f"{path}: state.{node}.decisions[{index}] gates "
                    f"{dimension!r} — not a {kind} dimension (§33.4, §14.6)"
                )
    return errors


def validate_instance(root: Path):
    schemas, errors = _load_registry()
    warnings: list[str] = []
    counts = {"frontmatter": 0, "rows": 0, "intake": 0, "emitted": 0}
    if errors:
        return errors, warnings, counts

    curated = root / "atlas" if (root / "atlas").is_dir() else root
    # §34.4: the retired -> living map spans the instance, so cross-file
    # id checks run after the whole curated pass — a stale curated ref
    # resolves through the map (a warning, never an error), mirroring
    # the builder.
    retired: dict = {}  # old id -> (survivor id, declaring path)
    living: dict = {}  # id -> declaring path
    route_checks: list = []

    def _claim_living(node_id, origin):
        # §10.1: one id, one record — the builder fails on a duplicate,
        # so the boundary rejects it too.
        prior = living.get(node_id)
        if prior is not None:
            errors.append(
                f"{origin}: duplicate id {node_id} (also declared in "
                f"{prior}) (§10.1)")
            return
        living[node_id] = origin

    def _claim_retired(old, survivor, origin):
        # §34.4: one retired id has one survivor — a 1->n redirect is
        # unrepresentable and the builder rejects it.
        prior = retired.get(old)
        if prior is not None and prior[0] != survivor:
            errors.append(
                f"{origin}: retired id {old} redirects to both "
                f"{prior[0]} and {survivor} (§34.4)")
            return
        retired[old] = (survivor, origin)

    for dirname, schema_name in CURATED_DIRS.items():
        directory = curated / dirname
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            if path.name.startswith("_"):
                continue
            try:
                instance = parse_frontmatter(path.read_bytes(), path)
                errors.extend(_schema_errors(instance, schemas[schema_name], path))
                if isinstance(instance, dict):
                    doc_id = instance.get("id")
                    if isinstance(doc_id, str):
                        _claim_living(doc_id, path)
                    for old in _as_list(instance.get("formerly")):
                        if isinstance(old, str) and isinstance(doc_id, str):
                            _claim_retired(old, doc_id, path)
                    for part in _as_list(instance.get("parts")):
                        if not isinstance(part, dict):
                            continue
                        part_id = part.get("id")
                        if isinstance(part_id, str):
                            _claim_living(part_id, path)
                        for old in _as_list(part.get("formerly")):
                            if isinstance(old, str) and isinstance(part_id, str):
                                _claim_retired(old, part_id, path)
                # §9.4: each material_roles entry names a member of steps —
                # deferred until the retired map is complete (§34.4).
                if schema_name == "suggested-route" and isinstance(instance, dict):
                    route_checks.append((path, instance))
                # §10.1: an embedded part id carries its material's slug.
                if schema_name == "material" and isinstance(instance, dict):
                    material_id = instance.get("id")
                    slug = (material_id.split(":", 1)[1]
                            if isinstance(material_id, str) and ":" in material_id
                            else None)
                    for index, part in enumerate(_as_list(instance.get("parts"))):
                        part_id = part.get("id") if isinstance(part, dict) else None
                        if (slug and isinstance(part_id, str)
                                and not part_id.startswith(f"part:{slug}/")):
                            errors.append(
                                f"{path}: parts[{index}].id {part_id} does not "
                                f"carry its material's slug {slug!r} (§10.1)"
                            )
                counts["frontmatter"] += 1
            except FrontmatterError as exc:
                errors.append(str(exc))

    # §34.4: a retired id is never a living one — curation keeping both
    # cannot build, so the boundary rejects it like the builder does.
    for old in sorted(set(retired) & set(living)):
        survivor, origin = retired[old]
        errors.append(
            f"{origin}: formerly {old} on {survivor} is still a "
            "living id (§34.4)")

    def _resolved(ref, origin):
        entry = retired.get(ref) if isinstance(ref, str) else None
        if entry is None:
            return ref
        warnings.append(
            f"{origin}: stale curated ref {ref} resolved to "
            f"{entry[0]} (§34.4)")
        return entry[0]

    # §9.4 on §34.4-resolved ids: each material_roles entry names a member
    # of steps, and per step the two lists are disjoint — a stale spelling
    # converges on the survivor first instead of failing builder-valid
    # curation.
    for path, instance in route_checks:
        steps = instance.get("steps")
        members = {_resolved(step, path) for step in steps
                   if isinstance(step, str)} if isinstance(steps, list) else set()
        for index, role in enumerate(_as_list(instance.get("material_roles"))):
            if not isinstance(role, dict):
                continue
            step = _resolved(role.get("step"), path)
            if isinstance(step, str) and step not in members:
                errors.append(
                    f"{path}: material_roles[{index}].step {step} "
                    "is not a member of steps (§9.4)"
                )
            primary = {_resolved(m, path)
                       for m in _as_list(role.get("primary_materials"))
                       if isinstance(m, str)}
            supporting = {_resolved(m, path)
                          for m in _as_list(role.get("supporting_materials"))
                          if isinstance(m, str)}
            for shared in sorted(primary & supporting):
                errors.append(
                    f"{path}: material_roles[{index}] lists "
                    f"{shared} as both primary and supporting "
                    "(§9.4)"
                )

    extracted = root / "plans" / "extracted"
    if extracted.is_dir():
        for path in sorted(item for item in extracted.iterdir() if item.is_file()):
            try:
                instance = parse_document(path.read_bytes(), path)
                errors.extend(_schema_errors(instance, schemas["plan-extract"], path))
                counts["frontmatter"] += 1
            except FrontmatterError as exc:
                errors.append(str(exc))

    intake = root / "intake"
    if intake.is_dir():
        # §33.2/§25.7: delivered batches are a persisted format; the JSON
        # envelope validates structurally — batch content stays as delivered
        # and is never term-scanned here (§19 keeps out of intake/ entirely).
        for path in sorted(intake.rglob("*.json")):
            try:
                instance = _read_json(path, delivered=True)
                errors.extend(_schema_errors(instance, schemas["atlas-intake"], path))
                # §33.2: source scopes the intake/ path and batch names the
                # delivery — the <source>/<batch>#n provenance and receipt
                # keys must point back at exactly this file.
                if isinstance(instance, dict):
                    source = instance.get("source")
                    batch = instance.get("batch")
                    if isinstance(source, str) and isinstance(batch, str):
                        expected = Path(source) / f"{batch}.json"
                        if path.relative_to(intake) != expected:
                            errors.append(
                                f"{path}: envelope names {source}/{batch}, "
                                f"delivered as intake/{path.relative_to(intake)}"
                                " (§33.2)"
                            )
                counts["intake"] += 1
            except JsonInputError as exc:
                errors.append(str(exc))

    state = root / "state"
    if state.is_dir():
        for stem, schema_name in JOURNALS.items():
            for path in _journal_paths(state, stem):
                try:
                    for number, row in _read_jsonl(path):
                        errors.extend(
                            _schema_errors(row, schemas[schema_name], f"{path}:{number}")
                        )
                        counts["rows"] += 1
                except JsonInputError as exc:
                    errors.append(str(exc))

    for filename, schema_name in (
        ("atlas-graph.json", "atlas-graph"),
        ("atlas-graph.redacted.json", "atlas-graph"),
        ("atlas-snapshot.json", "atlas-snapshot"),
    ):
        path = root / "graph" / filename
        if not path.is_file():
            continue
        try:
            instance = _read_json(path)
            errors.extend(_schema_errors(instance, schemas[schema_name], path))
            # §20/§25.7: one schema id covers both graph variants, so the
            # variant-only withheld rule is checked here by file name —
            # required on the redacted emission, forbidden on the full one.
            if schema_name == "atlas-snapshot" and isinstance(instance, dict):
                errors.extend(_snapshot_dangling_refs(instance, path))
                errors.extend(_snapshot_state_kind_errors(instance, path))
            if schema_name == "atlas-graph" and isinstance(instance, dict):
                errors.extend(_graph_field_errors(instance, path))
                # §10: edge endpoints are node ids consumers resolve inside
                # the same file — a dangling endpoint never leaves the build.
                node_ids: set = set()
                zone_ids: set = set()
                for node in _as_list(instance.get("nodes")):
                    if not isinstance(node, dict):
                        continue
                    node_id = node.get("id")
                    if not isinstance(node_id, str):
                        continue  # the schema already reported the type
                    if node_id in node_ids:
                        errors.append(
                            f"{path}: duplicate node id {node_id} (§10.1)"
                        )
                    node_ids.add(node_id)
                    if node.get("type") == "zone":
                        zone_ids.add(node_id)
                    # §10.1/§10.4: a part id carries its owning material's
                    # slug, and the embedded material is that parent.
                    parent = node.get("material")
                    if (node.get("type") == "material_part"
                            and isinstance(node_id, str)
                            and isinstance(parent, str)
                            and node_id.startswith("part:") and "/" in node_id):
                        slug = node_id[len("part:"):].split("/", 1)[0]
                        if parent != f"material:{slug}":
                            errors.append(
                                f"{path}: node {node_id} embeds material "
                                f"{parent} — the id's owner is "
                                f"material:{slug} (§10.1/§10.4)"
                            )
                for index, edge in enumerate(_as_list(instance.get("edges"))):
                    if not isinstance(edge, dict):
                        continue
                    for endpoint in ("source", "target"):
                        ref = edge.get(endpoint)
                        if isinstance(ref, str) and ref not in node_ids:
                            errors.append(
                                f"{path}: edges[{index}].{endpoint} {ref} "
                                "is not an emitted node id (§10)"
                            )
                    # §10.3: provenance is the complete derivation basis —
                    # authoring node ids and deriving record/route ids, all
                    # emitted as nodes of the same build.
                    for ref in _as_list(edge.get("provenance")):
                        if isinstance(ref, str) and ref not in node_ids:
                            errors.append(
                                f"{path}: edges[{index}].provenance {ref} "
                                "is not an emitted node id (§10.3)"
                            )
                    # §10.3: context and step are identity discriminants —
                    # node ids consumers resolve like endpoints.
                    for key in ("context", "step"):
                        ref = edge.get(key)
                        if isinstance(ref, str) and ref not in node_ids:
                            errors.append(
                                f"{path}: edges[{index}].{key} {ref} "
                                "is not an emitted node id (§10.3)"
                            )
                    # §10.3: provenance is the derivation basis, not just any
                    # resolvable ids — it must name the record that authored
                    # or derived the edge, or redaction/audit consumers trust
                    # the wrong record (§32.6 reads this list).
                    etype = edge.get("type")
                    if not isinstance(etype, str):
                        etype = None  # the schema already reported the type
                    prov = {ref for ref in _as_list(edge.get("provenance"))
                            if isinstance(ref, str)}
                    owner, owner_role = None, None
                    if etype in _PROVENANCE_SOURCE_OWNED:
                        owner, owner_role = edge.get("source"), "authoring source"
                    elif etype in _PROVENANCE_TARGET_OWNED:
                        owner, owner_role = edge.get("target"), "owning target"
                    elif etype == "suggested_next":
                        owner, owner_role = edge.get("context"), "deriving route"
                    if isinstance(owner, str) and prov and owner not in prov:
                        errors.append(
                            f"{path}: edges[{index}] {etype} provenance must "
                            f"include the {owner_role} {owner} (§10.3)"
                        )
                    elif etype == "related_to" and prov and not (
                            prov & {edge.get("source"), edge.get("target")}):
                        errors.append(
                            f"{path}: edges[{index}] related_to provenance "
                            "must include an authoring endpoint (§10.3)"
                        )
                    # moved_to's owning segment is not an endpoint: its
                    # provenance is checked against the segments recording
                    # the pair, in the payload-backing pass below.
                # §9.4/§10.3: a route-context role edge's step must be one of
                # that route's own step_of_route edges.
                route_steps = {
                    (edge.get("target"), edge.get("source"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "step_of_route"
                    and isinstance(edge.get("target"), str)
                    and isinstance(edge.get("source"), str)
                }
                # §10.2: suggested_next derives from consecutive steps of
                # one route — the context route must hold source at some
                # order k and target at k+1.
                step_orders: dict = {}
                for edge in _as_list(instance.get("edges")):
                    if (isinstance(edge, dict)
                            and edge.get("type") == "step_of_route"
                            and isinstance(edge.get("target"), str)
                            and isinstance(edge.get("source"), str)
                            and isinstance(edge.get("order"), int)):
                        orders = step_orders.setdefault(edge["target"], {})
                        if edge["order"] in orders:
                            # §9.4/§10.3: order positions define the route
                            # path — a duplicate makes it ambiguous.
                            errors.append(
                                f"{path}: duplicate step order "
                                f"{edge['order']} on {edge['target']} "
                                "(§9.4/§10.3)"
                            )
                            continue
                        orders[edge["order"]] = edge["source"]
                # §10.2: consecutive steps derive suggested_next — every
                # adjacent (k, k+1) pair of a route must have its edge.
                suggested_pairs = {
                    (edge.get("context"), edge.get("source"),
                     edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "suggested_next"
                    and isinstance(edge.get("context"), str)
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                for route, orders in sorted(step_orders.items()):
                    # §9.4: steps is an ordered array — the builder emits
                    # contiguous orders 1..n, so a gapped or shifted set
                    # has lost part of the route.
                    if sorted(orders) != list(range(1, len(orders) + 1)):
                        errors.append(
                            f"{path}: route {route} step orders "
                            f"{sorted(orders)} are not contiguous from 1 "
                            "(§9.4)"
                        )
                    for position in sorted(orders):
                        follower = orders.get(position + 1)
                        if follower is not None and (
                                route, orders[position],
                                follower) not in suggested_pairs:
                            errors.append(
                                f"{path}: route {route} steps at orders "
                                f"{position}/{position + 1} have no "
                                "suggested_next edge (§10.2)"
                            )
                # §20.3 determinism: the edge array emits in canonical
                # identity order — type, source, target, then the meta
                # discriminant; a shuffled array breaks the §20.1
                # byte-identical promise.
                def _edge_key(edge):
                    def _s(value):
                        return value if isinstance(value, str) else ""
                    order = edge.get("order")
                    return (_s(edge.get("type")), _s(edge.get("source")),
                            _s(edge.get("target")), _s(edge.get("context")),
                            order if isinstance(order, int) else 0,
                            _s(edge.get("step")))
                edge_keys = [_edge_key(edge)
                             for edge in _as_list(instance.get("edges"))
                             if isinstance(edge, dict)]
                if edge_keys != sorted(edge_keys):
                    errors.append(
                        f"{path}: edges are not in canonical identity "
                        "order (§20.3)"
                    )
                role_edges: dict = {}
                edge_identities: set = set()
                for index, edge in enumerate(_as_list(instance.get("edges"))):
                    if not isinstance(edge, dict):
                        continue
                    # §20.3: one edge per identity — type, endpoints, and
                    # the meta discriminants (context/order/step); dedup
                    # unions provenance instead of repeating the edge.
                    if (isinstance(edge.get("type"), str)
                            and isinstance(edge.get("source"), str)
                            and isinstance(edge.get("target"), str)):
                        # §10.2/§20.3: the meta discriminants are per-type —
                        # order on step_of_route, context on suggested_next,
                        # step on route-context roles; anywhere else they
                        # would mint fake identities for one edge.
                        allowed_meta = {
                            "step_of_route": {"order"},
                            "suggested_next": {"context"},
                        }.get(edge["type"], set())
                        if (edge["type"] in ("primary_for", "supporting_for")
                                and edge["target"].startswith(
                                    "suggested-route:")):
                            allowed_meta = {"step"}
                        for key in ("order", "context", "step"):
                            if key in edge and key not in allowed_meta:
                                errors.append(
                                    f"{path}: edges[{index}] {edge['type']} "
                                    f"carries {key} — not this type's §10.2 "
                                    "meta discriminant (§20.3)"
                                )
                        # §20.3: related_to is the one symmetric type —
                        # persisted edges carry the canonical sorted
                        # endpoints, and identity uses the sorted pair so a
                        # reversed duplicate cannot sit beside the canonical
                        # spelling.
                        source, target = edge["source"], edge["target"]
                        if edge["type"] == "related_to":
                            if target < source:
                                errors.append(
                                    f"{path}: edges[{index}] related_to "
                                    f"endpoints {source} -> {target} are "
                                    "not sorted (§20.3)"
                                )
                                source, target = target, source
                        identity = (edge["type"], source, target) + tuple(
                            edge.get(key) if isinstance(
                                edge.get(key), (str, int)) else None
                            for key in ("context", "order", "step"))
                        if identity in edge_identities:
                            errors.append(
                                f"{path}: edges[{index}] duplicates edge "
                                f"identity {edge.get('type')} "
                                f"{edge.get('source')} -> "
                                f"{edge.get('target')} (§20.3)"
                            )
                        edge_identities.add(identity)
                    context = edge.get("context")
                    if (edge.get("type") == "suggested_next"
                            and isinstance(context, str)):
                        orders = step_orders.get(context, {})
                        if not any(
                                orders.get(position) == edge.get("source")
                                and orders.get(position + 1) == edge.get("target")
                                for position in orders):
                            errors.append(
                                f"{path}: edges[{index}] suggested_next "
                                f"{edge.get('source')} -> {edge.get('target')} "
                                f"is not consecutive steps of {context} (§10.2)"
                            )
                    step = edge.get("step")
                    if (edge.get("type") in ("primary_for", "supporting_for")
                            and isinstance(step, str)
                            and isinstance(edge.get("target"), str)
                            and (edge.get("target"), step) not in route_steps):
                        errors.append(
                            f"{path}: edges[{index}].step {step} is not a "
                            f"step of {edge.get('target')} (§9.4)"
                        )
                    # §9.4/§20.3: per (route, step, material) the two role
                    # sets stay disjoint in the persisted graph too.
                    if (edge.get("type") in ("primary_for", "supporting_for")
                            and isinstance(edge.get("source"), str)
                            and isinstance(edge.get("target"), str)):
                        role_key = (edge.get("target"), step
                                    if isinstance(step, str) else None,
                                    edge.get("source"))
                        previous = role_edges.get(role_key)
                        if (previous is not None
                                and previous != edge.get("type")):
                            errors.append(
                                f"{path}: {edge.get('source')} is both "
                                f"primary and supporting for "
                                f"{edge.get('target')} step {step} "
                                "(§9.4/§20.3)"
                            )
                        role_edges[role_key] = edge.get("type")
                # §10.2/§10.4: an encounter's journal target derives the
                # typed visited edge — if the target is emitted, the edge
                # must be too.
                visited_pairs = {
                    (edge.get("source"), edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "visited"
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                # §10.2/§10.4: an embedded part's parent material owns the
                # has_part edge — if both nodes are emitted, so is the edge.
                has_part_pairs = {
                    (edge.get("source"), edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "has_part"
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                # §10.2/§9.9: a trail segment's payload movement and via
                # list derive typed edges — payload and edges cannot fork.
                moved_pairs = {
                    (edge.get("source"), edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "moved_to"
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                via_pairs = {
                    (edge.get("source"), edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "via"
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                produced_pairs = {
                    (edge.get("source"), edge.get("target"))
                    for edge in _as_list(instance.get("edges"))
                    if isinstance(edge, dict)
                    and edge.get("type") == "produced_artifact"
                    and isinstance(edge.get("source"), str)
                    and isinstance(edge.get("target"), str)
                }
                # §34.4 at the boundary: formerly is per-kind, never a
                # living id, and one retired id has one survivor.
                formerly_survivors: dict = {}
                # §10.2/§10.4 cut both ways: the payload derives the typed
                # edge AND every such edge must be backed by a payload —
                # an unbacked edge renders contact or movement the journal
                # never recorded (no-fork rule, §31.8).
                payload_visits: set = set()
                payload_parts: set = set()
                # pair -> the segment ids recording it: moved_to's owning
                # segment is not an endpoint, so its §10.3 provenance is
                # checked against this map.
                payload_movements: dict = {}
                payload_via: set = set()
                payload_produced: set = set()
                # encounter id -> (target, depth, context.question,
                # context.artifact): the §11.2–§11.3 role folds recompute
                # from these rows.
                encounter_rows: dict = {}
                for node in _as_list(instance.get("nodes")):
                    if not isinstance(node, dict):
                        continue
                    nid = node.get("id")
                    if not isinstance(nid, str):
                        continue
                    if (node.get("type") == "encounter"
                            and isinstance(node.get("target"), str)):
                        payload_visits.add((nid, node["target"]))
                        context = node.get("context")
                        if not isinstance(context, dict):
                            context = {}
                        encounter_rows[nid] = (
                            node["target"], node.get("depth"),
                            context.get("question"), context.get("artifact"))
                        if (node["target"] in node_ids
                                and (nid, node["target"]) not in visited_pairs):
                            errors.append(
                                f"{path}: encounter {nid} target "
                                f"{node['target']} has no visited edge "
                                "(§10.2/§10.4)"
                            )
                    if (node.get("type") == "material_part"
                            and isinstance(node.get("material"), str)):
                        payload_parts.add((node["material"], nid))
                        if (node["material"] in node_ids
                                and (node["material"], nid)
                                not in has_part_pairs):
                            errors.append(
                                f"{path}: part {nid} has no has_part edge "
                                f"from {node['material']} (§10.2/§10.4)"
                            )
                    if node.get("type") == "trail_segment":
                        origin = node.get("from")
                        origins = origin if isinstance(origin, list) else [origin]
                        destination = node.get("to")
                        for ref in origins:
                            if not (isinstance(ref, str)
                                    and isinstance(destination, str)):
                                continue
                            payload_movements.setdefault(
                                (ref, destination), set()).add(nid)
                            if (ref in node_ids and destination in node_ids
                                    and (ref, destination) not in moved_pairs):
                                errors.append(
                                    f"{path}: segment {nid} movement "
                                    f"{ref} -> {destination} has no "
                                    "moved_to edge (§10.2/§9.9)"
                                )
                        for ref in _as_list(node.get("via")):
                            if not isinstance(ref, str):
                                continue
                            # §10.2: material(part) via items derive via
                            # edges; artifact items derive produced_artifact.
                            if ref.startswith("artifact:"):
                                payload_produced.add((nid, ref))
                            else:
                                payload_via.add((nid, ref))
                            if ref not in node_ids:
                                continue
                            if ref.startswith("artifact:"):
                                if (nid, ref) not in produced_pairs:
                                    errors.append(
                                        f"{path}: segment {nid} artifact "
                                        f"{ref} has no produced_artifact "
                                        "edge (§10.2/§9.9)"
                                    )
                            elif (nid, ref) not in via_pairs:
                                errors.append(
                                    f"{path}: segment {nid} via {ref} has "
                                    "no via edge (§10.2/§9.9)"
                                )
                    for old_id in _as_list(node.get("formerly")):
                        if not isinstance(old_id, str):
                            continue
                        prefix = old_id.split(":", 1)[0]
                        if _builder.ID_PREFIXES.get(prefix) != node.get("type"):
                            errors.append(
                                f"{path}: formerly {old_id} on {nid} changes "
                                "kind (§34.4)"
                            )
                        if old_id in node_ids:
                            errors.append(
                                f"{path}: formerly {old_id} on {nid} is "
                                "still a living id (§34.4)"
                            )
                        survivor = formerly_survivors.get(old_id)
                        if survivor is not None:
                            errors.append(
                                f"{path}: retired id {old_id} redirects to "
                                f"both {survivor} and {nid} (§34.4)"
                            )
                        else:
                            formerly_survivors[old_id] = nid
                # §10.2/§10.4 reverse direction: reject a derived typed edge
                # no payload records — with the forward checks above, the
                # payload and the typed edges can never fork (§31.8).
                payload_backing = (
                    ("visited", payload_visits, "encounter target"),
                    ("has_part", payload_parts, "embedded part parent"),
                    ("moved_to", payload_movements, "trail segment movement"),
                    ("via", payload_via, "trail segment via item"),
                    ("produced_artifact", payload_produced,
                     "trail segment via item"),
                )
                for index, edge in enumerate(_as_list(instance.get("edges"))):
                    if not isinstance(edge, dict):
                        continue
                    pair = (edge.get("source"), edge.get("target"))
                    if not all(isinstance(ref, str) for ref in pair):
                        continue
                    for etype, backing, noun in payload_backing:
                        if edge.get("type") == etype and pair not in backing:
                            errors.append(
                                f"{path}: edges[{index}] {etype} {pair[0]} "
                                f"-> {pair[1]} is not backed by a {noun} "
                                "(§10.2/§10.4)"
                            )
                    if edge.get("type") in ("primary_for", "supporting_for"):
                        role, src, tgt = edge["type"], pair[0], pair[1]
                        prov = {ref for ref in _as_list(edge.get("provenance"))
                                if isinstance(ref, str)}
                        if tgt.startswith("suggested-route:"):
                            # §11.1: route roles are authored on the route.
                            if prov and tgt not in prov:
                                errors.append(
                                    f"{path}: edges[{index}] {role} "
                                    f"provenance must include the authoring "
                                    f"route {tgt} (§10.3/§11.1)"
                                )
                        elif tgt.startswith("question:"):
                            # §11.2: derived from encounters citing the
                            # question — deep use (applied|taught) folds
                            # primary, else supporting.
                            citing = {
                                eid for eid, row in encounter_rows.items()
                                if row[0] == src and row[2] == tgt}
                            if not citing:
                                errors.append(
                                    f"{path}: edges[{index}] {role} {src} -> "
                                    f"{tgt} is not backed by an encounter "
                                    "citing the question (§11.2)"
                                )
                                continue
                            deep = any(
                                encounter_rows[eid][1] in ("applied", "taught")
                                for eid in citing)
                            expected = "primary_for" if deep else "supporting_for"
                            if role != expected:
                                errors.append(
                                    f"{path}: edges[{index}] {role} {src} -> "
                                    f"{tgt} — the citing encounters fold "
                                    f"{expected} (§11.2)"
                                )
                            if prov and not (prov & citing):
                                errors.append(
                                    f"{path}: edges[{index}] {role} "
                                    "provenance names no deriving encounter "
                                    "(§10.3/§11.2)"
                                )
                        elif tgt.startswith("trail-segment:"):
                            # §11.3: via materials fold primary; the target
                            # of an encounter citing one of the segment's
                            # via artifacts, not itself in via, supporting.
                            if role == "primary_for":
                                if (tgt, src) not in payload_via:
                                    errors.append(
                                        f"{path}: edges[{index}] primary_for "
                                        f"{src} -> {tgt} is not backed by "
                                        "the segment's via (§11.3)"
                                    )
                                elif prov and tgt not in prov:
                                    errors.append(
                                        f"{path}: edges[{index}] primary_for "
                                        f"provenance must include the "
                                        f"recording segment {tgt} "
                                        "(§10.3/§11.3)"
                                    )
                            else:
                                if (tgt, src) in payload_via:
                                    errors.append(
                                        f"{path}: edges[{index}] "
                                        f"supporting_for {src} -> {tgt} — a "
                                        "via material folds primary (§11.3)"
                                    )
                                    continue
                                citing = {
                                    eid for eid, row in encounter_rows.items()
                                    if row[0] == src and row[3] is not None
                                    and (tgt, row[3]) in payload_produced}
                                if not citing:
                                    errors.append(
                                        f"{path}: edges[{index}] "
                                        f"supporting_for {src} -> {tgt} is "
                                        "not backed by an encounter citing "
                                        "a via artifact (§11.3)"
                                    )
                                elif prov and not (
                                        tgt in prov and prov & citing):
                                    errors.append(
                                        f"{path}: edges[{index}] "
                                        "supporting_for provenance must list "
                                        "the segment and a deriving "
                                        "encounter (§10.3/§11.3)"
                                    )
                    if (edge.get("type") == "moved_to"
                            and pair in payload_movements):
                        # §10.3: the derivation basis is the recording row —
                        # naming another segment misattributes the movement.
                        prov = {ref for ref in _as_list(edge.get("provenance"))
                                if isinstance(ref, str)}
                        if prov and not (prov & payload_movements[pair]):
                            errors.append(
                                f"{path}: edges[{index}] moved_to provenance "
                                f"names no segment recording {pair[0]} -> "
                                f"{pair[1]} (§9.9/§10.3)"
                            )
                    if (edge.get("type") == "suggested_next"
                            and isinstance(edge.get("context"), str)):
                        orders = step_orders.get(edge["context"], {})
                        if pair not in {
                            (orders[k], orders[k + 1])
                            for k in orders if k + 1 in orders
                        }:
                            errors.append(
                                f"{path}: edges[{index}] suggested_next "
                                f"{pair[0]} -> {pair[1]} is not a "
                                f"consecutive step pair of "
                                f"{edge['context']} (§10.2)"
                            )
                # §10/§32.1: projections are the curated zone → figure_region
                # mapping; the schema subset cannot constrain map keys, so
                # the zone-id shape of each key is checked here (values are
                # the schema's figure_region slug pattern).
                for key in _as_dict(instance.get("projections")):
                    if not _ZONE_ID_RE.fullmatch(key):
                        errors.append(
                            f"{path}: projections key {key!r} is not a "
                            "zone id (§10/§32.1)"
                        )
                # §20 step 12: every emitted zone carries its curated
                # figure_region — a zone the silhouette cannot place never
                # leaves the build.
                for zone_id in sorted(
                        zone_ids - set(_as_dict(instance.get("projections")))):
                    errors.append(
                        f"{path}: zone {zone_id} has no projections entry "
                        "(§20 step 12, §32.1)"
                    )
                redacted = filename.endswith(".redacted.json")
                if redacted and "withheld" not in instance:
                    errors.append(
                        f"{path}: the redacted graph must carry withheld (§20)"
                    )
                if not redacted and "withheld" in instance:
                    errors.append(
                        f"{path}: the full graph never carries withheld (§20)"
                    )
            counts["emitted"] += 1
        except JsonInputError as exc:
            errors.append(str(exc))
    return errors, warnings, counts


def _resolved(schema: dict, value: dict):
    while "$ref" in value:
        target = SchemaValidator(schema).resolve(value["$ref"])
        value = {**target, **{key: item for key, item in value.items() if key != "$ref"}}
    return value


def check_constants():
    schemas, errors = _load_registry()
    if errors:
        return errors
    import build_atlas_graph as builder

    graph = schemas["atlas-graph"]
    defs = graph["$defs"]
    schema_endpoints = {}
    endpoint_properties = defs["endpointRules"]["properties"]
    for edge_type, edge_schema in endpoint_properties.items():
        resolved = _resolved(graph, edge_schema)
        source = resolved["properties"]["source"]["enum"]
        target = resolved["properties"]["target"]["enum"]
        schema_endpoints[edge_type] = (set(source), set(target))
    schema_prefixes = {
        key: value["const"] for key, value in defs["idPrefixes"]["properties"].items()
    }
    checks = (
        ("NODE_TYPES", set(builder.NODE_TYPES), "schema $defs.nodeType", set(defs["nodeType"]["enum"])),
        ("EDGE_TYPES", set(builder.EDGE_TYPES), "schema $defs.edgeType", set(defs["edgeType"]["enum"])),
        ("AUTHORED_ROLES", set(builder.AUTHORED_ROLES), "schema $defs.authoredRole", set(defs["authoredRole"]["enum"])),
        ("ENDPOINT_RULES", builder.ENDPOINT_RULES, "schema $defs.endpointRules", schema_endpoints),
        ("EDGE_WEIGHTS", set(builder.EDGE_WEIGHTS), "schema $defs.edgeWeight", set(defs["edgeWeight"]["enum"])),
        ("LIFECYCLE_STATUSES", set(builder.LIFECYCLE_STATUSES), "schema $defs.lifecycleStatus", set(defs["lifecycleStatus"]["enum"])),
        ("MATERIAL_KINDS", set(builder.MATERIAL_KINDS), "schema $defs.materialKind", set(defs["materialKind"]["enum"])),
        ("ROUTE_STATUSES", set(builder.ROUTE_STATUSES), "schema $defs.routeStatus", set(defs["routeStatus"]["enum"])),
        ("ID_PREFIXES", builder.ID_PREFIXES, "schema $defs.idPrefixes", schema_prefixes),
    )
    for code_name, code_value, schema_name, schema_value in checks:
        if code_value != schema_value:
            errors.append(
                f"build_atlas_graph.py {code_name}={code_value!r} does not match "
                f"{schema_name}={schema_value!r}"
            )
    return errors


def _padding_lines(size: int) -> bytes:
    parts = []
    while size:
        if size == 1:
            parts.append(b"\n")
            break
        take = min(size, MAX_LINE_BYTES + 1)
        if size - take == 1:
            take -= 1
        parts.append(b"#" + b"x" * (take - 2) + b"\n")
        size -= take
    return b"".join(parts)


def _sized_fenced(total: int) -> bytes:
    start = b"---\nx: y\n"
    end = b"---\n"
    return start + _padding_lines(total - len(start) - len(end)) + end


def _folded_scalar(size: int) -> bytes:
    remaining = size - 2
    lengths = [min(4_094, remaining), min(4_094, max(0, remaining - 4_094))]
    lengths.append(remaining - sum(lengths))
    body = b"x: >\n" + b"".join(b"  " + b"x" * length + b"\n" for length in lengths)
    return b"---\n" + body + b"---\n"


def _nested(depth: int) -> bytes:
    lines = []
    for index in range(depth):
        suffix = " x" if index == depth - 1 else ""
        lines.append("  " * index + f"a{index}:{suffix}\n")
    return ("---\n" + "".join(lines) + "---\n").encode()


def _fields(count: int) -> bytes:
    body = "".join(f"f{index}: x\n" for index in range(count))
    return ("---\n" + body + "---\n").encode()


def _sequence(count: int) -> bytes:
    body = "items:\n" + "  - x\n" * count
    return ("---\n" + body + "---\n").encode()


def _node_case(over: bool):
    full_sequences = 15
    final_entries = (
        MAX_NODES
        - 1
        - full_sequences * (1 + MAX_SEQUENCE_ENTRIES)
        - 1
        + int(over)
    )
    values = [MAX_SEQUENCE_ENTRIES] * full_sequences + [final_entries]
    parsed = {}
    lines = []
    for index, count in enumerate(values):
        key = f"s{index}"
        parsed[key] = ["x"] * count
        lines.append(f"{key}:\n")
        lines.extend("  - x\n" for _ in range(count))
    return ("---\n" + "".join(lines) + "---\n").encode(), parsed


def _generated_case(name: str):
    valid = b"---\nx: y\n---\n"
    cases = {
        "bom": (b"\xef\xbb\xbf" + valid, None),
        "crlf": (valid.replace(b"\n", b"\r\n"), None),
        "invalid-utf8": (b"---\nx: \xff\n---\n", None),
        "tab": (b"---\nx:\n\t- y\n---\n", None),
        "nul": (b"---\nx: a\x00b\n---\n", None),
        "c0": (b"---\nx: a\x01b\n---\n", None),
        "document-at-limit": (_sized_fenced(MAX_DOCUMENT_BYTES), {"x": "y"}),
        "document-over-limit": (_sized_fenced(MAX_DOCUMENT_BYTES + 1), None),
        "file-at-limit": (valid + b"x" * (MAX_FILE_BYTES - len(valid)), {"x": "y"}),
        "file-over-limit": (valid + b"x" * (MAX_FILE_BYTES + 1 - len(valid)), None),
        "line-at-limit": (b"---\nx: " + b"x" * (MAX_LINE_BYTES - 3) + b"\n---\n", {"x": "x" * (MAX_LINE_BYTES - 3)}),
        "line-over-limit": (b"---\nx: " + b"x" * (MAX_LINE_BYTES - 2) + b"\n---\n", None),
        "scalar-at-limit": (_folded_scalar(MAX_SCALAR_BYTES), {"x": "x" * 4_094 + " " + "x" * 4_094 + " " + "x" * 2}),
        "scalar-over-limit": (_folded_scalar(MAX_SCALAR_BYTES + 1), None),
        "depth-at-limit": (_nested(8), {"a0": {"a1": {"a2": {"a3": {"a4": {"a5": {"a6": {"a7": "x"}}}}}}}}),
        "depth-over-limit": (_nested(9), None),
        "fields-at-limit": (_fields(64), {f"f{index}": "x" for index in range(64)}),
        "fields-over-limit": (_fields(65), None),
        "sequence-at-limit": (_sequence(1_024), {"items": ["x"] * 1_024}),
        "sequence-over-limit": (_sequence(1_025), None),
    }
    if name == "nodes-at-limit":
        return _node_case(False)
    if name == "nodes-over-limit":
        return _node_case(True)[0], None
    return cases[name]


def run_conformance():
    errors: list[str] = []
    count = 0
    accept = GRAMMAR_DIR / "accept"
    reject = GRAMMAR_DIR / "reject"
    for path in sorted(accept.glob("*.fm")):
        expected_path = path.with_suffix(".json")
        try:
            expected = _read_json(expected_path)
            actual = parse_frontmatter(path.read_bytes(), path)
            if actual != expected:
                errors.append(f"{path}: parsed {actual!r}, expected {expected!r}")
        except (FrontmatterError, JsonInputError) as exc:
            errors.append(str(exc))
        count += 1
    for path in sorted(reject.glob("*.fm")):
        try:
            parse_frontmatter(path.read_bytes(), path)
            errors.append(f"{path}: reject fixture unexpectedly parsed")
        except FrontmatterError:
            pass
        count += 1
    manifest_path = GRAMMAR_DIR / "generated.json"
    try:
        manifest = _read_json(manifest_path)
    except JsonInputError as exc:
        return [str(exc)], count
    for entry in manifest:
        data, expected = _generated_case(entry["generator"])
        source = f"generated:{entry['generator']}"
        try:
            actual = parse_frontmatter(data, source)
            if entry["mode"] == "reject":
                errors.append(f"{source}: reject fixture unexpectedly parsed")
            elif actual != expected:
                errors.append(f"{source}: parsed object differs from expected")
        except FrontmatterError:
            if entry["mode"] == "accept":
                errors.append(f"{source}: accept fixture was rejected")
        count += 1
    return errors, count


def _emit_diagnostics(errors: list[str], warnings: list[str] | None = None):
    for warning in warnings or []:
        print(f"WARNING: {warning.replace(chr(10), ' ')}", file=sys.stderr)
    for error in errors:
        print(f"ERROR: {error.replace(chr(10), ' ')}", file=sys.stderr)


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("ERROR: usage: validate_atlas.py validate INSTANCE_ROOT | check-constants | conformance", file=sys.stderr)
        return 2
    command, rest = args[0], args[1:]
    if command == "validate" and len(rest) == 1:
        errors, warnings, counts = validate_instance(Path(rest[0]).resolve())
        _emit_diagnostics(errors, warnings)
        print(
            f"validated: {counts['frontmatter']} frontmatter documents, "
            f"{counts['rows']} journal rows, {counts['intake']} intake batches, "
            f"{counts['emitted']} emitted files; "
            f"{len(errors)} errors, {len(warnings)} warnings"
        )
        return 1 if errors else 0
    if command == "check-constants" and not rest:
        errors = check_constants()
        _emit_diagnostics(errors)
        print(f"checked constants: {len(errors)} errors")
        return 1 if errors else 0
    if command == "conformance" and not rest:
        errors, count = run_conformance()
        _emit_diagnostics(errors)
        print(f"conformance: {count} cases, {len(errors)} errors")
        return 1 if errors else 0
    print("ERROR: usage: validate_atlas.py validate INSTANCE_ROOT | check-constants | conformance", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
