"""CLI-contract tests for view_demo (§25.8: ERROR: prefix, exit 2 on usage)."""
from __future__ import annotations

import contextlib
import io
import unittest

import view_demo


class UsageContractTest(unittest.TestCase):
    def invoke(self, argv: list[str]) -> tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                view_demo.parse_args(argv)
        return caught.exception.code, stderr.getvalue()

    def test_bad_port_exits_2_with_prefixed_lines(self):
        code, stderr = self.invoke(["--port", "nope"])
        self.assertEqual(2, code)
        lines = stderr.splitlines()
        self.assertTrue(lines)
        for line in lines:
            self.assertTrue(line.startswith("ERROR: "), line)
        self.assertIn("port must be an integer", stderr)
        self.assertIn("ERROR: usage:", stderr)
        self.assertNotIn("usage: usage:", stderr)

    def test_out_of_range_port_exits_2(self):
        code, stderr = self.invoke(["--port", "70000"])
        self.assertEqual(2, code)
        self.assertIn("ERROR: argument --port: port must be between 0 and 65535",
                      stderr)


class QuietHandlerTest(unittest.TestCase):
    def test_request_logging_is_silenced(self):
        # §25.8: the default SimpleHTTPRequestHandler.log_message writes
        # unprefixed request lines to stderr — the demo handler stays silent.
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            view_demo.QuietDemoHandler.log_message(
                object(), "%s", "GET /viewer/index.html HTTP/1.1")
        self.assertEqual("", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
