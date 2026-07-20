import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import append_record
import build_atlas_graph
import validate_atlas


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "fixtures" / "demo-instance"

_DENSE_TEXT = (
    "Vera Example compared retry boundaries, durable evidence, and source "
    "voice while keeping the observation explicitly authored and local. " * 8
)[:768]


def encounter(**overrides):
    value = {
        "id": "encounter:vera-example-manual",
        "date": "2026-07-20",
        "target": "material:fastapi-tutorial",
        "depth": "read",
        "mode": "background",
    }
    value.update(overrides)
    return value


def artifact(**overrides):
    value = {
        "id": "artifact:vera-example-manual",
        "type": "note",
        "path": "notes/vera-example-manual.md",
        "observed_at": "2026-07-20",
        "summary": _DENSE_TEXT,
        "touches": [
            "concept:idempotency",
            "concept:redis",
            "concept:rest-api",
        ],
        "supports_state_updates": ["concept:idempotency"],
        "evidence_strength": "noticed",
        "probe": "probe:duplicate-post-idempotency",
    }
    value.update(overrides)
    return value


def question(**overrides):
    value = {
        "id": "question:vera-example-manual",
        "type": "question",
        "text": _DENSE_TEXT,
        "created_at": "2026-07-20",
        "pulls": ["concept:idempotency", "concept:redis"],
        "source": {"artifact": "artifact:vera-example-manual"},
    }
    value.update(overrides)
    return value


DENSE_ROWS = (encounter(), artifact(), question())


@contextlib.contextmanager
def private_instance(*, git=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "vera-example-instance"
        shutil.copytree(DEMO, root / "atlas")
        (root / "state").mkdir()
        if git:
            (root / ".git").mkdir()
        yield root


def write_record(directory: Path, value: object, name="record.json") -> Path:
    path = directory / name
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def run_main(root: str | Path, record_file: str | Path, *args: str):
    stdout = io.StringIO()
    stderr = io.StringIO()
    argv = [str(root), "--record-file", str(record_file), *map(str, args)]
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = append_record.main(argv)
    lines = stdout.getvalue().splitlines()
    report = json.loads(lines[-1]) if lines and lines[-1].startswith("{") else None
    return code, lines, report, stderr.getvalue()


def rows(root: Path, stem: str):
    path = root / "state" / f"{stem}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def state_bytes(root: Path):
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in (root / "state").rglob("*")
        if path.is_file()
    }


class HappyPathTests(unittest.TestCase):
    def test_fresh_rows_append_with_receipts_and_build_visible_nodes(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            outside = Path(outside)
            for index, (record, stem) in enumerate(
                (
                    (artifact(), "artifacts"),
                    (
                        encounter(context={"artifact": "artifact:vera-example-manual"}),
                        "encounters",
                    ),
                ),
                1,
            ):
                delivery = write_record(outside, record, f"record-{index}.json")
                code, lines, report, stderr = run_main(
                    root, delivery, "--key", f"2026-07-20-00{index}", "--commit"
                )
                self.assertEqual(0, code, stderr)
                self.assertEqual("applied", report["records"][0]["class"])
                self.assertEqual(record["id"], rows(root, stem)[0]["id"])
                self.assertEqual(
                    f"destination: state/{stem}.jsonl", lines[1]
                )

            delivery = write_record(outside, question(), "record-3.json")
            code, _, report, stderr = run_main(
                root, delivery, "--key", "2026-07-20-003", "--commit"
            )
            graph, errors, _warnings = build_atlas_graph.build(root / "atlas")
            receipt_count = len(rows(root, "receipts"))
            visible = {node["id"] for node in graph["nodes"]}

        self.assertEqual(0, code, stderr)
        self.assertEqual("applied", report["records"][0]["class"])
        self.assertEqual(6, receipt_count)
        self.assertEqual(
            {
                "encounter:vera-example-manual",
                "artifact:vera-example-manual",
                "question:vera-example-manual",
            },
            visible & {
                "encounter:vera-example-manual",
                "artifact:vera-example-manual",
                "question:vera-example-manual",
            },
        )
        self.assertEqual([], errors)

    def test_duplicate_key_replays_without_appending_and_drift_conflicts(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), artifact())
            code, _, _, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            self.assertEqual(0, code, stderr)
            before = state_bytes(root)
            dry_code, _, dry_replay, dry_stderr = run_main(
                root, delivery, "--key", "2026-07-20-001"
            )
            self.assertEqual(0, dry_code, dry_stderr)
            self.assertEqual("replayed", dry_replay["records"][0]["class"])
            self.assertEqual(before, state_bytes(root))
            self.assertFalse((root / ".atlas-lock").exists())
            code, _, replay, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            after_replay = state_bytes(root)
            changed = write_record(
                Path(outside), artifact(summary="Changed Vera Example text."),
                "changed.json",
            )
            conflict_code, _, conflict, _ = run_main(
                root, changed, "--key", "2026-07-20-001", "--commit"
            )
        self.assertEqual(0, code, stderr)
        self.assertEqual("replayed", replay["records"][0]["class"])
        self.assertEqual(before, after_replay)
        self.assertEqual(1, conflict_code)
        self.assertEqual("batch-content-conflict", conflict["records"][0]["reason"])

    def test_headers_report_schema_and_git_backup_are_exact(self):
        with private_instance(git=True) as root, \
                tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), encounter())
            code, lines, report, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual(0, code, stderr)
        self.assertEqual(
            [
                f"instance: {root}",
                "destination: state/encounters.jsonl",
                "backup: git",
                "key: manual/2026-07-20-001#0",
            ],
            lines[:4],
        )
        self.assertEqual([], errors)
        self.assertEqual(
            [], validate_atlas.SchemaValidator(schemas["report-batch"]).validate(report)
        )


