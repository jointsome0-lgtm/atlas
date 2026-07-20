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
    CONTENT_CONFLICT = "content-conflict"
    PRESERVE_IO = "preserve-io"


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
    ReasonCode.CONTENT_CONFLICT: "byte-identical content at the canonical path",
    ReasonCode.PRESERVE_IO: "one durable byte-identical canonical original",
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


@dataclass(frozen=True)
class DeliveredJSON:
    """One bounded delivered JSON value and its byte-identical original."""

    value: object
    data: bytes


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
        # POSIX filenames may carry control characters; a raw newline would
        # inject an unprefixed diagnostic line (§25.8 one-per-line contract).
        location = "".join(
            char if char.isprintable() else "?" for char in location
        )
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
        # Re-open binding every component no-follow: the containment check
        # above cannot cover a swap in the gap before the open (§24.2).
        flags = os.O_RDONLY
        flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            fd, parent_fd = _open_under_root(
                self.root, path.relative_to(self.root).parts, flags
            )
        except OSError:
            _fail(ReasonCode.UNSAFE_PATH, display)
        os.close(parent_fd)
        data = _read_bounded_fd(fd, max_bytes, display)
        return _decode_json(data, delivered=delivered, display=display)

    def read_delivered_json(
        self,
        path: str | os.PathLike[str],
        *,
        max_bytes: int | None,
    ) -> DeliveredJSON:
        """Read an explicit external delivery no-follow, bounded by fstat.

        The caller still chooses the instance destination.  Returning the
        original bytes lets the lane preserve exactly what was decoded,
        without a second path open or a check/copy race.
        """

        try:
            absolute = Path(os.path.abspath(path))
        except (TypeError, ValueError, OSError):
            _fail(ReasonCode.UNSAFE_PATH)
        try:
            relative = absolute.relative_to(self.root)
        except ValueError:
            relative = None
        if relative is not None:
            # An instance-contained delivery binds the instance's own
            # containment and ignore-root rules (§24.2) — a batch under
            # INSTANCE/secrets/ or .env* must refuse before any read.
            _safe_path(self.root, relative, allow_missing=False)
        elif any(_is_ignored_name(part) for part in absolute.parts[1:]):
            # §24: read no secrets, never scan .env — an external delivery
            # under an ignore-named component is refused before decoding
            # or preservation.
            _fail(ReasonCode.IGNORED_PATH)
        try:
            fd, parent_fd = _open_under_root(
                Path(absolute.anchor), absolute.parts[1:],
                os.O_RDONLY
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NONBLOCK", 0),
            )
        except (OSError, IndexError):
            _fail(ReasonCode.UNSAFE_PATH)
        os.close(parent_fd)
        data = _read_bounded_fd(fd, max_bytes, ".")
        value = _decode_json(data, delivered=True, display=".")
        return DeliveredJSON(value=value, data=data)

    def preserve_bytes(
        self,
        relative_path: str | os.PathLike[str],
        data: bytes,
    ) -> bool:
        """Durably preserve bytes at a canonical path without overwriting.

        Returns True when this call created the original and False for an
        identical replay.  Different existing bytes fail closed.
        """

        self._require_lock()
        display = _safe_display_path(relative_path)
        try:
            relative = Path(relative_path)
        except (TypeError, ValueError):
            _fail(ReasonCode.UNSAFE_PATH)
        if (
            not isinstance(data, bytes)
            or relative.is_absolute()
            or not relative.parts
            or any(part in {"", ".", ".."} for part in relative.parts)
            or _is_ignored_name(relative.parts[0])
        ):
            _fail(ReasonCode.UNSAFE_PATH, display)

        parent_fd = _ensure_directories(self.root, relative.parts[:-1], display)
        name = relative.parts[-1]
        read_flags = os.O_RDONLY
        read_flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        read_flags |= getattr(os, "O_NONBLOCK", 0)
        try:
            existing_fd = os.open(name, read_flags, dir_fd=parent_fd)
        except FileNotFoundError:
            existing_fd = None
        except OSError:
            os.close(parent_fd)
            _fail(ReasonCode.UNSAFE_PATH, display)
        if existing_fd is not None:
            try:
                try:
                    existing_size = os.fstat(existing_fd).st_size
                except OSError:
                    _fail(ReasonCode.UNSAFE_PATH, display)
                if existing_size != len(data):
                    os.close(existing_fd)
                    existing_fd = None
                    _fail(ReasonCode.CONTENT_CONFLICT, display)
                existing = _read_bounded_fd(existing_fd, len(data), display)
                existing_fd = None
            finally:
                if existing_fd is not None:
                    with contextlib.suppress(OSError):
                        os.close(existing_fd)
                os.close(parent_fd)
            if existing != data:
                _fail(ReasonCode.CONTENT_CONFLICT, display)
            return False

        temp_name = None
        temp_fd = None
        for attempt in range(100):
            candidate = f".{name}.tmp-{os.getpid()}-{attempt}"
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
            flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            try:
                temp_fd = os.open(candidate, flags, 0o600, dir_fd=parent_fd)
                temp_name = candidate
                break
            except FileExistsError:
                continue
            except OSError:
                os.close(parent_fd)
                _fail(ReasonCode.PRESERVE_IO, display)
        if temp_fd is None or temp_name is None:
            os.close(parent_fd)
            _fail(ReasonCode.PRESERVE_IO, display)
        try:
            offset = 0
            while offset < len(data):
                written = os.write(temp_fd, data[offset:])
                if written <= 0:
                    raise OSError("short write")
                offset += written
            os.fsync(temp_fd)
            os.close(temp_fd)
            temp_fd = None
            # The instance lock is the single-writer exclusion (§25.6), so
            # this same-directory rename cannot replace another Atlas write.
            os.rename(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temp_name = None
            os.fsync(parent_fd)
        except OSError:
            if temp_fd is not None:
                with contextlib.suppress(OSError):
                    os.close(temp_fd)
            if temp_name is not None:
                with contextlib.suppress(OSError):
                    os.unlink(temp_name, dir_fd=parent_fd)
                    os.fsync(parent_fd)
            os.close(parent_fd)
            _fail(ReasonCode.PRESERVE_IO, display)
        os.close(parent_fd)
        return True

    def schema_errors(
        self,
        value,
        schema_name: str,
        *,
        definition: str | None = None,
    ) -> tuple[str, ...]:
        """Return content-free canonical schema errors for one definition."""

        schemas = _schema_registry()
        if not isinstance(schema_name, str):
            _fail(ReasonCode.UNKNOWN_SCHEMA)
        schema = schemas.get(schema_name)
        if schema is None:
            _fail(ReasonCode.UNKNOWN_SCHEMA)
        target = schema
        if definition is not None:
            if not isinstance(definition, str):
                _fail(ReasonCode.UNKNOWN_SCHEMA)
            target = schema.get("$defs", {}).get(definition)
            if target is None:
                _fail(ReasonCode.UNKNOWN_SCHEMA)
        try:
            validator = validate_atlas.SchemaValidator(schema)
            errors: list[str] = []
            validator._validate(value, target, "$", errors)
        except validate_atlas.SchemaSubsetError:
            _fail(ReasonCode.SCHEMA_REGISTRY_INVALID)
        return tuple(errors)

    def validate_schema(
        self,
        value,
        schema_name: str,
        *,
        definition: str | None = None,
    ) -> None:
        """Validate a parsed value against one canonical registered schema."""

        if self.schema_errors(value, schema_name, definition=definition):
            _fail(ReasonCode.SCHEMA_INVALID)

    def validate_format(
        self,
        value: object,
        *,
        definition: str | None = None,
    ) -> str:
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
        self.validate_schema(value, format_name, definition=definition)
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
            failure = self._release_lock(lock_fd, lock_path)
            self._lock_fd = None
            if failure is not None and not body_failed:
                _fail(failure, ".atlas-lock")

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
        name = path.name
        try:
            fd, parent_fd = _open_under_root(
                self.root, path.relative_to(self.root).parts, flags
            )
        except OSError:
            _fail(ReasonCode.APPEND_IO, display)
        try:
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    _fail(ReasonCode.UNSAFE_PATH, display)
                if info.st_size:
                    os.lseek(fd, -1, os.SEEK_END)
                    if os.read(fd, 1) != b"\n":
                        _fail(ReasonCode.INVALID_JSONL, display)
                line = payload + b"\n"
                # The lock excludes other Atlas writers, so on any failure —
                # short write or post-write fsync — truncating back to the
                # pre-append size cannot lose foreign rows, while a torn or
                # undurable tail would corrupt every later append or retry.
                try:
                    written = os.write(fd, line)
                    durable = written == len(line)
                    if durable:
                        os.fsync(fd)
                except OSError:
                    durable = False
                if not durable:
                    with contextlib.suppress(OSError):
                        if before is None:
                            # This call created the file: truncation would
                            # leave an empty journal whose directory entry a
                            # retry never syncs — unlink it instead.
                            os.unlink(name, dir_fd=parent_fd)
                            os.fsync(parent_fd)
                        else:
                            os.ftruncate(fd, info.st_size)
                            os.fsync(fd)
                    _fail(ReasonCode.APPEND_IO, display)
                created = before is None
                if created:
                    try:
                        os.fsync(parent_fd)
                    except OSError:
                        # The row is not durable until its new file's
                        # directory entry is; unlink the created file so a
                        # retry does not see a phantom row.
                        with contextlib.suppress(OSError):
                            os.unlink(name, dir_fd=parent_fd)
                            os.fsync(parent_fd)
                        _fail(ReasonCode.APPEND_IO, display)
            finally:
                os.close(fd)
        except AtlasIOError:
            raise
        except OSError:
            _fail(ReasonCode.APPEND_IO, display)
        finally:
            os.close(parent_fd)
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

        # (chronological file rank, line): the direct file is the newest —
        # rotation moves old rows out — so rotated files rank first in sorted
        # order and state/receipts.jsonl last. §33.2's pair is ordered by this
        # position: opened must precede processed; duplicates are illegal.
        opened: dict[str, tuple[int, int]] = {}
        processed: dict[str, tuple[int, int, str]] = {}
        validator = validate_atlas.SchemaValidator(
            _schema_registry()["journal-receipt"]
        )
        state = self.path("state")
        files = list(validate_atlas._journal_paths(state, "receipts"))
        direct = state / "receipts.jsonl"
        for found in files:
            rank = len(files) if found == direct else files.index(found)
            relative = found.relative_to(self.root).as_posix()
            path = _NoFollowPath(self.root, self.path(relative))
            try:
                for number, row in validate_atlas._read_jsonl(path):
                    if validator.validate(row):
                        _fail(
                            ReasonCode.INVALID_RECEIPT_JOURNAL,
                            relative,
                            record_index=number,
                        )
                    key = row["intake"]
                    target = opened if row["marker"] == "opened" else processed
                    if key in target:
                        _fail(
                            ReasonCode.INVALID_RECEIPT_JOURNAL,
                            relative,
                            record_index=number,
                        )
                    if row["marker"] == "opened":
                        opened[key] = (rank, number)
                    else:
                        processed[key] = (rank, number, relative)
            except AtlasIOError:
                raise
            except (OSError, validate_atlas.JsonInputError, KeyError, TypeError):
                _fail(ReasonCode.INVALID_RECEIPT_JOURNAL, relative)
        for key, (rank, number, relative) in processed.items():
            begun = opened.get(key)
            if begun is None or begun >= (rank, number):
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
    def _release_lock(lock_fd: int, lock_path: Path) -> ReasonCode | None:
        """Release the held lock; None on success, else the failure code.

        A missing or replaced .atlas-lock means exclusivity was already lost
        mid-flow (§25.6's lock covers the complete writing flow), so it is
        LOCK_LOST, never silent success.
        """

        failure: ReasonCode | None = None
        try:
            own = os.fstat(lock_fd)
            try:
                current = os.stat(lock_path, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if current is not None and os.path.samestat(own, current):
                lock_path.unlink()
            else:
                failure = ReasonCode.LOCK_LOST
        except OSError:
            failure = ReasonCode.LOCK_IO
        finally:
            try:
                os.close(lock_fd)
            except OSError:
                failure = failure or ReasonCode.LOCK_IO
        return failure


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


def _read_bounded_fd(fd: int, maximum: int | None, display: str) -> bytes:
    """Read one already-open regular file after its fstat ceiling check."""

    try:
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                _fail(ReasonCode.UNSAFE_PATH, display)
            enforce_ceiling(
                info.st_size,
                maximum=maximum,
                kind="bytes",
                relative_path=display,
            )
            data = stream.read(maximum + 1 if maximum is not None else 1)
    except AtlasIOError:
        raise
    except OSError:
        _fail(ReasonCode.UNSAFE_PATH, display)
    enforce_ceiling(
        len(data), maximum=maximum, kind="bytes", relative_path=display
    )
    return data


def _decode_json(data: bytes, *, delivered: bool, display: str):
    """Decode one strict JSON value without echoing refused content."""

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
    except (json.JSONDecodeError, validate_atlas.JsonInputError, RecursionError):
        _fail(ReasonCode.INVALID_JSON, display)


def _ensure_directories(root: Path, parts: tuple[str, ...], display: str) -> int:
    """Open, and durably create when absent, a no-follow directory chain."""

    try:
        directory_fd = os.open(root, _DIR_FLAGS)
    except OSError:
        _fail(ReasonCode.PRESERVE_IO, display)
    for component in parts:
        try:
            next_fd = os.open(component, _DIR_FLAGS, dir_fd=directory_fd)
        except FileNotFoundError:
            try:
                os.mkdir(component, 0o700, dir_fd=directory_fd)
                os.fsync(directory_fd)
                next_fd = os.open(component, _DIR_FLAGS, dir_fd=directory_fd)
            except OSError:
                os.close(directory_fd)
                _fail(ReasonCode.PRESERVE_IO, display)
        except OSError:
            os.close(directory_fd)
            _fail(ReasonCode.UNSAFE_PATH, display)
        os.close(directory_fd)
        directory_fd = next_fd
    return directory_fd


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
    # Ignore paths bind by resolved location (§24.2): they are roots at the
    # instance top level, not banned names — intake/build/ from an opaque
    # source named "build" is legal. Symlinks are refused wholesale below,
    # so the lexical first component is the resolved location.
    if _is_ignored_name(parts[0]):
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
        or _is_ignored_name(path.parts[0])
        or not path.as_posix().isprintable()
    ):
        return "."
    return path.as_posix()


_DIR_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)


