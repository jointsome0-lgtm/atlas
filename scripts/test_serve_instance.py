"""Contract and behaviour tests for serve_instance (#112).

The serving surface is the security surface: these tests pin the closed route
table, the loopback bind, the absence of any write or listing path, and the
per-request §24.2 containment checks.
"""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

import serve_instance
from atlas_reader import AtlasReader

ROOT = Path(__file__).resolve().parents[1]
DEMO_GRAPH = ROOT / "fixtures" / "demo-graph" / "atlas-graph.json"
VIEWER_FILES = ("index.html", "viewer.js", "viewer.css", "contract.js",
                "favicon.svg")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def raw_request(address: tuple[str, int], request: str) -> tuple[int, bytes]:
    """Send a request byte-for-byte, past http.client's own header rules."""

    with socket.create_connection(address, timeout=10) as connection:
        connection.sendall(request.encode("ascii"))
        chunks = []
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    answer = b"".join(chunks)
    status = int(answer.split(b" ", 2)[1]) if answer else 0
    return status, answer


def make_instance(root: Path) -> Path:
    """Lay out a private instance: an emitted graph plus curated content."""

    (root / "graph").mkdir(parents=True)
    shutil.copyfile(DEMO_GRAPH, root / "graph" / "atlas-graph.json")
    (root / "atlas" / "concepts").mkdir(parents=True)
    # Invented content in the shape of private instance data, marked as the
    # synthetic persona's the way committed fixtures are (AGENTS.md).
    (root / "atlas" / "concepts" / "idempotency.md").write_text(
        "curated content authored by Vera Example, never real\n",
        encoding="utf-8")
    (root / "state").mkdir()
    (root / "state" / "encounters.jsonl").write_text(
        '{"note": "Vera Example"}\n', encoding="utf-8")
    return root


class UsageContractTest(unittest.TestCase):
    def invoke(self, argv: list[str]) -> tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                serve_instance.parse_args(argv)
        return caught.exception.code, stderr.getvalue()

    def assert_prefixed(self, stderr: str) -> None:
        lines = stderr.splitlines()
        self.assertTrue(lines)
        for line in lines:
            self.assertTrue(line.startswith("ERROR: "), line)

    def test_instance_directory_is_required(self):
        # Atlas is blind to where the instance lives: no default, no
        # environment variable, no current-directory guess.
        code, stderr = self.invoke([])
        self.assertEqual(2, code)
        self.assert_prefixed(stderr)
        self.assertIn("INSTANCE_DIR", stderr)
        self.assertIn("ERROR: usage:", stderr)

    def test_unrecognized_arguments_are_counted_never_quoted(self):
        # §24.4: a mistyped option can carry a token, and argparse would
        # print it verbatim.
        code, stderr = self.invoke(
            ["/tmp/one", "/tmp/two", "--unknown=private-token"])
        self.assertEqual(2, code)
        self.assert_prefixed(stderr)
        self.assertIn("2 unrecognized argument(s); values withheld", stderr)
        self.assertNotIn("private-token", stderr)
        self.assertNotIn("/tmp/two", stderr)

    def test_bad_port_exits_2_with_prefixed_lines(self):
        code, stderr = self.invoke(["/tmp/instance", "--port", "nope"])
        self.assertEqual(2, code)
        self.assert_prefixed(stderr)
        self.assertIn("port must be an integer", stderr)
        self.assertNotIn("usage: usage:", stderr)

    def test_out_of_range_port_exits_2(self):
        code, stderr = self.invoke(["/tmp/instance", "--port", "70000"])
        self.assertEqual(2, code)
        self.assertIn("port must be between 1 and 65535", stderr)

    def test_ephemeral_port_is_refused(self):
        # The embed pins one origin in its CSP frame-src (§16.4): a port the
        # kernel picks cannot be allowlisted.
        code, stderr = self.invoke(["/tmp/instance", "--port", "0"])
        self.assertEqual(2, code)
        self.assertIn("port must be fixed", stderr)

    def test_default_port_is_the_published_origin(self):
        args = serve_instance.parse_args(["/tmp/instance"])
        self.assertEqual(serve_instance.DEFAULT_PORT, args.port)
        self.assertEqual(8138, serve_instance.DEFAULT_PORT)