class DryRunAndRefusalTests(unittest.TestCase):
    def test_keyless_and_keyed_dry_runs_take_no_lock_and_write_nothing(self):
        for extra in ((), ("--key", "2026-07-20-001")):
            with self.subTest(extra=extra), private_instance() as root, \
                    tempfile.TemporaryDirectory() as outside:
                delivery = write_record(Path(outside), artifact())
                before = state_bytes(root)
                code, lines, report, stderr = run_main(root, delivery, *extra)
                self.assertEqual(0, code, stderr)
                self.assertIsNone(report)
                self.assertEqual("result: valid", lines[-1])
                self.assertEqual(before, state_bytes(root))
                self.assertFalse((root / ".atlas-lock").exists())

    def test_schema_reference_and_id_failures_happen_before_writes(self):
        cases = (
            (artifact(intake="manual/2026-07-20-001#0"), "schema-invalid", "/intake"),
            (artifact(extra="Vera Example"), "schema-invalid", "/records/0"),
            (artifact(touches=["concept:missing-vera-example"]),
             "unresolved-reference", "/touches/0"),
            (artifact(probe="probe:missing-vera-example"),
             "unresolved-reference", "/probe"),
        )
        for index, (record, reason, pointer) in enumerate(cases, 1):
            with self.subTest(reason=reason, pointer=pointer), \
                    private_instance() as root, \
                    tempfile.TemporaryDirectory() as outside:
                delivery = write_record(Path(outside), record)
                before = state_bytes(root)
                code, _, report, stderr = run_main(
                    root, delivery, "--key", f"2026-07-20-01{index}", "--commit"
                )
                self.assertEqual(1, code)
                self.assertEqual(reason, report["records"][0]["reason"])
                self.assertIn(pointer, report["records"][0]["pointer"])
                self.assertIn(reason, stderr)
                self.assertEqual(before, state_bytes(root))
                self.assertFalse((root / ".atlas-lock").exists())

    def test_existing_id_under_new_key_is_conflict(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), encounter())
            code, _, _, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            self.assertEqual(0, code, stderr)
            before = state_bytes(root)
            code, _, report, stderr = run_main(
                root, delivery, "--key", "2026-07-20-002", "--commit"
            )
            after = state_bytes(root)
        self.assertEqual(1, code)
        self.assertEqual("id-conflict", report["records"][0]["reason"])
        self.assertEqual(before, after)

    def test_unknown_prefix_and_non_object_are_schema_invalid(self):
        for value in ({"id": "trail-segment:2026-07-20-001"}, []):
            with self.subTest(value_type=type(value).__name__), \
                    private_instance() as root, \
                    tempfile.TemporaryDirectory() as outside:
                delivery = write_record(Path(outside), value)
                code, lines, report, stderr = run_main(
                    root, delivery, "--key", "2026-07-20-001"
                )
                self.assertEqual(1, code)
                self.assertEqual("schema-invalid", report["records"][0]["reason"])
                self.assertFalse((root / ".atlas-lock").exists())


