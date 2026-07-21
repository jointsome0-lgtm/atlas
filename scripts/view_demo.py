#!/usr/bin/env python3
"""Build and serve the invented Atlas demo without writing inside the repo."""
from __future__ import annotations

import argparse
import contextlib
import http.server
import io
import shutil
import sys
import tempfile
from pathlib import Path

import build_atlas_graph


ROOT = Path(__file__).resolve().parents[1]


def port_number(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


class ContractArgumentParser(argparse.ArgumentParser):
    # §25.8 CLI contract: every diagnostic line is prefixed ERROR:, usage
    # errors included — argparse's default error path prints bare lines.
    def error(self, message):
        print(f"ERROR: {message}", file=sys.stderr)
        print(f"ERROR: {self.format_usage().strip()}", file=sys.stderr)
        raise SystemExit(2)


class QuietDemoHandler(http.server.SimpleHTTPRequestHandler):
    # §25.8: request lines are not ERROR:-prefixed diagnostics — stay silent.
    def log_message(self, _format, *_args):
        pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = ContractArgumentParser(
        description="Build and serve the Atlas demo viewer.")
    parser.add_argument("--port", type=port_number, default=8137)
    return parser.parse_args(argv)


def build_demo(destination: Path) -> int:
    output = destination / "graph" / "atlas-graph.json"
    previous = sys.argv
    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    try:
        sys.argv = [
            str(ROOT / "scripts" / "build_atlas_graph.py"),
            str(ROOT / "fixtures" / "demo-instance"),
            str(output),
        ]
        with contextlib.redirect_stdout(captured_stdout), \
                contextlib.redirect_stderr(captured_stderr):
            result = build_atlas_graph.main()
    finally:
        sys.argv = previous
    if result != 0:
        diagnostics = captured_stderr.getvalue()
        if diagnostics:
            sys.stderr.write(diagnostics)
        else:
            print("ERROR: demo graph build failed", file=sys.stderr)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    with tempfile.TemporaryDirectory(prefix="atlas-viewer-") as directory:
        root = Path(directory)
        if build_demo(root) != 0:
            return 1
        shutil.copytree(ROOT / "viewer", root / "viewer")
        handler = QuietDemoHandler
        try:
            server = http.server.ThreadingHTTPServer(
                ("127.0.0.1", args.port),
                lambda *handler_args, **handler_kwargs: handler(
                    *handler_args, directory=str(root), **handler_kwargs),
            )
        except OSError as exc:
            print(f"ERROR: cannot serve demo: {exc}", file=sys.stderr)
            return 1
        port = server.server_address[1]
        print(
            f"serving http://127.0.0.1:{port}/viewer/index.html#mode=field "
            "— Ctrl-C stops",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
