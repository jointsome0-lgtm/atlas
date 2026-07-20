#!/usr/bin/env python3
"""Append one explicitly authored journal row (§13.2/§33.2/§12.4, #47)."""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import atlas_io
import process_intake


# Measured-floor corpus (scripts/test_append_record.py): three realistic dense
# Vera Example journal rows. Raw maxima were 1,152 record-file bytes, 768
# string bytes, and depth 2. Values are ~10x headroom rounded to the
# §20.4/§25.8 family (depth follows §20.4's fixed ceiling of 8).
MANUAL_RECORD_BYTES = 16_384
MANUAL_STRING_BYTES = 8_192
MANUAL_NESTING_DEPTH = 8

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_REPORT_ID_RE = re.compile(
    r"^(?:artifact|encounter|question):[a-z0-9]+(?:-[a-z0-9]+)*$"
)
_RESULT_CLASSES = (
    "applied",
    "replayed",
    "unresolved",
    "unsupported",
    "rejected",
    "interrupted",
    "conflict",
)
_ROUTES = {
    "encounter": "state/encounters.jsonl",
    "artifact": "state/artifacts.jsonl",
    "question": "state/questions.jsonl",
}
_DATES = {
    "encounter": "date",
    "artifact": "observed_at",
    "question": "created_at",
}
# Every id-bearing journal field is resolved, including the fields named by
# the manual-lane contract and the artifact schema's two additional id fields.
_REFERENCE_FIELDS = {
    "encounter": ("target", "context"),
    "artifact": ("touches", "supports_state_updates", "probe"),
    "question": ("pulls", "source"),
}


@dataclass(frozen=True)
class Arguments:
    root: str
    record_file: str
    key: str | None
    commit: bool


@dataclass(frozen=True)
class Prepared:
    kind: str
    destination: str
    row: dict
    date: str


class ManualFailure(RuntimeError):
    """One report-shaped, content-free refusal."""

    def __init__(
        self,
        classification: str,
        reason: str,
        pointer: str = "/records/0",
    ):
        self.classification = classification
        self.reason = reason
        self.pointer = pointer
        super().__init__(reason)


class ManualRuntimeFailure(RuntimeError):
    """A content-free failure that has no report-batch reason code."""


class InjectedCrash(ManualRuntimeFailure):
    pass


def _help() -> int:
    print(
        "usage: append_record.py INSTANCE_ROOT --record-file PATH "
        "[--key KEY] [--commit]\n"
        "\n"
        "Validate one authored encounter, artifact, or question row. "
        "Dry-run is the default.\n"
        "--commit requires --key; prefer a §34.6 date-serial key such as "
        "2026-07-20-001."
    )
    return 0


def _usage() -> int:
    print(
        "ERROR: usage: append_record.py INSTANCE_ROOT --record-file PATH "
        "[--key KEY] [--commit]",
        file=sys.stderr,
    )
    print(
        "ERROR: key: use a §34.6 date-serial slug such as 2026-07-20-001",
        file=sys.stderr,
    )
    return 2


def _parse_args(args: list[str]) -> Arguments | None:
    if not args or args[0].startswith("-") or not args[0]:
        return None
    root = args[0]
    record_file = None
    key = None
    commit = False
    index = 1
    while index < len(args):
        option = args[index]
        if option == "--commit":
            if commit:
                return None
            commit = True
            index += 1
            continue
        if option not in {"--record-file", "--key"} or index + 1 >= len(args):
            return None
        value = args[index + 1]
        if not value or value.startswith("-"):
            return None
        if option == "--record-file":
            if record_file is not None:
                return None
            record_file = value
        else:
            if key is not None or _SLUG_RE.fullmatch(value) is None:
                return None
            key = value
        index += 2
    if record_file is None or (commit and key is None):
        return None
    return Arguments(root, record_file, key, commit)


def _refuse_lexical_traversal(path: str, reason: atlas_io.ReasonCode) -> None:
    try:
        parts = Path(path).parts
    except (TypeError, ValueError):
        parts = ("..",)
    if ".." in parts:
        raise atlas_io.AtlasIOError(atlas_io.Diagnostic(reason=reason))