class BoundaryTests(unittest.TestCase):
    def test_bom_cr_symlink_traversal_and_ignore_root_are_refused(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            outside = Path(outside)
            valid = write_record(outside, encounter(), "valid.json")
            bom = outside / "bom.json"
            bom.write_bytes(b"\xef\xbb\xbf" + valid.read_bytes())
            cr = outside / "cr.json"
            cr.write_bytes(valid.read_bytes().replace(b"\n", b"\r\n"))
            symlink = outside / "link.json"
            symlink.symlink_to(valid)
            ignored_dir = outside / "secrets"
            ignored_dir.mkdir()
            ignored = write_record(ignored_dir, encounter())
            traversal = outside / "child"
            traversal.mkdir()
            traversal_text = str(traversal / ".." / "valid.json")
            for supplied, reason in (
                (bom, "invalid-utf8"),
                (cr, "invalid-line-ending"),
                (symlink, "unsafe-path"),
                (ignored, "ignored-path"),
                (traversal_text, "unsafe-path"),
            ):
                with self.subTest(reason=reason):
                    code, _, report, stderr = run_main(root, supplied)
                    self.assertEqual(1, code)
                    self.assertIsNone(report)
                    self.assertIn(reason, stderr)
                    self.assertEqual({}, state_bytes(root))

    def test_symlink_and_traversal_instance_roots_are_refused(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), encounter())
            link = Path(outside) / "instance-link"
            link.symlink_to(root, target_is_directory=True)
            traversal = str(root / "state" / "..")
            for supplied in (link, traversal):
                with self.subTest(root=supplied):
                    code, _, report, stderr = run_main(supplied, delivery)
                    self.assertEqual(1, code)
                    self.assertIsNone(report)
                    self.assertIn("invalid-root", stderr)

    def test_total_string_and_depth_ceilings_refuse_before_writes(self):
        deep: object = "Vera Example"
        for _ in range(9):
            deep = [deep]
        file_text = (
            "Vera Example " * append_record.MANUAL_RECORD_BYTES
        )[:append_record.MANUAL_RECORD_BYTES]
        string_text = (
            "Vera Example " * append_record.MANUAL_STRING_BYTES
        )[:append_record.MANUAL_STRING_BYTES + 1]
        cases = (
            artifact(summary=file_text),
            artifact(summary=string_text),
            {**artifact(), "extra": deep},
        )
        expected = (
            "byte-ceiling-exceeded",
            "byte-ceiling-exceeded",
            "count-ceiling-exceeded",
        )
        for record, reason in zip(cases, expected):
            with self.subTest(reason=reason), private_instance() as root, \
                    tempfile.TemporaryDirectory() as outside:
                delivery = write_record(Path(outside), record)
                code, _, report, stderr = run_main(root, delivery)
                self.assertEqual(1, code)
                self.assertIsNone(report)
                self.assertIn(reason, stderr)
                self.assertEqual({}, state_bytes(root))


