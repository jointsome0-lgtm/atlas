#!/usr/bin/env python3
"""Deterministically apply one versioned Atlas intake batch (§33.2, #56)."""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import atlas_io
import build_atlas_graph
import validate_atlas


# Measured-floor corpus (scripts/test_process_intake.py): the Vera Example
# fixture plus 1,000 dense realistic artifact records.  Raw maxima were
# 1,257,100 batch bytes, 1,000 records, 1,256 record bytes, 768 string bytes,
# and depth 5.  Values are ~10x headroom rounded to the §20.4/§25.8 family
# (depth follows §20.4's fixed ceiling of 8).
INTAKE_BATCH_BYTES = 16_777_216
INTAKE_RECORDS = 16_384
INTAKE_RECORD_BYTES = 16_384
INTAKE_STRING_BYTES = 8_192
INTAKE_NESTING_DEPTH = 8

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_RESULT_CLASSES = (
    "applied",
    "replayed",
    "unresolved",
    "unsupported",
    "rejected",
    "interrupted",
    "conflict",
)
_RECORD_DEFINITIONS = {
    "encounter": "encounterRecord",
    "artifact": "artifactRecord",
    "question": "questionRecord",
    "plan": "planRecord",
}
_JOURNALS = {
    "encounter": "state/encounters.jsonl",
    "artifact": "state/artifacts.jsonl",
    "question": "state/questions.jsonl",
}
_REGION_KINDS = {"concept", "pattern", "zone"}
_MATERIAL_KINDS = {"material", "part"}
_SOURCE_KINDS = {"artifact", "encounter"}


class IntakeFailure(RuntimeError):
    """A bounded content-free flow failure."""

    def __init__(self, reason: str, relative_path: str = "intake"):
        self.reason = reason
        self.relative_path = relative_path
        super().__init__(reason)


class InjectedCrash(IntakeFailure):
    pass


@dataclass(frozen=True)
class Placement:
    classification: str
    reason: str
    pointer: str
    row: dict | None = None


def _usage() -> int:
    print(
        "ERROR: usage: process_intake.py INSTANCE_ROOT "
        "(--batch-file PATH | --batch SOURCE/BATCH-ID)",
        file=sys.stderr,
    )
    return 2


def _parse_args(args: list[str]) -> tuple[str, str, str] | None:
    if len(args) != 3 or args[1] not in {"--batch-file", "--batch"}:
        return None
    if not args[0] or not args[2]:
        return None
    if args[1] == "--batch":
        parts = args[2].split("/")
        if len(parts) != 2 or not all(_SLUG_RE.fullmatch(part) for part in parts):
            return None
    return args[0], args[1], args[2]


