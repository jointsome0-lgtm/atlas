#!/usr/bin/env python3
"""Shared, lane-neutral I/O primitives for Atlas instance writers.

Callers supply an explicit instance root and every acceptance ceiling.  The
module owns filesystem containment, schema checks, the single-writer lock,
strict durable JSONL appends, and content-free receipt bookkeeping.  It does
not discover instances, choose business paths, or interpret record content.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import stat
import time
from dataclasses import dataclass
from enum import StrEnum
from functools import cache
from pathlib import Path
from typing import Iterable, Iterator, Mapping

import validate_atlas


JOURNAL_ROW_BYTES = validate_atlas.JOURNAL_ROW_BYTES
RESERVED_RECEIPT_NAMESPACES = frozenset({"import", "observe"})

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_RECEIPT_KEY_RE = re.compile(
    r"^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*#[0-9]+$"
)
# §8's registered journals — the only paths the §20 fold and the validator
# ever read; appends anywhere else would silently drop evidence.
_JOURNAL_SCHEMAS = validate_atlas.JOURNALS

_IGNORED_DIRECTORY_NAMES = {
    "secrets",
    "node_modules",
    ".venv",
    "dist",
    "build",
    ".git",
}


class ReasonCode(StrEnum):
    """Stable, content-free failure codes exposed to callers."""

    INVALID_ROOT = "invalid-root"
    UNSAFE_PATH = "unsafe-path"
    IGNORED_PATH = "ignored-path"
    UNBOUNDED_READ = "unbounded-read"
    INVALID_CEILING = "invalid-ceiling"
    BYTE_CEILING_EXCEEDED = "byte-ceiling-exceeded"
    COUNT_CEILING_EXCEEDED = "count-ceiling-exceeded"
    INVALID_UTF8 = "invalid-utf8"
    INVALID_LINE_ENDING = "invalid-line-ending"
    INVALID_JSON = "invalid-json"
    UNKNOWN_SCHEMA = "unknown-schema"
    SCHEMA_REGISTRY_INVALID = "schema-registry-invalid"
    MISSING_FORMAT_VERSION = "missing-format-version"
    UNKNOWN_FORMAT = "unknown-format"
    UNSUPPORTED_VERSION = "unsupported-version"
    SCHEMA_INVALID = "schema-invalid"
    LOCK_HELD = "lock-held"
    LOCK_REQUIRED = "lock-required"
    LOCK_LOST = "lock-lost"
    LOCK_IO = "lock-io"
    APPEND_IO = "append-io"
    INVALID_JOURNAL_PATH = "invalid-journal-path"
    INVALID_JSONL = "invalid-jsonl"
    INVALID_RECEIPT_KEY = "invalid-receipt-key"
    INVALID_RECEIPT_TRANSITION = "invalid-receipt-transition"
    INVALID_RECEIPT_JOURNAL = "invalid-receipt-journal"


class DiagnosticLevel(StrEnum):
    """The two diagnostic levels permitted by the executable contract."""

    ERROR = "ERROR"
    WARNING = "WARNING"


_EXPECTATIONS = {
    ReasonCode.INVALID_ROOT: (
        "an explicit real instance directory with atlas/ and state/"
    ),
    ReasonCode.UNSAFE_PATH: (
        "a real contained path with no traversal, symlink, or special file"
    ),
    ReasonCode.IGNORED_PATH: "a path outside every Atlas ignore root",
    ReasonCode.UNBOUNDED_READ: "an explicit caller-supplied byte ceiling",
    ReasonCode.INVALID_CEILING: "a non-negative integer ceiling and observed count",
    ReasonCode.BYTE_CEILING_EXCEEDED: (
        "input at or below the caller-supplied byte ceiling"
    ),
    ReasonCode.COUNT_CEILING_EXCEEDED: (
        "input at or below the caller-supplied count ceiling"
    ),
    ReasonCode.INVALID_UTF8: "strict UTF-8 JSON",
    ReasonCode.INVALID_LINE_ENDING: "LF-only Atlas-authored text",
    ReasonCode.INVALID_JSON: (
        "one structurally valid JSON value with unique object keys"
    ),
    ReasonCode.UNKNOWN_SCHEMA: "a registered persisted-format schema",
    ReasonCode.SCHEMA_REGISTRY_INVALID: "the complete valid canonical schema registry",
    ReasonCode.MISSING_FORMAT_VERSION: "string format and integer version fields",
    ReasonCode.UNKNOWN_FORMAT: "a registered format identifier",
    ReasonCode.UNSUPPORTED_VERSION: "the version declared by the registered schema",
    ReasonCode.SCHEMA_INVALID: "an object conforming to its closed registered schema",
    ReasonCode.LOCK_HELD: "an absent .atlas-lock; stale locks are removed only by hand",
    ReasonCode.LOCK_REQUIRED: "the instance lock held across the complete writing flow",
    ReasonCode.LOCK_LOST: "the same .atlas-lock inode acquired by this writer",
    ReasonCode.LOCK_IO: "an atomically created lock containing pid and started_at",
    ReasonCode.APPEND_IO: "one complete fsynced JSONL append",
    ReasonCode.INVALID_JOURNAL_PATH: "an instance-relative state/*.jsonl journal path",
    ReasonCode.INVALID_JSONL: (
        "strict UTF-8 LF-only JSONL with one complete value per row"
    ),
    ReasonCode.INVALID_RECEIPT_KEY: "a content-free <source-slug>/<batch-slug>#<n> key",
    ReasonCode.INVALID_RECEIPT_TRANSITION: (
        "one opened row followed by one processed row"
    ),
    ReasonCode.INVALID_RECEIPT_JOURNAL: (
        "ordered schema-valid content-free receipt rows"
    ),
}


@dataclass(frozen=True)
class Diagnostic:
    """A privacy-safe diagnostic containing no rejected record value."""

    reason: ReasonCode
    level: DiagnosticLevel = DiagnosticLevel.ERROR
    relative_path: str = "."
    record_index: int | None = None


@dataclass(frozen=True)
class AppendResult:
    """Stable metadata returned after one durable journal append."""

    relative_path: str
    bytes_written: int
    created: bool


@dataclass(frozen=True)
class ReceiptStatus:
    """Receipt keys observed in each marker state."""

    opened: frozenset[str]
    processed: frozenset[str]

    @property
    def interrupted(self) -> frozenset[str]:
        """Keys with an opened row but no processed row."""

        return self.opened - self.processed


class AtlasIOError(RuntimeError):
    """Fail-closed exception whose text is always a no-echo diagnostic."""

    def __init__(self, diagnostic: Diagnostic):
        self.diagnostic = diagnostic
        super().__init__(format_diagnostics(diagnostic))


def format_diagnostics(diagnostics: Diagnostic | Iterable[Diagnostic]) -> str:
    """Format diagnostics as bounded ERROR:/WARNING: lines."""

    if isinstance(diagnostics, Diagnostic):
        items = (diagnostics,)
    else:
        items = tuple(diagnostics)
    lines: list[str] = []
    for item in items:
        location = item.relative_path
        if item.record_index is not None:
            location += f"#{item.record_index}"
        lines.append(
            f"{item.level.value}: {location}: {item.reason.value}; "
            f"expected {_EXPECTATIONS[item.reason]}"
        )
    return "\n".join(lines)


def enforce_ceiling(
    actual: int,
    *,
    maximum: int | None,
    kind: str,
    relative_path: str = ".",
) -> None:
    """Enforce one explicit byte or count ceiling without echoing values."""

    if maximum is None:
        _fail(ReasonCode.UNBOUNDED_READ, relative_path)
    if (
        not isinstance(actual, int)
        or isinstance(actual, bool)
        or not isinstance(maximum, int)
        or isinstance(maximum, bool)
        or actual < 0
        or maximum < 0
        or kind not in {"bytes", "count"}
    ):
        _fail(ReasonCode.INVALID_CEILING, relative_path)
    if actual > maximum:
        reason = (
            ReasonCode.BYTE_CEILING_EXCEEDED
            if kind == "bytes"
            else ReasonCode.COUNT_CEILING_EXCEEDED
        )
        _fail(reason, relative_path)


def make_receipt_key(source: str, batch: str, index: int) -> str:
    """Build a mechanically valid content-free receipt key.

    Reserved namespaces remain valid here because direct import and observe
    lanes own them; intake-specific refusal belongs to the intake caller.
    """

    if (
        not isinstance(source, str)
        or not isinstance(batch, str)
        or not _SLUG_RE.fullmatch(source)
        or not _SLUG_RE.fullmatch(batch)
        or not isinstance(index, int)
        or isinstance(index, bool)
        or index < 0
    ):
        _fail(ReasonCode.INVALID_RECEIPT_KEY)
    return f"{source}/{batch}#{index}"


class AtlasInstance:
    """Validated instance I/O with containment, locking, and durability."""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = _validate_instance_root(root)
        self._lock_fd: int | None = None

    def path(
        self,
        relative_path: str | os.PathLike[str],
        *,
        allow_missing: bool = False,
    ) -> Path:
        """Construct and lstat a safe path beneath the instance root."""

        return _safe_path(self.root, relative_path, allow_missing=allow_missing)

    def read_json(
        self,
        relative_path: str | os.PathLike[str],
        *,
        max_bytes: int | None,
        delivered: bool = False,
    ):
        """Read one bounded JSON value after checking total bytes by fstat.

        §25.8 scopes no-BOM to Atlas-authored files; a delivered original
        (`delivered=True`) tolerates a BOM like validate_atlas's readers do.
        """

        display = _safe_display_path(relative_path)
        path = self.path(relative_path)
        try:
            with path.open("rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    _fail(ReasonCode.UNSAFE_PATH, display)
                enforce_ceiling(
                    info.st_size,
                    maximum=max_bytes,
                    kind="bytes",
                    relative_path=display,
                )
                # Read one byte past the ceiling so growth after fstat still
                # fails before a full decode.
                data = stream.read(max_bytes + 1 if max_bytes is not None else 1)
        except AtlasIOError:
            raise
        except OSError:
            _fail(ReasonCode.UNSAFE_PATH, display)
        enforce_ceiling(
            len(data), maximum=max_bytes, kind="bytes", relative_path=display
        )
        if data.startswith(b"\xef\xbb\xbf"):
            if not delivered:
                _fail(ReasonCode.INVALID_UTF8, display)
            data = data[3:]
        if not delivered and b"\r" in data:
            _fail(ReasonCode.INVALID_LINE_ENDING, display)
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            _fail(ReasonCode.INVALID_UTF8, display)
        try:
            return validate_atlas._json_loads(text)
        except (json.JSONDecodeError, validate_atlas.JsonInputError):
            _fail(ReasonCode.INVALID_JSON, display)

    def validate_schema(self, value, schema_name: str) -> None:
        """Validate a parsed value against one canonical registered schema."""

        schemas = _schema_registry()
        if not isinstance(schema_name, str):
            _fail(ReasonCode.UNKNOWN_SCHEMA)
        schema = schemas.get(schema_name)
        if schema is None:
            _fail(ReasonCode.UNKNOWN_SCHEMA)
        try:
            errors = validate_atlas.SchemaValidator(schema).validate(value)
        except validate_atlas.SchemaSubsetError:
            _fail(ReasonCode.SCHEMA_REGISTRY_INVALID)
        if errors:
            _fail(ReasonCode.SCHEMA_INVALID)

    def validate_format(self, value: object) -> str:
        """Check format/version and then the matching closed schema."""

        if not isinstance(value, Mapping):
            _fail(ReasonCode.MISSING_FORMAT_VERSION)
        format_name = value.get("format")
        version = value.get("version")
        if (
            not isinstance(format_name, str)
            or not isinstance(version, int)
            or isinstance(version, bool)
        ):
            _fail(ReasonCode.MISSING_FORMAT_VERSION)
        schemas = _schema_registry()
        schema = schemas.get(format_name)
        if schema is None or schema.get("properties", {}).get("format", {}).get(
            "const"
        ) != format_name:
            _fail(ReasonCode.UNKNOWN_FORMAT)
        version_schema = schema.get("properties", {}).get("version", {})
        if version_schema.get("const") != version:
            _fail(ReasonCode.UNSUPPORTED_VERSION)
        self.validate_schema(value, format_name)
        return format_name

    @contextlib.contextmanager
    def lock(self) -> Iterator[None]:
        """Hold the instance's acquire-if-absent single-writer lock."""

        if self._lock_fd is not None:
            _fail(ReasonCode.LOCK_HELD, ".atlas-lock")
        lock_path = self.root / ".atlas-lock"
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            lock_fd = os.open(lock_path, flags, 0o600)
        except FileExistsError:
            _fail(ReasonCode.LOCK_HELD, ".atlas-lock")
        except OSError:
            _fail(ReasonCode.LOCK_IO, ".atlas-lock")
        self._lock_fd = lock_fd
        try:
            payload = (
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "started_at": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                        ),
                    }
                )
                + "\n"
            ).encode("utf-8")
            written = os.write(lock_fd, payload)
        except OSError:
            self._release_lock(lock_fd, lock_path)
            self._lock_fd = None
            _fail(ReasonCode.LOCK_IO, ".atlas-lock")
        if written != len(payload):
            self._release_lock(lock_fd, lock_path)
            self._lock_fd = None
            _fail(ReasonCode.LOCK_IO, ".atlas-lock")
        body_failed = False
        try:
            yield
        except BaseException:
            body_failed = True
            raise
        finally:
            released = self._release_lock(lock_fd, lock_path)
            self._lock_fd = None
            if not released and not body_failed:
                _fail(ReasonCode.LOCK_IO, ".atlas-lock")

    def append_record(
        self,
        relative_path: str | os.PathLike[str],
        record: Mapping[str, object],
    ) -> AppendResult:
        """Schema-check and durably append exactly one strict JSONL row.

        Only §8's registered journal shapes are writable — state/<stem>.jsonl
        or a one-level rotation state/<stem>/<file>.jsonl — because those are
        the only paths the fold and the validator read; the row schema is the
        stem's own. Receipts are excluded: their rows carry the §33.2
        transition contract and go through append_receipt only.
        """

        display = _safe_display_path(relative_path)
        try:
            journal_path = Path(relative_path)
        except (TypeError, ValueError):
            _fail(ReasonCode.INVALID_JOURNAL_PATH)
        parts = journal_path.parts
        schema_name = None
        if (
            len(parts) in (2, 3)
            and parts[0] == "state"
            and journal_path.suffix == ".jsonl"
        ):
            stem = journal_path.stem if len(parts) == 2 else parts[1]
            if stem != "receipts":
                schema_name = _JOURNAL_SCHEMAS.get(stem)
        if schema_name is None:
            _fail(ReasonCode.INVALID_JOURNAL_PATH)
        return self._append(relative_path, display, record, schema_name)

    def _append(
        self,
        relative_path: str | os.PathLike[str],
        display: str,
        record: Mapping[str, object],
        schema_name: str,
    ) -> AppendResult:
        self._require_lock()
        self.validate_schema(record, schema_name)
        try:
            payload = json.dumps(
                record,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            _fail(ReasonCode.SCHEMA_INVALID, display)
        enforce_ceiling(
            len(payload),
            maximum=JOURNAL_ROW_BYTES,
            kind="bytes",
            relative_path=display,
        )
        path = self.path(relative_path, allow_missing=True)
        parent = self.path(Path(relative_path).parent)
        try:
            before = path.lstat()
        except FileNotFoundError:
            before = None
        except OSError:
            _fail(ReasonCode.UNSAFE_PATH, display)
        if before is not None and not stat.S_ISREG(before.st_mode):
            _fail(ReasonCode.UNSAFE_PATH, display)

        flags = os.O_APPEND | os.O_CREAT | os.O_RDWR
        flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_NONBLOCK", 0)
        try:
            fd = os.open(path, flags, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    _fail(ReasonCode.UNSAFE_PATH, display)
                if info.st_size:
                    os.lseek(fd, -1, os.SEEK_END)
                    if os.read(fd, 1) != b"\n":
                        _fail(ReasonCode.INVALID_JSONL, display)
                line = payload + b"\n"
                if os.write(fd, line) != len(line):
                    _fail(ReasonCode.APPEND_IO, display)
                os.fsync(fd)
            finally:
                os.close(fd)
            created = before is None
            if created:
                _sync_dir(parent)
        except AtlasIOError:
            raise
        except OSError:
            _fail(ReasonCode.APPEND_IO, display)
        return AppendResult(display, len(payload), created)

    def append_receipt(self, key: str, marker: str, date: str) -> AppendResult:
        """Append one legal opened/processed receipt transition durably."""

        if not isinstance(key, str) or not _RECEIPT_KEY_RE.fullmatch(key):
            _fail(ReasonCode.INVALID_RECEIPT_KEY, "state/receipts.jsonl")
        if not isinstance(marker, str) or marker not in {"opened", "processed"}:
            _fail(ReasonCode.INVALID_RECEIPT_TRANSITION, "state/receipts.jsonl")
        self._require_lock()
        current = self.receipt_status()
        if marker == "opened":
            legal = key not in current.opened and key not in current.processed
        else:
            legal = key in current.opened and key not in current.processed
        if not legal:
            _fail(ReasonCode.INVALID_RECEIPT_TRANSITION, "state/receipts.jsonl")
        return self._append(
            "state/receipts.jsonl",
            "state/receipts.jsonl",
            {"intake": key, "marker": marker, "date": date},
            "journal-receipt",
        )

    def receipt_status(self) -> ReceiptStatus:
        """Report opened, processed, and interrupted receipt keys.

        Reads the §8 concatenation — state/receipts.jsonl plus any rotated
        state/receipts/*.jsonl — the same set the canonical validator folds.
        """

        opened: set[str] = set()
        processed: dict[str, tuple[str, int]] = {}
        validator = validate_atlas.SchemaValidator(
            _schema_registry()["journal-receipt"]
        )
        state = self.path("state")
        for found in validate_atlas._journal_paths(state, "receipts"):
            relative = found.relative_to(self.root).as_posix()
            path = self.path(relative)
            try:
                for number, row in validate_atlas._read_jsonl(path):
                    if validator.validate(row):
                        _fail(
                            ReasonCode.INVALID_RECEIPT_JOURNAL,
                            relative,
                            record_index=number,
                        )
                    key = row["intake"]
                    marker = row["marker"]
                    # §33.2's pair is ordered; the one reversal appends can
                    # create is a processed row in the direct file closing an
                    # opened row already rotated away, so only that pairing
                    # is order-free — duplicates, same-file reversals, and
                    # rotated-vs-rotated reversals are illegal.
                    if marker == "opened":
                        reversal_ok = (
                            key in processed
                            and processed[key][0] == "state/receipts.jsonl"
                            and relative != "state/receipts.jsonl"
                        )
                        illegal = key in opened or (
                            key in processed and not reversal_ok
                        )
                    else:
                        illegal = key in processed
                    if illegal:
                        _fail(
                            ReasonCode.INVALID_RECEIPT_JOURNAL,
                            relative,
                            record_index=number,
                        )
                    if marker == "opened":
                        opened.add(key)
                    else:
                        processed[key] = (relative, number)
            except AtlasIOError:
                raise
            except (OSError, validate_atlas.JsonInputError, KeyError, TypeError):
                _fail(ReasonCode.INVALID_RECEIPT_JOURNAL, relative)
        for key, (relative, number) in processed.items():
            if key not in opened:
                _fail(
                    ReasonCode.INVALID_RECEIPT_JOURNAL,
                    relative,
                    record_index=number,
                )
        return ReceiptStatus(frozenset(opened), frozenset(processed))

    def _require_lock(self) -> None:
        if self._lock_fd is None:
            _fail(ReasonCode.LOCK_REQUIRED, ".atlas-lock")
        try:
            own = os.fstat(self._lock_fd)
            current = os.stat(self.root / ".atlas-lock", follow_symlinks=False)
        except OSError:
            _fail(ReasonCode.LOCK_LOST, ".atlas-lock")
        if not os.path.samestat(own, current):
            _fail(ReasonCode.LOCK_LOST, ".atlas-lock")

    @staticmethod
    def _release_lock(lock_fd: int, lock_path: Path) -> bool:
        released = True
        try:
            own = os.fstat(lock_fd)
            try:
                current = os.stat(lock_path, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if current is not None and os.path.samestat(own, current):
                lock_path.unlink()
        except OSError:
            released = False
        finally:
            try:
                os.close(lock_fd)
            except OSError:
                released = False
        return released


def _fail(
    reason: ReasonCode,
    relative_path: str = ".",
    *,
    record_index: int | None = None,
) -> None:
    raise AtlasIOError(
        Diagnostic(
            reason=reason,
            relative_path=relative_path,
            record_index=record_index,
        )
    )


@cache
def _schema_registry() -> dict[str, dict]:
    schemas, errors = validate_atlas._load_registry()
    if errors:
        _fail(ReasonCode.SCHEMA_REGISTRY_INVALID)
    return schemas


def _validate_instance_root(root: str | os.PathLike[str]) -> Path:
    try:
        supplied = Path(root)
    except (TypeError, ValueError):
        _fail(ReasonCode.INVALID_ROOT)
    absolute = Path(os.path.abspath(supplied))
    current = Path(absolute.anchor)
    try:
        for component in absolute.parts[1:]:
            current /= component
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                _fail(ReasonCode.INVALID_ROOT)
        resolved = absolute.resolve(strict=True)
        for required in ("atlas", "state"):
            info = (resolved / required).lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                _fail(ReasonCode.INVALID_ROOT)
    except AtlasIOError:
        raise
    except (OSError, RuntimeError):
        _fail(ReasonCode.INVALID_ROOT)
    return resolved


def _safe_path(
    root: Path,
    relative_path: str | os.PathLike[str],
    *,
    allow_missing: bool,
) -> Path:
    try:
        relative = Path(relative_path)
    except (TypeError, ValueError):
        _fail(ReasonCode.UNSAFE_PATH)
    parts = relative.parts
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in parts):
        _fail(ReasonCode.UNSAFE_PATH)
    if any(_is_ignored_name(part) for part in parts):
        _fail(ReasonCode.IGNORED_PATH)
    candidate = root.joinpath(*parts)
    try:
        candidate.resolve(strict=False).relative_to(root)
    except (OSError, RuntimeError, ValueError):
        _fail(ReasonCode.UNSAFE_PATH)

    current = root
    for index, component in enumerate(parts):
        current /= component
        final = index == len(parts) - 1
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing and final:
                return candidate
            _fail(ReasonCode.UNSAFE_PATH)
        except OSError:
            _fail(ReasonCode.UNSAFE_PATH)
        if stat.S_ISLNK(info.st_mode):
            _fail(ReasonCode.UNSAFE_PATH)
        if final:
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                _fail(ReasonCode.UNSAFE_PATH)
        elif not stat.S_ISDIR(info.st_mode):
            _fail(ReasonCode.UNSAFE_PATH)
    return candidate


def _is_ignored_name(name: str) -> bool:
    return (
        name == ".env"
        or name.startswith(".env.")
        or name in _IGNORED_DIRECTORY_NAMES
    )


def _safe_display_path(relative_path: str | os.PathLike[str]) -> str:
    try:
        path = Path(relative_path)
    except (TypeError, ValueError):
        return "."
    if (
        path.is_absolute()
        or not path.parts
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(_is_ignored_name(part) for part in path.parts)
    ):
        return "."
    return path.as_posix()


def _sync_dir(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(directory, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