class CrashAndRetirementTests(unittest.TestCase):
    def test_crash_after_opened_surfaces_interrupted_receipt_without_output(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), encounter())
            with mock.patch.dict(
                os.environ, {"ATLAS_MANUAL_CRASH": "after-opened:0"}, clear=False
            ):
                code, _, report, stderr = run_main(
                    root, delivery, "--key", "2026-07-20-001", "--commit"
                )
            self.assertEqual(1, code)
            self.assertIsNone(report)
            self.assertIn("injected-crash", stderr)
            self.assertEqual([], rows(root, "encounters"))
            self.assertEqual(
                ["opened"],
                [row["marker"] for row in rows(root, "receipts")],
            )
            code, _, report, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            final_encounters = rows(root, "encounters")
        self.assertEqual(1, code)
        self.assertEqual("interrupted-receipt", report["records"][0]["reason"])
        self.assertEqual([], final_encounters)

    def test_crash_after_output_leaves_complete_line_and_never_reappends(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            delivery = write_record(Path(outside), artifact())
            with mock.patch.dict(
                os.environ, {"ATLAS_MANUAL_CRASH": "after-output:0"}, clear=False
            ):
                code, _, _, stderr = run_main(
                    root, delivery, "--key", "2026-07-20-001", "--commit"
                )
            journal = root / "state" / "artifacts.jsonl"
            self.assertTrue(journal.read_bytes().endswith(b"\n"))
            self.assertEqual(1, len(rows(root, "artifacts")))
            dependent = write_record(Path(outside), question(), "question.json")
            dependent_code, _, dependent_report, _ = run_main(
                root,
                dependent,
                "--key",
                "2026-07-20-002",
                "--commit",
            )
            self.assertEqual(1, dependent_code)
            self.assertEqual(
                "unresolved-reference",
                dependent_report["records"][0]["reason"],
            )
            self.assertEqual([], rows(root, "questions"))
            code, _, report, _ = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            final_artifacts = rows(root, "artifacts")
        self.assertEqual(1, code)
        self.assertEqual("interrupted", report["records"][0]["class"])
        self.assertEqual(1, len(final_artifacts))

    def test_retired_refs_rewrite_and_replay_matches_modulo_retirement(self):
        with private_instance() as root, tempfile.TemporaryDirectory() as outside:
            original = artifact(touches=["concept:idempotency"])
            delivery = write_record(Path(outside), original)
            code, _, _, stderr = run_main(
                root, delivery, "--key", "2026-07-20-001", "--commit"
            )
            self.assertEqual(0, code, stderr)
            concept = root / "atlas" / "concepts" / "idempotency.md"
            content = concept.read_text(encoding="utf-8")
            content = content.replace(
                "id: concept:idempotency\n",
                "id: concept:durable-idempotency\nformerly:\n  - concept:idempotency\n",
            )
            concept.write_text(content, encoding="utf-8")
            changed = write_record(
                Path(outside),
                artifact(touches=["concept:durable-idempotency"]),
                "renamed.json",
            )
            code, _, report, stderr = run_main(
                root, changed, "--key", "2026-07-20-001", "--commit"
            )
            durable_touches = rows(root, "artifacts")[0]["touches"]
        self.assertEqual(0, code, stderr)
        self.assertEqual("replayed", report["records"][0]["class"])
        self.assertEqual(["concept:idempotency"], durable_touches)


class MeasuredFloorTests(unittest.TestCase):
    def test_dense_fixture_raw_maxima_and_headroom_are_pinned(self):
        raw = {
            "record_file_bytes": max(
                len((json.dumps(row, ensure_ascii=False, indent=2) + "\n").encode())
                for row in DENSE_ROWS
            ),
            "string_bytes": max(
                size
                for row in DENSE_ROWS
                for size in append_record._string_sizes(row)
            ),
            "depth": max(append_record._maximum_depth(row) for row in DENSE_ROWS),
        }
        self.assertEqual(
            {"record_file_bytes": 1_152, "string_bytes": 768, "depth": 2},
            raw,
        )
        self.assertGreaterEqual(
            append_record.MANUAL_RECORD_BYTES,
            raw["record_file_bytes"] * 10,
        )
        self.assertGreaterEqual(
            append_record.MANUAL_STRING_BYTES,
            raw["string_bytes"] * 10,
        )
        self.assertEqual(8, append_record.MANUAL_NESTING_DEPTH)


class UsageTests(unittest.TestCase):
    def test_commit_requires_valid_key_and_help_recommends_date_serial(self):
        for args in (
            [],
            ["root", "--record-file", "record.json", "--commit"],
            ["root", "--record-file", "record.json", "--key", "Bad_Key"],
        ):
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = append_record.main(args)
            self.assertEqual(2, code)
            self.assertIn("usage", stderr.getvalue())
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = append_record.main(["--help"])
        self.assertEqual(0, code)
        self.assertIn("2026-07-20-001", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
