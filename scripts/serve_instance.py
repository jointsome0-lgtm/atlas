#!/usr/bin/env python3
"""Serve one private instance's viewer over a stable loopback origin (#112).

The viewer is static and fetches ``../graph/atlas-graph.json`` relatively, so
it needs an HTTP origin where ``viewer/`` and ``graph/`` are siblings.  This
script mounts exactly that pair: the viewer files of the engine checkout it
ships with, and the instance's emitted graph — nothing else.

Read-only by construction (§24): an explicit 127.0.0.1 bind, GET/HEAD only, a
closed route table computed at startup (no directory listing, no path
traversal, no write path), and every read repeats the §24.2 no-follow
containment checks.  Building the graph stays with build_atlas_graph.py — a
serving command never writes into the instance.
"""
from __future__ import annotations

import argparse
import http.server
import os
import sys
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path

from atlas_reader import AtlasReader, ReaderError

ROOT = Path(__file__).resolve().parents[1]

# An embedding shell allowlists this origin in its CSP frame-src (§16.4,
# ephemeris#108), so the port is a published default, never incidental.
DEFAULT_PORT = 8138

# The port an http client leaves out of its Host header.
HTTP_DEFAULT_PORT = 80

# Response bodies leave the server in chunks of this size, never whole.
BODY_CHUNK_BYTES = 65536

GRAPH_RELATIVE_PATH = "graph/atlas-graph.json"
GRAPH_ROUTE = "/graph/atlas-graph.json"
VIEWER_ROUTE_PREFIX = "/viewer/"
INDEX_ROUTE = VIEWER_ROUTE_PREFIX + "index.html"

# Fail-closed content typing: a viewer file whose suffix is not listed here is
# not routed at all, so no response type is ever guessed or sniffed.
CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
}

# Routes are matched against the raw request path, never a percent-decoded one
# (decoding is the traversal surface), so a routable name must need no
# encoding.
_UNRESERVED = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._")


def printable(value: object) -> str:
    """Render a value with every non-printable character folded to `?`."""

    return "".join(
        character if character.isprintable() else "?"
        for character in str(value))


def diagnose(message: object) -> None:
    """Write one ERROR:-prefixed line per line of a message.

    A caller-supplied path can carry a newline, and argparse quotes the
    arguments it was given: without this a single argument could split a
    diagnostic into an unprefixed second line (§25.8) or smuggle control
    characters into it (§24.4).
    """

    for line in printable(message).split("\n"):
        print(f"ERROR: {line}", file=sys.stderr, flush=True)


class ContractArgumentParser(argparse.ArgumentParser):
    # §25.8 CLI contract: every diagnostic line is prefixed ERROR:, usage
    # errors included — argparse's default error path prints bare lines, and
    # its messages quote the arguments the caller supplied.
    def error(self, message):
        diagnose(message)
        diagnose(self.format_usage().strip())
        raise SystemExit(2)


@dataclass(frozen=True)
class Route:
    """One served file, re-opened under §24.2 containment on every request."""

    reader: AtlasReader
    relative_path: str
    content_type: str

    def open(self):
        """Open the file no-follow, or return None when it is not there."""

        scanned = self.reader.optional_file(self.relative_path)
        if scanned is None:
            return None
        return scanned.open("rb")


