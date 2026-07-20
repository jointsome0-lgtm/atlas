import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import atlas_io


@contextmanager
def fake_instance():
    """Create a reusable §8-shaped private instance with invented data."""

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "vera-example-instance"
        for name in ("atlas", "plans", "intake", "state", "graph"):
            (root / name).mkdir(parents=True, exist_ok=True)
        yield root


VALID_INTAKE = {
    "format": "atlas-intake",
    "version": 1,
    "source": "vera-example",
    "batch": "2026-07-20-001",
    "records": [],
}

VALID_ARTIFACT = {
    "id": "artifact:vera-example",
    "type": "note",
    "path": "notes/vera-example.md",
    "observed_at": "2026-07-20",
    "summary": "Invented example.",
    "touches": [],
    "supports_state_updates": [],
    "evidence_strength": "noticed",
}


class InstanceTests(unittest.TestCase):
    def test_valid_instance_is_accepted(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
        self.assertEqual(root.resolve(), instance.root)

    def test_missing_file_and_symlink_roots_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            missing = base / "missing"
            regular = base / "file"
            regular.write_text("Vera Example", encoding="utf-8")
            target = base / "target"
            (target / "atlas").mkdir(parents=True)
            (target / "state").mkdir()
            symlink = base / "linked"
            symlink.symlink_to(target, target_is_directory=True)
            for root in (missing, regular, symlink):
                with self.subTest(root=root.name), self.assertRaises(
                    atlas_io.AtlasIOError
                ) as raised:
                    atlas_io.AtlasInstance(root)
                self.assertEqual(
                    atlas_io.ReasonCode.INVALID_ROOT,
                    raised.exception.diagnostic.reason,
                )

    def test_required_data_dirs_must_be_real_directories(self):
        with fake_instance() as root:
            (root / "state").rmdir()
            (root / "state").symlink_to(root / "atlas", target_is_directory=True)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                atlas_io.AtlasInstance(root)
        self.assertEqual(atlas_io.ReasonCode.INVALID_ROOT,
                         raised.exception.diagnostic.reason)

    def test_traversal_and_absolute_paths_are_refused_without_echo(self):
        secret = "private-vera-example"
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            for candidate in (f"../{secret}", f"/{secret}"):
                with self.subTest(candidate=candidate), self.assertRaises(
                    atlas_io.AtlasIOError
                ) as raised:
                    instance.path(candidate, allow_missing=True)
                self.assertNotIn(secret, str(raised.exception))

    def test_symlink_inside_instance_cannot_escape(self):
        with fake_instance() as root, tempfile.TemporaryDirectory() as outside:
            (root / "state" / "escape").symlink_to(
                outside, target_is_directory=True
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.path("state/escape/value.json", allow_missing=True)
        self.assertEqual(atlas_io.ReasonCode.UNSAFE_PATH,
                         raised.exception.diagnostic.reason)

    def test_ignore_root_is_refused_at_any_depth(self):
        with fake_instance() as root:
            (root / "state" / "secrets").mkdir()
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.path("state/secrets/value.json", allow_missing=True)
        self.assertEqual(atlas_io.ReasonCode.IGNORED_PATH,
                         raised.exception.diagnostic.reason)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO requires POSIX")
    def test_special_file_is_refused(self):
        with fake_instance() as root:
            fifo = root / "state" / "pipe"
            os.mkfifo(fifo)
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError):
                instance.path("state/pipe")


class CeilingAndSchemaTests(unittest.TestCase):
    def test_unbounded_read_is_refused(self):
        with fake_instance() as root:
            path = root / "intake" / "value.json"
            path.write_text(json.dumps(VALID_INTAKE), encoding="utf-8")
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.read_json("intake/value.json", max_bytes=None)
        self.assertEqual(atlas_io.ReasonCode.UNBOUNDED_READ,
                         raised.exception.diagnostic.reason)

    def test_total_bytes_are_checked_before_decode(self):
        secret = "REJECTED-VERA-EXAMPLE"
        with fake_instance() as root:
            path = root / "intake" / "value.json"
            path.write_text(secret * 100, encoding="utf-8")
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.read_json("intake/value.json", max_bytes=8)
        self.assertEqual(atlas_io.ReasonCode.BYTE_CEILING_EXCEEDED,
                         raised.exception.diagnostic.reason)
        self.assertNotIn(secret, str(raised.exception))

    def test_count_ceiling_is_caller_supplied(self):
        atlas_io.enforce_ceiling(2, maximum=2, kind="count")
        with self.assertRaises(atlas_io.AtlasIOError) as raised:
            atlas_io.enforce_ceiling(3, maximum=2, kind="count")
        self.assertEqual(atlas_io.ReasonCode.COUNT_CEILING_EXCEEDED,
                         raised.exception.diagnostic.reason)

    def test_valid_format_and_version_pass_closed_schema(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            self.assertEqual("atlas-intake", instance.validate_format(VALID_INTAKE))

    def test_unknown_format_is_refused_without_echo(self):
        secret = "private-format-vera"
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.validate_format({"format": secret, "version": 1})
        self.assertEqual(atlas_io.ReasonCode.UNKNOWN_FORMAT,
                         raised.exception.diagnostic.reason)
        self.assertNotIn(secret, str(raised.exception))

    def test_unsupported_version_is_refused(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.validate_format({**VALID_INTAKE, "version": 2})
        self.assertEqual(atlas_io.ReasonCode.UNSUPPORTED_VERSION,
                         raised.exception.diagnostic.reason)

    def test_closed_schema_failure_does_not_echo_rejected_value(self):
        secret = "REJECTED-CONTENT-VERA"
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.validate_format({**VALID_INTAKE, secret: secret})
        self.assertEqual(atlas_io.ReasonCode.SCHEMA_INVALID,
                         raised.exception.diagnostic.reason)
        self.assertNotIn(secret, str(raised.exception))

    def test_bom_is_refused_unless_delivered(self):
        with fake_instance() as root:
            path = root / "intake" / "value.json"
            path.write_bytes(
                b"\xef\xbb\xbf" + json.dumps(VALID_INTAKE).encode("utf-8")
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.read_json("intake/value.json", max_bytes=1024)
            self.assertEqual(atlas_io.ReasonCode.INVALID_UTF8,
                             raised.exception.diagnostic.reason)
            value = instance.read_json(
                "intake/value.json", max_bytes=1024, delivered=True
            )
        self.assertEqual(VALID_INTAKE, value)

    def test_crlf_is_refused_unless_delivered(self):
        with fake_instance() as root:
            path = root / "intake" / "value.json"
            path.write_bytes(
                json.dumps(VALID_INTAKE, indent=1).replace("\n", "\r\n").encode(
                    "utf-8"
                )
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.read_json("intake/value.json", max_bytes=1024)
            self.assertEqual(atlas_io.ReasonCode.INVALID_LINE_ENDING,
                             raised.exception.diagnostic.reason)
            value = instance.read_json(
                "intake/value.json", max_bytes=1024, delivered=True
            )
        self.assertEqual(VALID_INTAKE, value)

    def test_bounded_reader_rejects_duplicate_keys_without_echo(self):
        secret = "private-key-vera"
        with fake_instance() as root:
            path = root / "intake" / "value.json"
            path.write_text(
                '{"%s":1,"%s":2}' % (secret, secret), encoding="utf-8"
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.read_json("intake/value.json", max_bytes=1024)
        self.assertEqual(atlas_io.ReasonCode.INVALID_JSON,
                         raised.exception.diagnostic.reason)
        self.assertNotIn(secret, str(raised.exception))


class LockAndAppendTests(unittest.TestCase):
    def test_lock_contention_refuses_and_context_exit_releases(self):
        with fake_instance() as root:
            first = atlas_io.AtlasInstance(root)
            second = atlas_io.AtlasInstance(root)
            with first.lock():
                self.assertTrue((root / ".atlas-lock").exists())
                with self.assertRaises(atlas_io.AtlasIOError) as raised:
                    with second.lock():
                        self.fail("contended lock was acquired")
                self.assertEqual(atlas_io.ReasonCode.LOCK_HELD,
                                 raised.exception.diagnostic.reason)
            self.assertFalse((root / ".atlas-lock").exists())

    def test_lock_contains_pid_and_started_at(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                payload = json.loads(
                    (root / ".atlas-lock").read_text(encoding="utf-8")
                )
                self.assertEqual({"pid", "started_at"}, set(payload))

    def test_lock_releases_when_the_writing_flow_raises(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaisesRegex(RuntimeError, "Vera Example stop"):
                with instance.lock():
                    raise RuntimeError("Vera Example stop")
            self.assertFalse((root / ".atlas-lock").exists())

    def test_append_requires_flow_lock(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.append_record(
                    "state/artifacts.jsonl",
                    VALID_ARTIFACT,
                )
        self.assertEqual(atlas_io.ReasonCode.LOCK_REQUIRED,
                         raised.exception.diagnostic.reason)

    def test_unregistered_journal_paths_are_refused(self):
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                for candidate in (
                    "state/unknown.jsonl",
                    "state/artifacts/nested/2026.jsonl",
                    "state/artifacts.json",
                    "graph/artifacts.jsonl",
                ):
                    with self.subTest(candidate=candidate), self.assertRaises(
                        atlas_io.AtlasIOError
                    ) as raised:
                        instance.append_record(candidate, VALID_ARTIFACT)
                    self.assertEqual(
                        atlas_io.ReasonCode.INVALID_JOURNAL_PATH,
                        raised.exception.diagnostic.reason,
                    )

    def test_rotated_journal_file_accepts_the_stem_schema(self):
        with fake_instance() as root:
            (root / "state" / "artifacts").mkdir()
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                result = instance.append_record(
                    "state/artifacts/2026.jsonl", VALID_ARTIFACT
                )
            self.assertTrue(result.created)
            raw = (root / "state" / "artifacts" / "2026.jsonl").read_bytes()
        self.assertEqual(VALID_ARTIFACT, json.loads(raw))

    def test_oversized_record_is_refused_before_any_write(self):
        secret = "OVERSIZED-VERA-CONTENT"
        record = {**VALID_ARTIFACT, "summary": secret + "x" * 20_000}
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock(), self.assertRaises(
                atlas_io.AtlasIOError
            ) as raised:
                instance.append_record(
                    "state/artifacts.jsonl",
                    record,
                )
            self.assertFalse((root / "state" / "artifacts.jsonl").exists())
        self.assertEqual(atlas_io.ReasonCode.BYTE_CEILING_EXCEEDED,
                         raised.exception.diagnostic.reason)
        self.assertNotIn(secret, str(raised.exception))

    def test_repeated_appends_produce_one_well_formed_line_each(self):
        second = {**VALID_ARTIFACT, "id": "artifact:vera-example-two"}
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                first_result = instance.append_record(
                    "state/artifacts.jsonl",
                    VALID_ARTIFACT,
                )
                second_result = instance.append_record(
                    "state/artifacts.jsonl",
                    second,
                )
            raw = (root / "state" / "artifacts.jsonl").read_bytes()
        self.assertTrue(first_result.created)
        self.assertFalse(second_result.created)
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"\n"))
        lines = raw.splitlines()
        self.assertEqual(2, len(lines))
        self.assertEqual([VALID_ARTIFACT, second], [json.loads(line) for line in lines])

    def test_incomplete_existing_jsonl_is_refused_without_append(self):
        with fake_instance() as root:
            target = root / "state" / "artifacts.jsonl"
            original = b'{"synthetic":"Vera Example"}'
            target.write_bytes(original)
            instance = atlas_io.AtlasInstance(root)
            with instance.lock(), self.assertRaises(atlas_io.AtlasIOError):
                instance.append_record(
                    "state/artifacts.jsonl",
                    VALID_ARTIFACT,
                )
            self.assertEqual(original, target.read_bytes())


class ReceiptTests(unittest.TestCase):
    def test_slug_grammar_is_enforced_and_reserved_names_are_exposed(self):
        self.assertEqual(
            "import/2026-07-20-001#0",
            atlas_io.make_receipt_key("import", "2026-07-20-001", 0),
        )
        self.assertEqual(
            frozenset({"import", "observe"}),
            atlas_io.RESERVED_RECEIPT_NAMESPACES,
        )
        for source, batch, index in (
            ("Upper", "batch", 0),
            ("source", "bad/slash", 0),
            ("source", "batch", -1),
        ):
            with self.subTest(
                source=source, batch=batch, index=index
            ), self.assertRaises(atlas_io.AtlasIOError):
                atlas_io.make_receipt_key(source, batch, index)

    def test_opened_without_processed_is_detectable(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-20-001", 0)
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                instance.append_receipt(key, "opened", "2026-07-20")
            status = instance.receipt_status()
        self.assertEqual(frozenset({key}), status.opened)
        self.assertEqual(frozenset(), status.processed)
        self.assertEqual(frozenset({key}), status.interrupted)

    def test_processed_follows_opened_and_clears_interrupted(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-20-001", 0)
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock():
                instance.append_receipt(key, "opened", "2026-07-20")
                instance.append_receipt(key, "processed", "2026-07-20")
            status = instance.receipt_status()
        self.assertEqual(frozenset({key}), status.opened)
        self.assertEqual(frozenset({key}), status.processed)
        self.assertEqual(frozenset(), status.interrupted)

    def test_processed_without_opened_is_refused(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-20-001", 0)
        with fake_instance() as root:
            instance = atlas_io.AtlasInstance(root)
            with instance.lock(), self.assertRaises(
                atlas_io.AtlasIOError
            ) as raised:
                instance.append_receipt(key, "processed", "2026-07-20")
            self.assertFalse((root / "state" / "receipts.jsonl").exists())
        self.assertEqual(atlas_io.ReasonCode.INVALID_RECEIPT_TRANSITION,
                         raised.exception.diagnostic.reason)

    def test_rotated_receipt_journals_join_the_status_concatenation(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-19-001", 0)
        rows = [
            {"intake": key, "marker": "opened", "date": "2026-07-19"},
            {"intake": key, "marker": "processed", "date": "2026-07-19"},
        ]
        with fake_instance() as root:
            rotated = root / "state" / "receipts"
            rotated.mkdir()
            (rotated / "2026.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )
            instance = atlas_io.AtlasInstance(root)
            status = instance.receipt_status()
            self.assertEqual(frozenset({key}), status.processed)
            with instance.lock(), self.assertRaises(
                atlas_io.AtlasIOError
            ) as raised:
                instance.append_receipt(key, "opened", "2026-07-20")
        self.assertEqual(atlas_io.ReasonCode.INVALID_RECEIPT_TRANSITION,
                         raised.exception.diagnostic.reason)

    def test_rotated_opened_can_be_processed_into_the_direct_file(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-19-002", 0)
        with fake_instance() as root:
            rotated = root / "state" / "receipts"
            rotated.mkdir()
            (rotated / "2026.jsonl").write_text(
                json.dumps(
                    {"intake": key, "marker": "opened", "date": "2026-07-19"}
                )
                + "\n",
                encoding="utf-8",
            )
            instance = atlas_io.AtlasInstance(root)
            self.assertEqual(
                frozenset({key}), instance.receipt_status().interrupted
            )
            with instance.lock():
                instance.append_receipt(key, "processed", "2026-07-20")
            status = instance.receipt_status()
        self.assertEqual(frozenset({key}), status.processed)
        self.assertEqual(frozenset(), status.interrupted)

    def test_processed_without_any_opened_row_is_invalid(self):
        key = atlas_io.make_receipt_key("vera-source", "2026-07-19-003", 0)
        with fake_instance() as root:
            (root / "state" / "receipts.jsonl").write_text(
                json.dumps(
                    {"intake": key, "marker": "processed", "date": "2026-07-19"}
                )
                + "\n",
                encoding="utf-8",
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.receipt_status()
        self.assertEqual(atlas_io.ReasonCode.INVALID_RECEIPT_JOURNAL,
                         raised.exception.diagnostic.reason)

    def test_invalid_receipt_journal_never_echoes_row_content(self):
        secret = "REJECTED-RECEIPT-VERA"
        with fake_instance() as root:
            (root / "state" / "receipts.jsonl").write_text(
                json.dumps({"intake": secret, "marker": "opened", "date": "2026-07-20"})
                + "\n",
                encoding="utf-8",
            )
            instance = atlas_io.AtlasInstance(root)
            with self.assertRaises(atlas_io.AtlasIOError) as raised:
                instance.receipt_status()
        self.assertNotIn(secret, str(raised.exception))


class DiagnosticTests(unittest.TestCase):
    def test_formatter_emits_one_prefixed_line_per_diagnostic(self):
        text = atlas_io.format_diagnostics(
            [
                atlas_io.Diagnostic(atlas_io.ReasonCode.INVALID_JSON),
                atlas_io.Diagnostic(
                    atlas_io.ReasonCode.COUNT_CEILING_EXCEEDED,
                    level=atlas_io.DiagnosticLevel.WARNING,
                    relative_path="state/receipts.jsonl",
                    record_index=2,
                ),
            ]
        )
        self.assertEqual(2, len(text.splitlines()))
        self.assertTrue(text.splitlines()[0].startswith("ERROR: "))
        self.assertTrue(text.splitlines()[1].startswith("WARNING: "))


if __name__ == "__main__":
    unittest.main()