def _encoded(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _maximum_depth(value: object) -> int:
    """Count nested JSON containers; scalars do not add another level."""

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
            for key, item in current.items():
                yield len(key.encode("utf-8"))
                stack.append(item)
        elif isinstance(current, list):
            stack.extend(current)


def _enforce_batch_structure(batch: Mapping[str, object], display: str) -> None:
    records = batch["records"]
    atlas_io.enforce_ceiling(
        len(records), maximum=INTAKE_RECORDS, kind="count", relative_path=display
    )
    for index, record in enumerate(records):
        atlas_io.enforce_ceiling(
            len(_encoded(record)),
            maximum=INTAKE_RECORD_BYTES,
            kind="bytes",
            relative_path=f"{display}#{index}",
        )
    for size in _string_sizes(batch):
        atlas_io.enforce_ceiling(
            size,
            maximum=INTAKE_STRING_BYTES,
            kind="bytes",
            relative_path=display,
        )
    atlas_io.enforce_ceiling(
        _maximum_depth(batch),
        maximum=INTAKE_NESTING_DEPTH,
        kind="count",
        relative_path=display,
    )


def _minted_id(kind: object, source: str, batch: str, index: int) -> str | None:
    if not isinstance(kind, str) or kind not in _JOURNALS:
        return None
    # The trailing source segment count keeps minting injective: slugs may
    # contain hyphens, so "a-b"/"c" and "a"/"b-c" would otherwise collapse
    # into one id while their receipt keys stay distinct.
    segments = source.count("-") + 1
    return f"{kind}:{source}-{batch}-{index}-{segments}"


def _pointer_from_schema_error(error: str, index: int) -> str:
    path = error.split(":", 1)[0]
    pointer = f"/records/{index}"
    for field, position in re.findall(r"\.([A-Za-z0-9_]+)|\[([0-9]+)\]", path):
        pointer += "/" + (field or position)
    return pointer


def _result(
    index: int,
    key: str,
    classification: str,
    reason: str,
    pointer: str,
    minted_id: str | None,
) -> dict:
    value = {
        "index": index,
        "intake": key,
        "class": classification,
        "pointer": pointer,
        "reason": reason,
    }
    if minted_id is not None:
        value["id"] = minted_id
    return value


def _kind(node_id: str) -> str:
    return node_id.split(":", 1)[0]


def _resolve_reference(reference: Mapping[str, object], known: dict[str, str]):
    if set(reference) != {"id"}:
        return None
    node_id = reference["id"]
    if not isinstance(node_id, str):
        return None
    return known.get(node_id)


def _with_sensitivity(row: dict, record: dict, envelope: dict) -> dict:
    sensitivity = record.get("sensitivity", envelope.get("sensitivity"))
    if sensitivity is not None:
        row["sensitivity"] = sensitivity
    return row


def _place_record(
    record: dict,
    envelope: dict,
    known: dict[str, str],
    key: str,
    minted_id: str,
    index: int,
) -> Placement:
    pointer = f"/records/{index}"
    kind = record["kind"]
    if kind == "plan":
        return Placement("unsupported", "unsupported-plan", pointer)

    if kind == "encounter":
        resolved = _resolve_reference(record["target"], known)
        if resolved is None:
            return Placement("unresolved", "unresolved-reference", pointer + "/target")
        if _kind(resolved) not in _MATERIAL_KINDS:
            return Placement(
                "unsupported", "unsupported-target-kind", pointer + "/target"
            )
        row = {
            "id": minted_id,
            "date": record["date"],
            "target": resolved,
            "depth": record["depth"],
            "mode": "background",
            "intake": key,
        }
        return Placement(
            "applied", "applied", pointer,
            _with_sensitivity(row, record, envelope),
        )

    refs = record.get("refs", [])
    resolved_refs: list[str] = []
    for ref_index, reference in enumerate(refs):
        resolved = _resolve_reference(reference, known)
        if resolved is None:
            return Placement(
                "unresolved",
                "unresolved-reference",
                f"{pointer}/refs/{ref_index}",
            )
        resolved_refs.append(resolved)

    if kind == "artifact":
        if "evidence_strength" not in record:
            return Placement(
                "unsupported", "missing-evidence-strength", pointer
            )
        if any(_kind(node_id) not in _REGION_KINDS for node_id in resolved_refs):
            return Placement(
                "unsupported", "unsupported-reference-kind", pointer + "/refs"
            )
        row = {
            "id": minted_id,
            "type": record["type"],
            "path": f"intake/{envelope['source']}/{envelope['batch']}.json",
            "observed_at": record["date"],
            "summary": record["text"],
            "touches": resolved_refs,
            "supports_state_updates": [],
            "evidence_strength": record["evidence_strength"],
            "intake": key,
        }
        return Placement(
            "applied", "applied", pointer,
            _with_sensitivity(row, record, envelope),
        )

    sources: dict[str, str] = {}
    pulls: list[str] = []
    for node_id in resolved_refs:
        ref_kind = _kind(node_id)
        if ref_kind in _SOURCE_KINDS:
            if ref_kind in sources:
                return Placement(
                    "unsupported",
                    "duplicate-question-source-kind",
                    pointer + "/refs",
                )
            sources[ref_kind] = node_id
        elif ref_kind in _REGION_KINDS:
            pulls.append(node_id)
        else:
            return Placement(
                "unsupported", "unsupported-reference-kind", pointer + "/refs"
            )
    if not sources:
        return Placement("unsupported", "missing-question-source", pointer + "/refs")
    row = {
        "id": minted_id,
        "type": "question",
        "text": record["text"],
        "created_at": record["date"],
        "pulls": pulls,
        "source": sources,
        "intake": key,
    }
    return Placement(
        "applied", "applied", pointer,
        _with_sensitivity(row, record, envelope),
    )


def _load_known_ids(
    instance: atlas_io.AtlasInstance, withheld: set[str]
) -> dict[str, str]:
    """Reuse the builder's curated+journal reader and retirement resolution.

    §33.2: an interrupted record's outputs await the user's explicit
    reconciliation — a journal row whose intake key has no processed receipt
    must not resolve references (the caller passes those ids as withheld),
    or later records would silently build on state the user has not
    resolved.
    """

    try:
        graph, errors, _warnings = build_atlas_graph.build(instance.root / "atlas")
    except (atlas_io.AtlasIOError, IntakeFailure):
        raise
    except Exception as exc:
        raise IntakeFailure("instance-state-invalid") from exc
    if errors:
        raise IntakeFailure("instance-state-invalid")
    known: dict[str, str] = {}
    for node in graph["nodes"]:
        node_id = node["id"]
        if node_id in withheld:
            continue
        known[node_id] = node_id
        for retired in node.get("formerly", []):
            known[retired] = node_id
    return known


def _preflight_tree(instance: atlas_io.AtlasInstance) -> None:
    """Refuse symlinks and special files under the resolution input roots.

    §24.2 containment: the builder's own readers follow paths normally, so
    reference resolution must not trust ids reachable only through a
    symlink out of the instance or ignore boundary — the tree is walked
    lstat-only before any id is loaded.
    """

    for top in ("atlas", "state"):
        stack = [instance.path(top)]
        while stack:
            directory = stack.pop()
            try:
                entries = list(os.scandir(directory))
            except OSError:
                _preflight_fail(instance, directory)
            for entry in entries:
                is_directory = False
                try:
                    if entry.is_symlink():
                        _preflight_fail(instance, entry.path)
                    is_directory = entry.is_dir(follow_symlinks=False)
                    if not is_directory and not entry.is_file(
                        follow_symlinks=False
                    ):
                        _preflight_fail(instance, entry.path)
                except OSError:
                    _preflight_fail(instance, entry.path)
                if is_directory:
                    stack.append(Path(entry.path))


def _preflight_fail(instance: atlas_io.AtlasInstance, path) -> None:
    try:
        relative = Path(path).relative_to(instance.root).as_posix()
    except ValueError:
        relative = "."
    raise atlas_io.AtlasIOError(
        atlas_io.Diagnostic(
            reason=atlas_io.ReasonCode.UNSAFE_PATH, relative_path=relative
        )
    )


def _journal_outputs(
    instance: atlas_io.AtlasInstance,
) -> dict[str, tuple[str, dict]]:
    """Map every journal row's intake key to its (record kind, row)."""

    outputs: dict[str, tuple[str, dict]] = {}
    state = instance.path("state")
    for stem, kind in (
        ("encounters", "encounter"),
        ("artifacts", "artifact"),
        ("questions", "question"),
    ):
        for found in validate_atlas._journal_paths(state, stem):
            relative = found.relative_to(instance.root).as_posix()
            path = atlas_io._NoFollowPath(instance.root, instance.path(relative))
            for _number, row in validate_atlas._read_jsonl(path):
                if isinstance(row, dict) and isinstance(row.get("intake"), str):
                    outputs[row["intake"]] = (kind, row)
    return outputs


def _replay_matches(
    instance: atlas_io.AtlasInstance,
    record: object,
    envelope: dict,
    known: dict[str, str],
    key: str,
    minted_id: str | None,
    index: int,
    recorded: tuple[str, dict] | None,
) -> bool:
    """Check a replayed record still matches its recorded durable output.

    Every field is compared, reference fields included — an edited ref must
    conflict like an edited text. Both sides' reference ids are mapped
    through the current retirement resolution first, so a §34.4 rename
    between the original run and the replay is not a false drift.
    """

    if recorded is None or not isinstance(record, dict):
        return False
    kind, row = recorded
    if record.get("kind") != kind or row.get("id") != minted_id:
        return False
    definition = _RECORD_DEFINITIONS.get(kind)
    if definition is None or instance.schema_errors(
        record, "atlas-intake", definition=definition
    ):
        return False
    placement = _place_record(record, envelope, known, key, minted_id, index)
    if placement.row is None:
        return False
    reference = set(_ROW_REFERENCE_FIELDS[kind])

    def _resolved(value):
        if isinstance(value, str):
            return known.get(value, value)
        if isinstance(value, list):
            return [_resolved(item) for item in value]
        if isinstance(value, dict):
            return {name: _resolved(item) for name, item in value.items()}
        return value

    expected = {
        field: _resolved(value) if field in reference else value
        for field, value in placement.row.items()
    }
    durable = {
        field: _resolved(value) if field in reference else value
        for field, value in row.items()
    }
    return expected == durable


def _crash(point: str, index: int) -> None:
    if os.environ.get("ATLAS_INTAKE_CRASH") == f"{point}:{index}":
        raise InjectedCrash("injected-crash")


def _make_report(source: str, batch: str, records: list[dict]) -> dict:
    counts = {name: 0 for name in _RESULT_CLASSES}
    for record in records:
        counts[record["class"]] += 1
    return {
        "format": "report-batch",
        "version": 1,
        "source": source,
        "batch": batch,
        "records": records,
        "counts": {"total": len(records), **counts},
    }


def _conflict_report(envelope: dict) -> dict:
    records = []
    source = envelope["source"]
    batch = envelope["batch"]
    for index, record in enumerate(envelope["records"]):
        key = atlas_io.make_receipt_key(source, batch, index)
        records.append(
            _result(
                index,
                key,
                "conflict",
                "batch-content-conflict",
                f"/records/{index}",
                _minted_id(record.get("kind") if isinstance(record, dict) else None,
                           source, batch, index),
            )
        )
    return _make_report(source, batch, records)


def _classify_pending(
    instance: atlas_io.AtlasInstance,
    envelope: dict,
    known: dict[str, str],
    pending: dict[int, tuple[dict, str]],
) -> tuple[dict[int, Placement], dict[int, dict]]:
    """Classify pending records against a fixpoint of intra-batch ids.

    §33.2 determinism: a reference to any other record of the same delivery
    resolves in one run — the candidate set starts as every pending record's
    minted id (self excluded) and shrinks as records fail, so the outcome
    never depends on record order or on a second pass over the batch.
    """

    source = envelope["source"]
    batch = envelope["batch"]
    failures: dict[int, dict] = {}
    surviving = dict(pending)
    while True:
        placements: dict[int, Placement] = {}
        candidate_ids = {
            minted: minted for _, minted in surviving.values()
        }
        changed = False
        for index, (record, minted_id) in list(surviving.items()):
            key = atlas_io.make_receipt_key(source, batch, index)
            resolution = {**candidate_ids, **known}
            resolution.pop(minted_id, None)
            placement = _place_record(
                record, envelope, resolution, key, minted_id, index
            )
            failure: dict | None = None
            if placement.row is None:
                failure = _result(
                    index, key, placement.classification, placement.reason,
                    placement.pointer, minted_id,
                )
            else:
                kind = record["kind"]
                try:
                    atlas_io.enforce_ceiling(
                        len(_encoded(placement.row)),
                        maximum=atlas_io.JOURNAL_ROW_BYTES,
                        kind="bytes",
                        relative_path=_JOURNALS[kind],
                    )
                except atlas_io.AtlasIOError:
                    failure = _result(
                        index, key, "rejected", "derived-row-too-large",
                        f"/records/{index}", minted_id,
                    )
                else:
                    if instance.schema_errors(placement.row, f"journal-{kind}"):
                        failure = _result(
                            index, key, "rejected", "derived-row-invalid",
                            f"/records/{index}", minted_id,
                        )
            if failure is not None:
                failures[index] = failure
                del surviving[index]
                changed = True
            else:
                placements[index] = placement
        if not changed:
            return placements, failures


# The rows' structural reference fields — free text (summary, text) is data
# and never creates a dependency, even when it equals a minted id verbatim.
_ROW_REFERENCE_FIELDS = {
    "encounter": ("target",),
    "artifact": ("touches",),
    "question": ("pulls", "source"),
}


def _row_reference_ids(kind: str, row: dict) -> set[str]:
    ids: set[str] = set()
    for field in _ROW_REFERENCE_FIELDS[kind]:
        value = row.get(field)
        if isinstance(value, str):
            ids.add(value)
        elif isinstance(value, list):
            ids.update(item for item in value if isinstance(item, str))
        elif isinstance(value, dict):
            ids.update(
                item for item in value.values() if isinstance(item, str)
            )
    return ids


def _append_order(
    pending: dict[int, tuple[dict, str]],
    placements: dict[int, Placement],
) -> list[int]:
    """Order appends so an intra-batch dependency is durable first.

    A crash between two records must never leave a processed dependent
    citing a minted id whose own record stayed interrupted or unwritten —
    dependencies commit before dependents, ties break by record index.
    The closed record family cannot form reference cycles (only questions
    cite other records); an impossible cycle still fails closed.
    """

    minted_to_index = {
        minted: index
        for index, (_, minted) in pending.items()
        if index in placements
    }
    dependencies = {
        index: [
            minted_to_index[ref]
            for ref in sorted(
                _row_reference_ids(
                    pending[index][0]["kind"], placements[index].row
                )
            )
            if ref in minted_to_index and minted_to_index[ref] != index
        ]
        for index in placements
    }
    order: list[int] = []
    done: set[int] = set()
    remaining = sorted(placements)
    while remaining:
        deferred: list[int] = []
        for index in remaining:
            if all(dep in done for dep in dependencies[index]):
                order.append(index)
                done.add(index)
            else:
                deferred.append(index)
        if len(deferred) == len(remaining):
            raise IntakeFailure("reference-cycle")
        remaining = deferred
    return order


def _process_records(
    instance: atlas_io.AtlasInstance, envelope: dict
) -> tuple[dict, bool]:
    source = envelope["source"]
    batch = envelope["batch"]
    receipt_status = instance.receipt_status()
    # §33.2: a batch id names one immutable delivery — a receipt recorded
    # beyond the current record range means the canonical original no
    # longer matches what the receipts covered (e.g. a truncated file), so
    # the whole batch fails closed instead of reporting a clean partial
    # replay that hides recorded rows.
    prefix = f"{source}/{batch}#"
    total = len(envelope["records"])
    if any(
        int(key.rsplit("#", 1)[1]) >= total
        for key in receipt_status.opened | receipt_status.processed
        if key.startswith(prefix)
    ):
        return _conflict_report(envelope), True
    _preflight_tree(instance)
    outputs = _journal_outputs(instance)
    withheld = {
        outputs[key][1]["id"]
        for key in receipt_status.interrupted
        if key in outputs and isinstance(outputs[key][1].get("id"), str)
    }
    known = _load_known_ids(instance, withheld)
    results: dict[int, dict] = {}
    pending: dict[int, tuple[dict, str]] = {}

    for index, record in enumerate(envelope["records"]):
        key = atlas_io.make_receipt_key(source, batch, index)
        pointer = f"/records/{index}"
        kind = record.get("kind") if isinstance(record, dict) else None
        minted_id = _minted_id(kind, source, batch, index)

        if key in receipt_status.processed:
            # §33.2: the receipt alone does not prove the current record is
            # the one it covered — an in-place edit of the canonical
            # original with the same record count must not replay clean.
            if not _replay_matches(
                instance, record, envelope, known, key, minted_id, index,
                outputs.get(key),
            ):
                return _conflict_report(envelope), True
            results[index] = _result(
                index, key, "replayed", "processed-receipt", pointer, minted_id
            )
            continue
        if key in receipt_status.interrupted:
            results[index] = _result(
                index, key, "interrupted", "interrupted-receipt",
                pointer, minted_id,
            )
            continue

        definition = _RECORD_DEFINITIONS.get(kind) if isinstance(kind, str) else None
        if definition is None:
            results[index] = _result(
                index, key, "rejected", "schema-invalid",
                pointer + "/kind", minted_id,
            )
            continue
        schema_errors = instance.schema_errors(
            record, "atlas-intake", definition=definition
        )
        if schema_errors:
            results[index] = _result(
                index,
                key,
                "rejected",
                "schema-invalid",
                _pointer_from_schema_error(schema_errors[0], index),
                minted_id,
            )
            continue

        if minted_id is not None and minted_id in known:
            results[index] = _result(
                index, key, "conflict", "id-conflict", pointer, minted_id
            )
            continue

        if kind == "plan":
            results[index] = _result(
                index, key, "unsupported", "unsupported-plan",
                pointer, minted_id,
            )
            continue
        pending[index] = (record, minted_id)

    placements, failures = _classify_pending(instance, envelope, known, pending)
    results.update(failures)

    for index in _append_order(pending, placements):
        record, minted_id = pending[index]
        key = atlas_io.make_receipt_key(source, batch, index)
        kind = record["kind"]
        _crash("before-opened", index)
        instance.append_receipt(key, "opened", record["date"])
        _crash("after-opened", index)
        instance.append_record(_JOURNALS[kind], placements[index].row)
        _crash("after-output", index)
        _crash("before-processed", index)
        instance.append_receipt(key, "processed", record["date"])
        results[index] = _result(
            index, key, "applied", "applied", f"/records/{index}", minted_id
        )

    return _make_report(
        source, batch, [results[index] for index in sorted(results)]
    ), False


def _emit_record_diagnostics(report: dict) -> None:
    for record in report["records"]:
        if record["class"] not in {"applied", "replayed"}:
            print(
                f"ERROR: intake/{report['source']}/{report['batch']}.json"
                f"#{record['index']}: {record['reason']}; pointer "
                f"{record['pointer']}",
                file=sys.stderr,
            )


def _emit_report(instance: atlas_io.AtlasInstance, report: dict) -> None:
    instance.validate_format(report)
    print(_encoded(report).decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    parsed = _parse_args(args)
    if parsed is None:
        return _usage()
    root, mode, value = parsed

    try:
        instance = atlas_io.AtlasInstance(root)
        report = None
        whole_conflict = False
        with instance.lock():
            delivered_bytes = None
            requested = None
            if mode == "--batch-file":
                delivered = instance.read_delivered_json(
                    value, max_bytes=INTAKE_BATCH_BYTES
                )
                envelope = delivered.value
                delivered_bytes = delivered.data
            else:
                requested = tuple(value.split("/", 1))
                relative = f"intake/{requested[0]}/{requested[1]}.json"
                envelope = instance.read_json(
                    relative, max_bytes=INTAKE_BATCH_BYTES, delivered=True
                )

            instance.validate_format(envelope, definition="envelope")
            display = f"intake/{envelope['source']}/{envelope['batch']}.json"
            _enforce_batch_structure(envelope, display)
            canonical = display

            if requested is not None and requested != (
                envelope["source"], envelope["batch"]
            ):
                report = _conflict_report(envelope)
                whole_conflict = True
            elif delivered_bytes is not None:
                supplied = Path(os.path.abspath(value))
                canonical_absolute = instance.root / canonical
                intake_root = instance.root / "intake"
                try:
                    supplied.relative_to(intake_root)
                    inside_intake = True
                except ValueError:
                    inside_intake = False
                try:
                    instance.path(canonical)
                    canonical_present = True
                except atlas_io.AtlasIOError:
                    canonical_present = False
                if (
                    inside_intake
                    and supplied != canonical_absolute
                    and not canonical_present
                ):
                    report = _conflict_report(envelope)
                    whole_conflict = True
                if report is None and not canonical_present:
                    # §33.2: a batch id names one immutable delivery. With
                    # receipts already on record but the canonical original
                    # gone, a redelivery cannot be byte-compared against
                    # what those receipts covered — replay verification is
                    # impossible, so the whole batch fails closed; a
                    # corrected batch is a new id.
                    prefix = f"{envelope['source']}/{envelope['batch']}#"
                    status = instance.receipt_status()
                    if any(
                        key.startswith(prefix)
                        for key in status.opened | status.processed
                    ):
                        report = _conflict_report(envelope)
                        whole_conflict = True
                if report is None:
                    try:
                        instance.preserve_bytes(canonical, delivered_bytes)
                    except atlas_io.AtlasIOError as exc:
                        if exc.diagnostic.reason is atlas_io.ReasonCode.CONTENT_CONFLICT:
                            report = _conflict_report(envelope)
                            whole_conflict = True
                        else:
                            raise

            if report is None:
                report, records_conflict = _process_records(instance, envelope)
                whole_conflict = whole_conflict or records_conflict

        _emit_report(instance, report)
        if whole_conflict:
            print(
                f"ERROR: intake/{report['source']}/{report['batch']}.json: "
                "batch-content-conflict; expected one immutable delivery",
                file=sys.stderr,
            )
        else:
            _emit_record_diagnostics(report)
        return (
            0
            if not whole_conflict and all(
                item["class"] in {"applied", "replayed"}
                for item in report["records"]
            )
            else 1
        )
    except atlas_io.AtlasIOError as exc:
        print(atlas_io.format_diagnostics(exc.diagnostic), file=sys.stderr)
        return 1
    except IntakeFailure as exc:
        print(
            f"ERROR: {exc.relative_path}: {exc.reason}; expected a complete "
            "deterministic intake run",
            file=sys.stderr,
        )
        return 1
    except (OSError, TypeError, ValueError, KeyError):
        print(
            "ERROR: intake: processing-failed; expected a complete "
            "deterministic intake run",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
