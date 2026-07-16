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
JOURNAL_ROW_BYTES = 16_384

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
_MATERIAL_ID_RE = re.compile(rf"^(?:material:{_SLUG}|part:{_SLUG}/{_SLUG})$")



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
        if not (isinstance(key, str) and key.startswith(_EVIDENCE_PREFIXES)):
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
        for ref in refs or []:
            if (isinstance(ref, str) and ref.startswith(_EVIDENCE_PREFIXES)
                    and ref not in known):
                errors.append(
                    f"{path}: {where} cites {ref}, absent from evidence_refs (§33.4)"
                )

    for node, entry in _as_dict(snapshot.get("state")).items():
        if isinstance(entry, dict):
            check(entry.get("evidence"), f"state.{node}.evidence")
            for index, decision in enumerate(entry.get("decisions") or []):
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
_ALL_STATE_DIMENSIONS = set().union(*_STATE_DIMENSIONS.values())
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
        for index, decision in enumerate(entry.get("decisions") or []):
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
                # §9.4: each material_roles entry names a member of steps —
                # the step discriminator must be part of the route.
                if schema_name == "suggested-route" and isinstance(instance, dict):
                    steps = instance.get("steps")
                    members = set(steps) if isinstance(steps, list) else set()
                    for index, role in enumerate(instance.get("material_roles") or []):
                        if not isinstance(role, dict):
                            continue
                        step = role.get("step")
                        if isinstance(step, str) and step not in members:
                            errors.append(
                                f"{path}: material_roles[{index}].step {step} "
                                "is not a member of steps (§9.4)"
                            )
                        # §9.4: per step the two lists are disjoint — the
                        # same material in both is an error (§20.3).
                        primary = role.get("primary_materials") or []
                        supporting = role.get("supporting_materials") or []
                        for shared in sorted(set(primary) & set(supporting)):
                            errors.append(
                                f"{path}: material_roles[{index}] lists "
                                f"{shared} as both primary and supporting "
                                "(§9.4)"
                            )
                # §10.1: an embedded part id carries its material's slug.
                if schema_name == "material" and isinstance(instance, dict):
                    material_id = instance.get("id")
                    slug = (material_id.split(":", 1)[1]
                            if isinstance(material_id, str) and ":" in material_id
                            else None)
                    for index, part in enumerate(instance.get("parts") or []):
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
                # §10: edge endpoints are node ids consumers resolve inside
                # the same file — a dangling endpoint never leaves the build.
                node_ids: set = set()
                for node in instance.get("nodes") or []:
                    if not isinstance(node, dict):
                        continue
                    node_id = node.get("id")
                    if node_id in node_ids:
                        errors.append(
                            f"{path}: duplicate node id {node_id} (§10.1)"
                        )
                    node_ids.add(node_id)
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
                for index, edge in enumerate(instance.get("edges") or []):
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
                    for ref in edge.get("provenance") or []:
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