class _NoFollowPath:
    """Path stand-in whose open() rebinds the component chain no-follow.

    Lets validate_atlas's journal readers reuse their own streaming logic
    while the actual open cannot follow a symlink swapped in after the
    containment check (§24.2).
    """

    def __init__(self, root: Path, path: Path):
        self._root = root
        self._path = path

    def open(self, mode: str = "rb"):
        if mode != "rb":
            raise ValueError("only binary reads are supported")
        relative = self._path.relative_to(self._root)
        flags = os.O_RDONLY
        flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            fd, parent_fd = _open_under_root(self._root, relative.parts, flags)
        except OSError:
            _fail(ReasonCode.UNSAFE_PATH, relative.as_posix())
        os.close(parent_fd)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            _fail(ReasonCode.UNSAFE_PATH, relative.as_posix())
        return os.fdopen(fd, mode)

    def __fspath__(self) -> str:
        return os.fspath(self._path)

    def __str__(self) -> str:
        return str(self._path)


def _open_under_root(
    root: Path, parts: tuple[str, ...], flags: int
) -> tuple[int, int]:
    """Open a validated root-relative path binding every component no-follow.

    Walks the already-checked component chain with directory fds (openat), so
    a directory swapped for a symlink after the check cannot redirect the
    open (§24.2). Returns (fd, parent_dir_fd); the caller closes both.
    """

    dir_fd = os.open(root, _DIR_FLAGS)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, _DIR_FLAGS, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = next_fd
        fd = os.open(parts[-1], flags, 0o600, dir_fd=dir_fd)
    except OSError:
        os.close(dir_fd)
        raise
    return fd, dir_fd