def port_number(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if port == 0:
        # Port 0 asks the kernel for whatever is free; a shell that has to
        # allowlist the origin cannot allowlist a surprise (§16.4).
        raise argparse.ArgumentTypeError(
            "port must be fixed: 0 picks a random port and the embedding "
            "shell pins one origin")
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = ContractArgumentParser(
        description="Serve a private Atlas instance's viewer on 127.0.0.1.")
    parser.add_argument(
        "instance", metavar="INSTANCE_DIR",
        help="private instance root holding graph/atlas-graph.json; atlas "
             "never guesses or remembers its location")
    parser.add_argument(
        "--port", type=port_number, default=DEFAULT_PORT,
        help=f"loopback port (default {DEFAULT_PORT}); the embed's fixed origin")
    args, unrecognized = parser.parse_known_args(argv)
    if unrecognized:
        # argparse would quote the rejected arguments verbatim, and a
        # mistyped option can carry a token: the count is the diagnostic
        # (§24.4), the usage line says what was expected.
        parser.error(f"{len(unrecognized)} unrecognized argument(s); values "
                     f"withheld")
    return args


def build_routes(
    viewer_reader: AtlasReader, instance_reader: AtlasReader
) -> dict[str, Route]:
    """Compute the closed route table: the engine's viewer plus one graph."""

    routes: dict[str, Route] = {}
    for scanned in viewer_reader.scan("."):
        content_type = CONTENT_TYPES.get(Path(scanned.name).suffix)
        if content_type is None or not set(scanned.name) <= _UNRESERVED:
            continue
        routes[VIEWER_ROUTE_PREFIX + scanned.name] = Route(
            viewer_reader, scanned.name, content_type)
    routes[GRAPH_ROUTE] = Route(
        instance_reader, GRAPH_RELATIVE_PATH, CONTENT_TYPES[".json"])
    return routes


def origins_for(port: int) -> frozenset[str]:
    """The Host values that address this server — and no others.

    The origin atlas announces, plus the name a person is as likely to type;
    both resolve to loopback and neither is attacker-choosable. On port 80 a
    client leaves the port out of Host, so the bare names address it too.
    """

    names = ("127.0.0.1", "localhost")
    origins = [f"{name}:{port}" for name in names]
    if port == HTTP_DEFAULT_PORT:
        origins.extend(names)
    return frozenset(origins)


class InstanceViewerHandler(http.server.BaseHTTPRequestHandler):
    """GET/HEAD over the route table; every other method is 501 by default."""

    server_version = "atlas"
    sys_version = ""

    # A connection that stops talking mid-request holds a worker thread; the
    # deadline bounds it. Loopback clients never need longer.
    timeout = 10

    # §25.8: request lines are not ERROR:-prefixed diagnostics — stay silent.
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        self._serve(with_body=True)

    def do_HEAD(self):
        self._serve(with_body=False)

    def _host_is_ours(self) -> bool:
        """Refuse a request addressed to any name but our own origin.

        A browser sends whatever host the page was loaded from, so an
        attacker's domain re-pointed at 127.0.0.1 (DNS rebinding) would
        otherwise read the instance from a page atlas never served.
        """

        hosts = self.headers.get_all("Host") or []
        return len(hosts) == 1 and hosts[0].lower() in self.server.origins

    def _serve(self, *, with_body: bool) -> None:
        if not self._host_is_ours():
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        # Exact match against the raw request target — no decoding, no
        # normalization, no query tolerance: the two paths the viewer asks
        # for are the two paths that answer, and traversal has nothing to
        # walk through.
        route = self.server.routes.get(self.path)
        if route is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            stream = route.open()
        except FileNotFoundError:
            stream = None
        except (ReaderError, OSError) as exc:
            # A containment refusal is worth an operator diagnostic; the
            # reader's text carries a path and a reason, never content (§24.4).
            diagnose(exc)
            stream = None
        if stream is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        with stream:
            try:
                size = os.fstat(stream.fileno()).st_size
            except OSError as exc:
                diagnose(exc)
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", route.content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if with_body:
                self._send_body(stream, size)

    def _send_body(self, stream, size: int) -> None:
        # Bounded chunks: the graph may be tens of megabytes (§25.8), and a
        # HEAD or a second request must not double a whole file in memory.
        # The builder replaces the graph atomically, so this descriptor keeps
        # serving the bytes fstat measured.
        remaining = size
        while remaining > 0:
            chunk = stream.read(min(BODY_CHUNK_BYTES, remaining))
            if not chunk:
                return
            self.wfile.write(chunk)
            remaining -= len(chunk)


class InstanceViewerServer(http.server.ThreadingHTTPServer):
    """Loopback-bound server carrying its own closed route table."""

    def __init__(self, address: tuple[str, int], routes: dict[str, Route]):
        self.routes = routes
        super().__init__(address, InstanceViewerHandler)
        self.origins = origins_for(self.server_address[1])

    def handle_error(self, request, client_address):
        # The inherited handler prints a traceback with absolute paths and
        # request data (§24.4); a disconnecting client is not an error at all.
        exception = sys.exc_info()[1]
        if isinstance(exception, (ConnectionError, TimeoutError)):
            return
        diagnose(f"request failed: {type(exception).__name__}")


def open_readers(instance: Path) -> tuple[AtlasReader, AtlasReader] | None:
    """Validate both roots and the served graph, or diagnose and give up."""

    try:
        instance_reader = AtlasReader(instance)
        graph = instance_reader.optional_file(GRAPH_RELATIVE_PATH)
    except ReaderError as exc:
        diagnose(f"{printable(instance)}: {exc}")
        return None
    if graph is None:
        shown = printable(instance)
        diagnose(f"{shown}/{GRAPH_RELATIVE_PATH}: not found; build it "
                 f"first with scripts/build_atlas_graph.py {shown}/atlas "
                 f"{shown}/{GRAPH_RELATIVE_PATH}")
        return None
    try:
        viewer_reader = AtlasReader(ROOT / "viewer")
    except ReaderError as exc:
        diagnose(f"{ROOT / 'viewer'}: {exc}")
        return None
    return viewer_reader, instance_reader


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    instance = Path(args.instance)
    readers = open_readers(instance)
    if readers is None:
        return 1
    viewer_reader, instance_reader = readers
    try:
        routes = build_routes(viewer_reader, instance_reader)
    except ReaderError as exc:
        diagnose(f"{viewer_reader.root}: {exc}")
        return 1
    if INDEX_ROUTE not in routes:
        diagnose(f"{viewer_reader.root / 'index.html'}: not found; this "
                 f"engine checkout has no viewer to serve")
        return 1
    try:
        # Explicit loopback bind (§24): the instance is personal state, and
        # 0.0.0.0 would offer it to the network the moment one exists.
        server = InstanceViewerServer(("127.0.0.1", args.port), routes)
    except OSError as exc:
        diagnose(f"cannot serve {printable(instance)}: {exc}")
        return 1
    print(f"serving http://127.0.0.1:{args.port}{INDEX_ROUTE}#mode=field "
          f"— read-only view of {printable(instance)} — Ctrl-C stops",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
