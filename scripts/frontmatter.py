#!/usr/bin/env python3
"""Closed parser for the Atlas §20.4 YAML-shaped grammar.

The public entry points accept bytes and either return one complete parsed
mapping or raise :class:`FrontmatterError`.  No decoding or newline
normalization is delegated to text-mode I/O.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

MAX_DOCUMENT_BYTES = 131_072
MAX_FILE_BYTES = 262_144
MAX_LINE_BYTES = 4_096
MAX_SCALAR_BYTES = 8_192
MAX_DEPTH = 8
MAX_FIELDS = 64
MAX_SEQUENCE_ENTRIES = 1_024
MAX_NODES = 16_384

_KEY_VALUE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$")
_UNSUPPORTED_PREFIXES = ("&", "*", "!", "%")


class FrontmatterError(ValueError):
    """One deterministic, fail-closed §20.4 diagnostic."""


@dataclass(frozen=True)
class _Line:
    text: str
    number: int
    indent: int
    content: str

    @property
    def ignored(self) -> bool:
        return not self.content or self.content.startswith("#")


def _error(source: str | Path, line: int, message: str) -> FrontmatterError:
    return FrontmatterError(f"{source}: frontmatter line {line}: {message}")


def _line_of(data: bytes, offset: int) -> int:
    return data.count(b"\n", 0, offset) + 1


def _validate_file_bytes(data: bytes, source: str | Path) -> None:
    # Whole-file law is §25.8's (UTF-8, no BOM, LF only, the file ceiling);
    # tab/NUL/C0 are §20.4 frontmatter-region rules — the markdown body below
    # the closing fence is outside the grammar and may carry tabs.
    if len(data) > MAX_FILE_BYTES:
        raise _error(source, 1, f"whole file exceeds {MAX_FILE_BYTES} bytes")
    if data.startswith(b"\xef\xbb\xbf"):
        raise _error(source, 1, "UTF-8 BOM is unsupported")
    cr = data.find(b"\r")
    if cr >= 0:
        raise _error(source, _line_of(data, cr), "CR/CRLF is unsupported; use LF")


def _validate_utf8(data: bytes, source: str | Path) -> None:
    try:
        data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise _error(source, _line_of(data, exc.start), "input is not strict UTF-8") from None


def _fenced_region(data: bytes, source: str | Path) -> tuple[bytes, int]:
    """Return body bytes and its physical first-line number.

    The closing fence is located with bounded byte scanning before the input is
    decoded or split, so the document ceiling cannot be hidden by text I/O.
    """
    if not data.startswith(b"---\n"):
        raise _error(source, 1, "opening fence must be the exact line '---'")
    pos = 4
    while pos <= len(data):
        end = data.find(b"\n", pos)
        if end < 0:
            end = len(data)
        line = data[pos:end]
        if line == b"---":
            closing_end = end + (1 if end < len(data) else 0)
            if closing_end > MAX_DOCUMENT_BYTES:
                raise _error(
                    source,
                    _line_of(data, pos),
                    f"frontmatter exceeds {MAX_DOCUMENT_BYTES} bytes",
                )
            return data[4:pos], 2
        if end >= MAX_DOCUMENT_BYTES:
            raise _error(
                source,
                _line_of(data, pos),
                f"frontmatter exceeds {MAX_DOCUMENT_BYTES} bytes",
            )
        if end == len(data):
            break
        pos = end + 1
    raise _error(source, _line_of(data, len(data)), "missing closing fence '---'")


def _validate_region_bytes(
    region: bytes, source: str | Path, first_line: int
) -> list[_Line]:
    if len(region) > MAX_DOCUMENT_BYTES:
        raise _error(
            source, first_line, f"frontmatter exceeds {MAX_DOCUMENT_BYTES} bytes"
        )
    raw_lines = region.split(b"\n")
    lines: list[_Line] = []
    for offset, raw in enumerate(raw_lines):
        number = first_line + offset
        if len(raw) > MAX_LINE_BYTES:
            raise _error(source, number, f"line exceeds {MAX_LINE_BYTES} bytes")
        for index, byte in enumerate(raw):
            if byte == 0x09:
                raise _error(source, number, "tab is unsupported")
            if byte == 0x00:
                raise _error(source, number, "NUL is unsupported")
            if byte < 0x20:
                raise _error(source, number, f"C0 control 0x{byte:02x} is unsupported")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise _error(source, number, "input is not strict UTF-8") from None
        indent = len(text) - len(text.lstrip(" "))
        if text[:indent] != " " * indent:
            raise _error(source, number, "indentation must use ASCII spaces")
        if indent % 2:
            raise _error(source, number, "indentation must be exactly two spaces per level")
        lines.append(_Line(text, number, indent, text[indent:]))
    return lines


class _Parser:
    def __init__(self, lines: list[_Line], source: str | Path):
        self.lines = lines
        self.source = source
        self.nodes = 0

    def fail(self, line: int, message: str):
        raise _error(self.source, line, message)

    def new_node(self, line: int):
        self.nodes += 1
        if self.nodes > MAX_NODES:
            self.fail(line, f"parsed node count exceeds {MAX_NODES}")

    def significant(self, pos: int) -> int:
        while pos < len(self.lines) and self.lines[pos].ignored:
            pos += 1
        return pos

    def parse(self) -> dict:
        pos = self.significant(0)
        if pos == len(self.lines):
            line = self.lines[0].number if self.lines else 1
            self.fail(line, "top-level mapping must be non-empty")
        if self.lines[pos].indent != 0:
            self.fail(self.lines[pos].number, "top-level mapping must start at column zero")
        value, end = self.parse_container(pos, 0, 1)
        end = self.significant(end)
        if end != len(self.lines):
            self.fail(self.lines[end].number, "unexpected content after top-level mapping")
        if not isinstance(value, dict):
            self.fail(self.lines[pos].number, "top-level value must be a mapping")
        return value

    def parse_container(self, pos: int, indent: int, depth: int):
        if depth > MAX_DEPTH:
            line = self.lines[pos].number if pos < len(self.lines) else 1
            self.fail(line, f"nesting depth exceeds {MAX_DEPTH}")
        pos = self.significant(pos)
        if pos >= len(self.lines):
            self.fail(self.lines[-1].number if self.lines else 1, "nested container is empty")
        line = self.lines[pos]
        if line.indent != indent:
            self.fail(line.number, f"expected indentation of {indent} spaces")
        if line.content == "-" or line.content.startswith("- "):
            return self.parse_sequence(pos, indent, depth)
        return self.parse_mapping(pos, indent, depth)

    def parse_mapping(
        self,
        pos: int,
        indent: int,
        depth: int,
        initial: tuple[str, str | None, _Line] | None = None,
    ):
        self.new_node(initial[2].number if initial else self.lines[pos].number)
        result: dict = {}
        fields = 0

        def add(key: str, raw: str | None, line: _Line, next_pos: int) -> int:
            nonlocal fields
            fields += 1
            if fields > MAX_FIELDS:
                self.fail(line.number, f"mapping has more than {MAX_FIELDS} fields")
            if key in result:
                self.fail(line.number, f"duplicate key {key!r}")
            if raw is None:
                child = self.significant(next_pos)
                if child >= len(self.lines) or self.lines[child].indent <= indent:
                    self.fail(line.number, f"bare key {key!r} has no nested container")
                if self.lines[child].indent != indent + 2:
                    self.fail(
                        self.lines[child].number,
                        f"nested value for {key!r} must be indented exactly two spaces",
                    )
                value, consumed = self.parse_container(child, indent + 2, depth + 1)
                result[key] = value
                return consumed
            if raw == ">":
                value, consumed = self.parse_folded(next_pos, indent, line)
                result[key] = value
                self.new_node(line.number)
                return consumed
            result[key] = self.parse_scalar(raw, line.number)
            self.new_node(line.number)
            return next_pos

        if initial:
            pos = add(*initial, pos)
        while True:
            pos = self.significant(pos)
            if pos >= len(self.lines):
                break
            line = self.lines[pos]
            if line.indent < indent:
                break
            if line.indent > indent:
                self.fail(line.number, f"ambiguous indentation; expected {indent} spaces")
            if line.content == "-" or line.content.startswith("- "):
                self.fail(line.number, "mapping and sequence entries cannot mix")
            match = _KEY_VALUE_RE.fullmatch(line.content)
            if not match:
                self.fail(line.number, "expected 'key: value' mapping entry")
            pos = add(match.group(1), match.group(2), line, pos + 1)
        if not result:
            line = initial[2].number if initial else self.lines[pos].number
            self.fail(line, "mapping must be non-empty")
        return result, pos

    def parse_sequence(self, pos: int, indent: int, depth: int):
        self.new_node(self.lines[pos].number)
        result: list = []
        item_kind: str | None = None
        while True:
            pos = self.significant(pos)
            if pos >= len(self.lines):
                break
            line = self.lines[pos]
            if line.indent < indent:
                break
            if line.indent > indent:
                self.fail(line.number, f"ambiguous indentation; expected {indent} spaces")
            if line.content == "-":
                self.fail(line.number, "a bare sequence marker has no value")
            if not line.content.startswith("- "):
                self.fail(line.number, "mapping and sequence entries cannot mix")
            if len(result) >= MAX_SEQUENCE_ENTRIES:
                self.fail(line.number, f"sequence has more than {MAX_SEQUENCE_ENTRIES} entries")
            raw = line.content[2:]
            mapping = _KEY_VALUE_RE.fullmatch(raw)
            kind = "mapping" if mapping else "scalar"
            if item_kind is not None and kind != item_kind:
                self.fail(line.number, "scalar and mapping sequence entries cannot mix")
            item_kind = kind
            if mapping:
                value, pos = self.parse_mapping(
                    pos + 1,
                    indent + 2,
                    depth + 1,
                    (mapping.group(1), mapping.group(2), line),
                )
                result.append(value)
            else:
                if raw.strip() == "[]":
                    self.fail(line.number, "sequences cannot contain nested sequences")
                result.append(self.parse_scalar(raw, line.number))
                self.new_node(line.number)
                pos += 1
        return result, pos

    def parse_folded(self, pos: int, parent_indent: int, owner: _Line):
        parts: list[str] = []
        while pos < len(self.lines):
            line = self.lines[pos]
            if not line.content:
                if line.indent > parent_indent or (parts and pos != len(self.lines) - 1):
                    self.fail(line.number, "blank folded-text continuation is unsupported")
                break
            if line.indent <= parent_indent:
                break
            if line.indent != parent_indent + 2:
                self.fail(
                    line.number, "folded text must be indented exactly two spaces"
                )
            if line.content.startswith("#"):
                pos += 1
                continue
            parts.append(line.content.strip())
            pos += 1
        if not parts:
            self.fail(owner.number, "folded text must have a non-empty continuation")
        value = " ".join(parts)
        self.check_scalar_size(value, owner.number)
        return value, pos

    def check_scalar_size(self, value: str, line: int):
        for char in value:
            codepoint = ord(char)
            if codepoint < 0x20 and char != "\n":
                self.fail(line, f"scalar contains unsupported C0 control 0x{codepoint:02x}")
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError:
            self.fail(line, "scalar contains an unsupported Unicode surrogate")
        if len(encoded) > MAX_SCALAR_BYTES:
            self.fail(line, f"scalar exceeds {MAX_SCALAR_BYTES} bytes")

    def parse_scalar(self, raw: str, line: int):
        value = raw.strip()
        if value == "":
            self.fail(line, 'empty scalar must be written as ""')
        if value == "[]":
            return []
        if value.startswith("|"):
            self.fail(line, "literal block scalar '|' is unsupported")
        if value.startswith(">"):
            self.fail(line, "folded-text chomping indicators are unsupported")
        if value.startswith("'"):
            self.fail(line, "single-quoted scalars are unsupported")
        if value.startswith('"'):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                self.fail(line, "double-quoted scalar must use JSON string escaping")
            if not isinstance(decoded, str):
                self.fail(line, "quoted scalar must decode to a string")
            self.check_scalar_size(decoded, line)
            return decoded
        if value.startswith(_UNSUPPORTED_PREFIXES) or value == "<<" or value.startswith("<<:"):
            self.fail(line, "anchors, aliases, tags, merge keys, and directives are unsupported")
        if value in ("---", "..."):
            self.fail(line, "multiple documents are unsupported")
        if any(char in value for char in "{}[]"):
            self.fail(line, "flow-style collections are unsupported")
        self.check_scalar_size(value, line)
        return value


def parse_frontmatter(data: bytes, source: str | Path = "<bytes>") -> dict:
    """Parse one fenced Markdown frontmatter mapping from raw bytes."""
    if not isinstance(data, bytes):
        raise TypeError("parse_frontmatter expects bytes")
    _validate_file_bytes(data, source)
    region, first_line = _fenced_region(data, source)
    lines = _validate_region_bytes(region, source, first_line)
    _validate_utf8(data, source)
    return _Parser(lines, source).parse()


def parse_document(data: bytes, source: str | Path = "<bytes>") -> dict:
    """Parse the fence-less top-level mapping used by §21.2 plan extracts."""
    if not isinstance(data, bytes):
        raise TypeError("parse_document expects bytes")
    _validate_file_bytes(data, source)
    if len(data) > MAX_DOCUMENT_BYTES:
        raise _error(source, 1, f"frontmatter exceeds {MAX_DOCUMENT_BYTES} bytes")
    lines = _validate_region_bytes(data, source, 1)
    for line in lines:
        if line.indent == 0 and line.content in ("---", "..."):
            raise _error(source, line.number, "fences and multiple documents are unsupported")
        if line.indent == 0 and line.content.startswith("%"):
            raise _error(source, line.number, "directives are unsupported")
    return _Parser(lines, source).parse()


__all__ = [
    "FrontmatterError",
    "MAX_DEPTH",
    "MAX_DOCUMENT_BYTES",
    "MAX_FIELDS",
    "MAX_FILE_BYTES",
    "MAX_LINE_BYTES",
    "MAX_NODES",
    "MAX_SCALAR_BYTES",
    "MAX_SEQUENCE_ENTRIES",
    "parse_document",
    "parse_frontmatter",
]
