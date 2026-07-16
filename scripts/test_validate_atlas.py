import contextlib
import io
import unittest
from pathlib import Path

import validate_atlas


ROOT = Path(__file__).resolve().parents[1]


class SchemaValidatorTests(unittest.TestCase):
    def run_cli(self, *args):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = validate_atlas.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_registry_is_exact_and_supported(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        self.assertEqual(validate_atlas.SCHEMA_NAMES, set(schemas))

    def test_unsupported_schema_keyword_fails_closed(self):
        with self.assertRaises(validate_atlas.SchemaSubsetError):
            validate_atlas.SchemaValidator({"type": "string", "format": "date"})

    def test_valid_instance(self):
        root = ROOT / "fixtures" / "schema" / "valid-instance"
        code, stdout, stderr = self.run_cli("validate", str(root))
        self.assertEqual(0, code, stderr)
        self.assertIn("0 errors", stdout)
        self.assertEqual("", stderr)

    def test_demo_instance(self):
        root = ROOT / "fixtures" / "demo-instance"
        code, stdout, stderr = self.run_cli("validate", str(root))
        self.assertEqual(0, code, stderr)
        self.assertIn("11 frontmatter documents", stdout)

    def test_each_negative_instance_emits_error(self):
        parent = ROOT / "fixtures" / "schema" / "invalid-instances"
        for root in sorted(path for path in parent.iterdir() if path.is_dir()):
            with self.subTest(case=root.name):
                code, stdout, stderr = self.run_cli("validate", str(root))
                self.assertEqual(1, code)
                self.assertIn("ERROR:", stderr)
                self.assertIn("errors", stdout)
                self.assertTrue(
                    all(line.startswith("ERROR:") for line in stderr.splitlines())
                )

    def test_intake_schema_positive_and_negative_documents(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        directory = ROOT / "fixtures" / "schema" / "documents"
        valid = validate_atlas._read_json(directory / "atlas-intake.valid.json")
        invalid = validate_atlas._read_json(directory / "atlas-intake.invalid.json")
        validator = validate_atlas.SchemaValidator(schemas["atlas-intake"])
        self.assertEqual([], validator.validate(valid))
        self.assertTrue(validator.validate(invalid))

    def test_check_constants(self):
        code, stdout, stderr = self.run_cli("check-constants")
        self.assertEqual(0, code, stderr)
        self.assertEqual("checked constants: 0 errors\n", stdout)

    def test_usage_exit_code_and_diagnostic(self):
        code, stdout, stderr = self.run_cli()
        self.assertEqual(2, code)
        self.assertEqual("", stdout)
        self.assertTrue(stderr.startswith("ERROR: usage:"))


if __name__ == "__main__":
    unittest.main()