def _encoded(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _maximum_depth(value: object) -> int:
    maximum = 0
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            maximum = max(maximum, depth + 1)
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            maximum = max(maximum, depth + 1)
            stack.extend((item, depth + 1) for item in current)
    return maximum


def _string_sizes(value: object):
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            yield len(current.encode("utf-8"))
        elif isinstance(current, dict):
            for name, item in current.items():
                yield len(name.encode("utf-8"))
                stack.append(item)
        elif isinstance(current, list):
            stack.extend(current)


def _enforce_structure(value: object) -> None:
    for size in _string_sizes(value):
        atlas_io.enforce_ceiling(
            size,
            maximum=MANUAL_STRING_BYTES,
            kind="bytes",
            relative_path="record-file",
        )
    atlas_io.enforce_ceiling(
        _maximum_depth(value),
        maximum=MANUAL_NESTING_DEPTH,
        kind="count",
        relative_path="record-file",
    )


def _route(value: object) -> tuple[str, str]:
    if not isinstance(value, Mapping):
        raise ManualFailure("rejected", "schema-invalid")
    node_id = value.get("id")
    if not isinstance(node_id, str):
        raise ManualFailure("rejected", "schema-invalid", "/records/0/id")
    kind = node_id.split(":", 1)[0] if ":" in node_id else ""
    destination = _ROUTES.get(kind)
    if destination is None:
        raise ManualFailure("rejected", "schema-invalid", "/records/0/id")
    return kind, destination


def _pointer_from_schema_error(error: str) -> str:
    path = error.split(":", 1)[0]
    pointer = "/records/0"
    for field, position in re.findall(r"\.([A-Za-z0-9_]+)|\[([0-9]+)\]", path):
        pointer += "/" + (field or position)
    return pointer


def _resolve_value(value: object, known: dict[str, str], pointer: str):
    if isinstance(value, str):
        resolved = known.get(value)
        if resolved is None:
            raise ManualFailure("unresolved", "unresolved-reference", pointer)
        return resolved
    if isinstance(value, list):
        return [
            _resolve_value(item, known, f"{pointer}/{index}")
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        return {
            name: _resolve_value(item, known, f"{pointer}/{name}")
            for name, item in value.items()
        }
    # The closed journal schema prevents this path; retaining it here keeps
    # resolution fail-closed if a caller changes validation order later.
    raise ManualFailure("rejected", "schema-invalid", pointer)


def _resolve_references(kind: str, row: dict, known: dict[str, str]) -> dict:
    resolved = dict(row)
    for field in _REFERENCE_FIELDS[kind]:
        if field in resolved:
            resolved[field] = _resolve_value(
                resolved[field], known, f"/records/0/{field}"
            )
    return resolved


def _normalized_references(kind: str, row: dict, known: dict[str, str]) -> dict:
    def normalize(value: object):
        if isinstance(value, str):
            return known.get(value, value)
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {name: normalize(item) for name, item in value.items()}
        return value

    fields = set(_REFERENCE_FIELDS[kind])
    return {
        name: normalize(value) if name in fields else value
        for name, value in row.items()
    }


def _replay_matches(
    expected: Prepared,
    recorded: tuple[str, dict] | None,
    known: dict[str, str],
) -> bool:
    if recorded is None:
        return False
    kind, durable = recorded
    return (
        kind == expected.kind
        and _normalized_references(kind, expected.row, known)
        == _normalized_references(kind, durable, known)
    )


def _result(
    key: str,
    classification: str,
    reason: str,
    pointer: str,
    node_id: str | None,
) -> dict:
    result = {
        "index": 0,
        "intake": key,
        "class": classification,
        "pointer": pointer,
        "reason": reason,
    }
    if node_id is not None and _REPORT_ID_RE.fullmatch(node_id):
        result["id"] = node_id
    return result


def _report(batch: str, result: dict) -> dict:
    counts = {name: 0 for name in _RESULT_CLASSES}
    counts[result["class"]] = 1
    return {
        "format": "report-batch",
        "version": 1,
        "source": "manual",
        "batch": batch,
        "records": [result],
        "counts": {"total": 1, **counts},
    }


def _emit_report(instance: atlas_io.AtlasInstance, report: dict) -> None:
    instance.validate_format(report)
    print(_encoded(report).decode("utf-8"))


def _emit_failure(failure: ManualFailure | ManualRuntimeFailure) -> None:
    if isinstance(failure, ManualFailure):
        print(
            f"ERROR: record-file: {failure.reason}; pointer {failure.pointer}",
            file=sys.stderr,
        )
    else:
        print(f"ERROR: instance: {failure}", file=sys.stderr)


def _prepared(
    instance: atlas_io.AtlasInstance,
    value: object,
    kind: str,
    destination: str,
    receipt_key: str | None,
) -> tuple[Prepared, dict | None]:
    row = dict(value)
    if "intake" in row:
        raise ManualFailure("rejected", "schema-invalid", "/records/0/intake")
    if receipt_key is not None:
        row["intake"] = receipt_key

    errors = instance.schema_errors(row, f"journal-{kind}")
    if errors:
        raise ManualFailure(
            "rejected", "schema-invalid", _pointer_from_schema_error(errors[0])
        )
    try:
        encoded = _encoded(row)
    except (TypeError, ValueError):
        raise ManualFailure("rejected", "schema-invalid") from None
    try:
        atlas_io.enforce_ceiling(
            len(encoded),
            maximum=atlas_io.JOURNAL_ROW_BYTES,
            kind="bytes",
            relative_path=destination,
        )
    except atlas_io.AtlasIOError:
        raise ManualFailure("rejected", "derived-row-too-large") from None

    process_intake._preflight_tree(instance)
    receipt_status = instance.receipt_status()
    outputs = process_intake._journal_outputs(instance)
    withheld = {
        outputs[key][1]["id"]
        for key in receipt_status.interrupted
        if key in outputs and isinstance(outputs[key][1].get("id"), str)
    }
    try:
        known = process_intake._load_known_ids(instance, withheld)
    except process_intake.IntakeFailure as exc:
        raise ManualRuntimeFailure(exc.reason) from exc

    row = _resolve_references(kind, row, known)
    prepared = Prepared(kind, destination, row, row[_DATES[kind]])
    try:
        atlas_io.enforce_ceiling(
            len(_encoded(row)),
            maximum=atlas_io.JOURNAL_ROW_BYTES,
            kind="bytes",
            relative_path=destination,
        )
    except atlas_io.AtlasIOError:
        raise ManualFailure("rejected", "derived-row-too-large") from None

    if receipt_key is not None and receipt_key in receipt_status.processed:
        if not _replay_matches(prepared, outputs.get(receipt_key), known):
            raise ManualFailure("conflict", "batch-content-conflict")
        return prepared, _result(
            receipt_key,
            "replayed",
            "processed-receipt",
            "/records/0",
            row.get("id"),
        )
    if receipt_key is not None and receipt_key in receipt_status.interrupted:
        raise ManualFailure("interrupted", "interrupted-receipt")
    if row["id"] in known:
        raise ManualFailure("conflict", "id-conflict")
    return prepared, None


def _crash(point: str) -> None:
    if os.environ.get("ATLAS_MANUAL_CRASH") == f"{point}:0":
        raise InjectedCrash("injected-crash")


def _headers(
    instance: atlas_io.AtlasInstance,
    destination: str,
    receipt_key: str | None,
) -> None:
    print(f"instance: {instance.root}", flush=True)
    print(f"destination: {destination}", flush=True)
    print(
        f"backup: {'git' if (instance.root / '.git').exists() else 'none'}",
        flush=True,
    )
    if receipt_key is not None:
        print(f"key: {receipt_key}", flush=True)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args in (["--help"], ["-h"]):
        return _help()
    parsed = _parse_args(args)
    if parsed is None:
        return _usage()

    instance = None
    value = None
    node_id = None
    receipt_key = None
    kind = None
    destination = None
    try:
        _refuse_lexical_traversal(
            parsed.root, atlas_io.ReasonCode.INVALID_ROOT
        )
        _refuse_lexical_traversal(
            parsed.record_file, atlas_io.ReasonCode.UNSAFE_PATH
        )
        instance = atlas_io.AtlasInstance(parsed.root)
        delivered = instance.read_delivered_json(
            parsed.record_file,
            max_bytes=MANUAL_RECORD_BYTES,
            delivered=False,
        )
        value = delivered.value
        _enforce_structure(value)
        if isinstance(value, Mapping):
            node_id = value.get("id")
        kind, destination = _route(value)
        if parsed.key is not None:
            receipt_key = atlas_io.make_receipt_key("manual", parsed.key, 0)
        _headers(instance, destination, receipt_key)

        if parsed.commit:
            with instance.lock():
                prepared, outcome = _prepared(
                    instance, value, kind, destination, receipt_key
                )
                if outcome is None:
                    _crash("before-opened")
                    instance.append_receipt(receipt_key, "opened", prepared.date)
                    _crash("after-opened")
                    instance.append_record(prepared.destination, prepared.row)
                    _crash("after-output")
                    _crash("before-processed")
                    instance.append_receipt(
                        receipt_key, "processed", prepared.date
                    )
                    outcome = _result(
                        receipt_key,
                        "applied",
                        "applied",
                        "/records/0",
                        prepared.row["id"],
                    )
            report = _report(parsed.key, outcome)
            _emit_report(instance, report)
            return 0

        _prepared_row, outcome = _prepared(
            instance, value, kind, destination, receipt_key
        )
        if outcome is not None:
            _emit_report(instance, _report(parsed.key, outcome))
            return 0
        print("result: valid")
        return 0
    except ManualFailure as exc:
        _emit_failure(exc)
        if instance is not None and parsed.key is not None:
            key = receipt_key or atlas_io.make_receipt_key("manual", parsed.key, 0)
            report = _report(
                parsed.key,
                _result(
                    key,
                    exc.classification,
                    exc.reason,
                    exc.pointer,
                    node_id if isinstance(node_id, str) else None,
                ),
            )
            _emit_report(instance, report)
        return 1
    except ManualRuntimeFailure as exc:
        _emit_failure(exc)
        return 1
    except atlas_io.AtlasIOError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (OSError, TypeError, ValueError, KeyError):
        print(
            "ERROR: instance: processing-failed; expected a complete "
            "deterministic manual append",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