class AddressedHostTest(unittest.TestCase):
    def test_a_named_port_is_part_of_every_accepted_host(self):
        self.assertEqual({"127.0.0.1:8138", "localhost:8138"},
                         set(serve_instance.origins_for(8138)))

    def test_port_80_also_accepts_the_bare_host_clients_send(self):
        # An http client omits :80 from Host, so refusing the bare form would
        # reject every request the viewer makes on that port.
        self.assertEqual(
            {"127.0.0.1:80", "localhost:80", "127.0.0.1", "localhost"},
            set(serve_instance.origins_for(80)))


class StartupContractTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="atlas-serve-")
        self.addCleanup(directory.cleanup)
        self.instance = make_instance(Path(directory.name) / "instance")

    def run_main(self, argv: list[str]) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            code = serve_instance.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_missing_instance_directory_fails_before_binding(self):
        code, _, stderr = self.run_main([str(self.instance / "absent")])
        self.assertEqual(1, code)
        self.assertTrue(stderr.startswith("ERROR: "), stderr)
        self.assertIn("invalid-root", stderr)

    def test_instance_without_a_graph_names_the_builder(self):
        (self.instance / "graph" / "atlas-graph.json").unlink()
        code, _, stderr = self.run_main([str(self.instance)])
        self.assertEqual(1, code)
        self.assertIn("graph/atlas-graph.json: not found", stderr)
        self.assertIn("build_atlas_graph.py", stderr)

    def test_serving_never_builds_the_graph(self):
        # Read-only: a missing graph is refused, never produced (§24).
        (self.instance / "graph" / "atlas-graph.json").unlink()
        self.run_main([str(self.instance)])
        self.assertEqual([], list((self.instance / "graph").iterdir()))

    def test_symlinked_graph_is_refused(self):
        target = self.instance.parent / "outside.json"
        target.write_text("{}\n", encoding="utf-8")
        graph = self.instance / "graph" / "atlas-graph.json"
        graph.unlink()
        graph.symlink_to(target)
        code, _, stderr = self.run_main([str(self.instance)])
        self.assertEqual(1, code)
        self.assertIn("unsafe-path", stderr)

    def test_instance_reached_through_a_symlinked_root_is_refused(self):
        link = self.instance.parent / "link-to-instance"
        link.symlink_to(self.instance)
        code, _, stderr = self.run_main([str(link)])
        self.assertEqual(1, code)
        self.assertIn("invalid-root", stderr)


class RouteTableTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="atlas-serve-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.instance = make_instance(root / "instance")
        self.viewer = root / "viewer"
        self.viewer.mkdir()
        for name in VIEWER_FILES:
            (self.viewer / name).write_text(name, encoding="utf-8")

    def routes(self, viewer: Path) -> dict[str, serve_instance.Route]:
        return serve_instance.build_routes(
            AtlasReader(viewer), AtlasReader(self.instance))

    def test_table_holds_the_viewer_files_and_one_graph(self):
        self.assertEqual(
            {f"/viewer/{name}" for name in VIEWER_FILES}
            | {"/graph/atlas-graph.json"},
            set(self.routes(self.viewer)))

    def test_untyped_and_encodable_names_are_not_routed(self):
        (self.viewer / "notes.md").write_text("x", encoding="utf-8")
        (self.viewer / "sub dir.html").write_text("x", encoding="utf-8")
        routes = self.routes(self.viewer)
        self.assertNotIn("/viewer/notes.md", routes)
        self.assertNotIn("/viewer/sub dir.html", routes)

    def test_nested_viewer_directories_are_not_routed(self):
        (self.viewer / "vendor").mkdir()
        (self.viewer / "vendor" / "extra.js").write_text("x", encoding="utf-8")
        self.assertNotIn("/viewer/vendor/extra.js", self.routes(self.viewer))

    def test_shipped_viewer_directory_routes_its_entry_point(self):
        routes = self.routes(ROOT / "viewer")
        self.assertIn(serve_instance.INDEX_ROUTE, routes)
        self.assertEqual(
            "text/html; charset=utf-8",
            routes[serve_instance.INDEX_ROUTE].content_type)


class ServedSurfaceTest(unittest.TestCase):
    """One live server: what it answers, and everything it refuses."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="atlas-serve-")
        cls.instance = make_instance(Path(cls.directory.name) / "instance")
        cls.graph_path = cls.instance / "graph" / "atlas-graph.json"
        routes = serve_instance.build_routes(
            AtlasReader(ROOT / "viewer"), AtlasReader(cls.instance))
        # Port 0 here: the fixed default is a CLI contract (tested in
        # UsageContractTest), and an in-process test that pins a port races
        # every other process on the machine.
        cls.server = serve_instance.InstanceViewerServer(("127.0.0.1", 0),
                                                         routes)
        cls.thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.address = cls.server.server_address

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.directory.cleanup()

    def request(self, path: str, method: str = "GET", host: str | None = None):
        connection = http.client.HTTPConnection(*self.address, timeout=10)
        try:
            headers = {} if host is None else {"Host": host}
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def restore_graph_after_test(self) -> bytes:
        original = self.graph_path.read_bytes()

        def restore():
            self.graph_path.unlink(missing_ok=True)
            self.graph_path.write_bytes(original)

        self.addCleanup(restore)
        return original

    def test_bind_is_loopback_only(self):
        self.assertEqual("127.0.0.1", self.address[0])

    def test_viewer_entry_point_is_served_with_hardened_headers(self):
        status, headers, body = self.request("/viewer/index.html")
        self.assertEqual(200, status)
        self.assertEqual((ROOT / "viewer" / "index.html").read_bytes(), body)
        self.assertEqual("text/html; charset=utf-8", headers["Content-Type"])
        self.assertEqual(str(len(body)), headers["Content-Length"])
        self.assertEqual("no-store", headers["Cache-Control"])
        self.assertEqual("nosniff", headers["X-Content-Type-Options"])
        self.assertEqual("no-referrer", headers["Referrer-Policy"])

    def test_every_viewer_asset_is_served_verbatim(self):
        for name, content_type in (
            ("viewer.js", "text/javascript; charset=utf-8"),
            ("contract.js", "text/javascript; charset=utf-8"),
            ("viewer.css", "text/css; charset=utf-8"),
            ("favicon.svg", "image/svg+xml"),
        ):
            with self.subTest(name=name):
                status, headers, body = self.request(f"/viewer/{name}")
                self.assertEqual(200, status)
                self.assertEqual(content_type, headers["Content-Type"])
                self.assertEqual((ROOT / "viewer" / name).read_bytes(), body)

    def test_graph_is_served_from_the_instance(self):
        # This is the relative fetch the viewer makes from /viewer/.
        status, headers, body = self.request("/graph/atlas-graph.json")
        self.assertEqual(200, status)
        self.assertEqual("application/json", headers["Content-Type"])
        self.assertEqual(self.graph_path.read_bytes(), body)
        self.assertIn("nodes", json.loads(body))

    def test_leading_slash_run_resolves_to_the_same_route(self):
        # http.server collapses a leading "//" before the handler sees it
        # (parse_request), so the alias reaches the same file — pinned here so
        # the exact-match table is never credited with rejecting it.
        _, _, body = self.request("//graph/atlas-graph.json")
        self.assertEqual(self.graph_path.read_bytes(), body)

    def test_head_answers_without_a_body(self):
        status, headers, body = self.request("/viewer/index.html", "HEAD")
        self.assertEqual(200, status)
        self.assertEqual(b"", body)
        self.assertNotEqual("0", headers["Content-Length"])

    def test_a_rebuilt_graph_is_reread_per_request(self):
        original = self.restore_graph_after_test()
        _, _, before = self.request("/graph/atlas-graph.json")
        self.assertEqual(original, before)
        # The builder replaces the file atomically, so a server holding one
        # descriptor or one cached body would keep serving the old inode.
        rebuilt = b'{"version": 1, "nodes": [], "edges": []}\n'
        replacement = self.graph_path.with_suffix(".json.tmp")
        replacement.write_bytes(rebuilt)
        os.replace(replacement, self.graph_path)
        _, headers, after = self.request("/graph/atlas-graph.json")
        self.assertEqual(rebuilt, after)
        self.assertEqual(str(len(rebuilt)), headers["Content-Length"])

    def test_a_large_graph_is_streamed_whole(self):
        # Bodies leave in chunks; the framing must still match the file.
        self.restore_graph_after_test()
        big = b'{"filler": "' + b"x" * (3 * serve_instance.BODY_CHUNK_BYTES)
        big += b'"}\n'
        self.graph_path.write_bytes(big)
        _, headers, body = self.request("/graph/atlas-graph.json")
        self.assertEqual(str(len(big)), headers["Content-Length"])
        self.assertEqual(big, body)

    def test_head_of_a_large_graph_reports_its_size(self):
        self.restore_graph_after_test()
        big = b"x" * (2 * serve_instance.BODY_CHUNK_BYTES + 7)
        self.graph_path.write_bytes(big)
        _, headers, body = self.request("/graph/atlas-graph.json", "HEAD")
        self.assertEqual(str(len(big)), headers["Content-Length"])
        self.assertEqual(b"", body)

    def test_a_foreign_host_header_is_refused(self):
        # DNS rebinding: an attacker's name re-pointed at 127.0.0.1 must not
        # read the instance from a page atlas never served.
        for host in ("attacker.example", f"attacker.example:{self.address[1]}",
                     f"127.0.0.1.attacker.example:{self.address[1]}"):
            with self.subTest(host=host):
                status, _, body = self.request(
                    "/graph/atlas-graph.json", host=host)
                self.assertEqual(400, status)
                self.assertNotIn(b"nodes", body)

    def test_the_two_loopback_names_are_accepted(self):
        for host in (f"127.0.0.1:{self.address[1]}",
                     f"LOCALHOST:{self.address[1]}"):
            with self.subTest(host=host):
                status, _, _ = self.request("/viewer/index.html", host=host)
                self.assertEqual(200, status)

    def test_a_missing_or_repeated_host_header_is_refused(self):
        port = self.address[1]
        for headers in ("", f"Host: 127.0.0.1:{port}\r\n" * 2):
            with self.subTest(headers=headers):
                status, body = raw_request(
                    self.address,
                    f"GET /graph/atlas-graph.json HTTP/1.0\r\n{headers}\r\n")
                self.assertEqual(400, status)
                self.assertNotIn(b'"nodes"', body)

    def test_nothing_outside_the_two_routes_is_reachable(self):
        for path in (
            "/",
            "/viewer/",
            "/viewer",
            "/graph/",
            "/atlas/concepts/idempotency.md",
            "/state/encounters.jsonl",
            "/viewer/index.html/",
            "/VIEWER/index.html",
            "/viewer/index.html?cache=0",
        ):
            with self.subTest(path=path):
                status, _, _ = self.request(path)
                self.assertEqual(404, status)

    def test_traversal_shapes_are_refused(self):
        for path in (
            "/viewer/../graph/atlas-graph.json",
            "/viewer/../../etc/passwd",
            "/viewer/%2e%2e/graph/atlas-graph.json",
            "/graph/%2e%2e/atlas/concepts/idempotency.md",
            "/viewer/index.html%00.txt",
        ):
            with self.subTest(path=path):
                status, _, _ = self.request(path)
                self.assertEqual(404, status)

    def test_a_404_body_never_echoes_the_requested_path(self):
        # §24.4: a refused request is a generic answer, not a mirror.
        _, _, body = self.request("/atlas/concepts/idempotency.md")
        self.assertNotIn(b"idempotency", body)

    def test_no_route_accepts_a_write(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            with self.subTest(method=method):
                status, _, _ = self.request("/graph/atlas-graph.json", method)
                self.assertEqual(501, status)
        self.assertEqual(DEMO_GRAPH.read_bytes(), self.graph_path.read_bytes())

    def test_a_graph_swapped_for_a_symlink_is_refused_while_serving(self):
        self.restore_graph_after_test()
        outside = self.instance.parent / "outside.json"
        outside.write_text('{"leaked": true}\n', encoding="utf-8")
        self.graph_path.unlink()
        self.graph_path.symlink_to(outside)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            status, _, body = self.request("/graph/atlas-graph.json")
        self.assertEqual(404, status)
        self.assertNotIn(b"leaked", body)
        self.assertIn("ERROR: ", stderr.getvalue())
        self.assertIn("unsafe-path", stderr.getvalue())

    def test_a_deleted_graph_answers_404_without_noise(self):
        self.restore_graph_after_test()
        self.graph_path.unlink()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            status, _, _ = self.request("/graph/atlas-graph.json")
        self.assertEqual(404, status)
        self.assertEqual("", stderr.getvalue())

    def test_request_logging_is_silenced(self):
        # §25.8: request lines are not ERROR:-prefixed diagnostics.
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            serve_instance.InstanceViewerHandler.log_message(
                object(), "%s", "GET /viewer/index.html HTTP/1.1")
        self.assertEqual("", stderr.getvalue())


class FailureDiagnosticTest(unittest.TestCase):
    """Nothing reaches stderr unprefixed, and no traceback ever does."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="atlas-serve-")
        self.addCleanup(directory.cleanup)
        self.instance = make_instance(Path(directory.name) / "instance")
        self.server = serve_instance.InstanceViewerServer(
            ("127.0.0.1", 0),
            serve_instance.build_routes(
                AtlasReader(ROOT / "viewer"), AtlasReader(self.instance)))
        self.addCleanup(self.server.server_close)

    def capture(self, call) -> str:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            call()
        return stderr.getvalue()

    def test_a_disconnecting_client_is_not_an_error(self):
        for error in (BrokenPipeError(), ConnectionResetError(),
                      TimeoutError()):
            with self.subTest(error=type(error).__name__):
                def raise_and_handle():
                    try:
                        raise error
                    except OSError:
                        self.server.handle_error(None, ("127.0.0.1", 1))

                self.assertEqual("", self.capture(raise_and_handle))

    def test_an_unexpected_failure_is_one_line_without_a_traceback(self):
        def raise_and_handle():
            try:
                raise ValueError("/home/someone/instance/state/secrets.jsonl")
            except ValueError:
                self.server.handle_error(None, ("127.0.0.1", 1))

        stderr = self.capture(raise_and_handle)
        self.assertEqual(["ERROR: request failed: ValueError"],
                         stderr.splitlines())
        self.assertNotIn("Traceback", stderr)

    def test_a_stalled_connection_is_dropped_on_the_deadline(self):
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)
        with unittest.mock.patch.object(
                serve_instance.InstanceViewerHandler, "timeout", 0.5):
            with socket.create_connection(
                    self.server.server_address, timeout=10) as connection:
                connection.sendall(b"GET /viewer/index.html")  # no line end
                self.assertEqual(b"", connection.recv(65536))

    def test_an_enormous_path_is_cut_not_printed_whole(self):
        # §24.4 wants the path named and the line bounded; a caller can hand
        # the command an argument far longer than any real path.
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            code = serve_instance.main(["/" + "p" * 200_000])
        self.assertEqual(1, code)
        for line in captured.getvalue().splitlines():
            self.assertLess(len(line), serve_instance.PATH_DIAGNOSTIC_LIMIT
                            + 200)
        self.assertIn("…", captured.getvalue())

    def test_a_path_with_a_newline_cannot_split_a_diagnostic(self):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            code = serve_instance.main([f"{self.instance}\nSECOND-LINE"])
        self.assertEqual(1, code)
        lines = captured.getvalue().splitlines()
        self.assertTrue(lines)
        for line in lines:
            self.assertTrue(line.startswith("ERROR: "), line)
        self.assertIn("SECOND-LINE", captured.getvalue())

    def test_an_argument_with_a_newline_cannot_split_a_usage_error(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                serve_instance.parse_args(
                    [str(self.instance), "extra\nSECOND-LINE"])
        self.assertEqual(2, caught.exception.code)
        for line in stderr.getvalue().splitlines():
            self.assertTrue(line.startswith("ERROR: "), line)
        self.assertNotIn("SECOND-LINE", stderr.getvalue())


class AddressInUse(Exception):
    """The probed port was taken before the command could bind it."""


class CommandLineSmokeTest(unittest.TestCase):
    """The announced URL is the deliverable: run the command and fetch it."""

    def test_announced_url_serves_the_viewer_and_the_graph(self):
        directory = tempfile.TemporaryDirectory(prefix="atlas-serve-")
        self.addCleanup(directory.cleanup)
        instance = make_instance(Path(directory.name) / "instance")
        # The CLI refuses port 0 by contract, so the test must name a port —
        # and another process may have taken it between probe and bind.
        for _ in range(3):
            try:
                self.serve_and_fetch(instance, free_port())
                return
            except AddressInUse:
                continue
        self.fail("no free port survived three attempts")

    def serve_and_fetch(self, instance: Path, port: int) -> None:
        with subprocess.Popen(
            [sys.executable, str(ROOT / "scripts" / "serve_instance.py"),
             str(instance), "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ) as process:
            try:
                announcement = process.stdout.readline()
                if not announcement:
                    raise AddressInUse(process.stderr.read())
                self.assertIn(f"http://127.0.0.1:{port}/viewer/index.html",
                              announcement)
                self.assertIn(str(instance), announcement)
                self.assertIn(b"<title>Atlas</title>",
                              self.fetch(port, "/viewer/index.html"))
                self.assertEqual(DEMO_GRAPH.read_bytes(),
                                 self.fetch(port, "/graph/atlas-graph.json"))
            finally:
                process.terminate()

    def fetch(self, port: int, path: str) -> bytes:
        deadline = time.monotonic() + 10
        while True:
            connection = http.client.HTTPConnection(
                "127.0.0.1", port, timeout=10)
            try:
                connection.request("GET", path)
                response = connection.getresponse()
                self.assertEqual(200, response.status)
                return response.read()
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
