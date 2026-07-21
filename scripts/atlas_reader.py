#!/usr/bin/env python3
"""Shared fail-closed readers for Atlas-owned directory trees.

The caller declares one root.  Every scan and read rebinds the complete path
with directory file descriptors and ``O_NOFOLLOW`` so a checked component
cannot be swapped for a symlink before it is opened.  Directory scans reject
symlinks and special files before returning any partial file list.
"""
from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import IO


class ReasonCode(StrEnum):
    INVALID_ROOT = "invalid-root"
    UNSAFE_PATH = "unsafe-path"


_EXPECTATIONS = {
    ReasonCode.INVALID_ROOT: (
        "an explicit lstat-confirmed directory root with no symlink components"
    ),
    ReasonCode.UNSAFE_PATH: (
        "a contained lstat-confirmed regular file or directory with no "
        "symlinks or special files"
    ),
}


class ReaderError(ValueError):
    """A stable, content-free reader failure suitable for CLI diagnostics."""

    def __init__(self, reason: ReasonCode, relative_path: str = "."):
        self.reason = reason
        self.relative_path = _safe_display(relative_path)
        super().__init__(
            f"{self.relative_path}: {reason.value}; "
            f"expected {_EXPECTATIONS[reason]}"
        )


class JsonDisciplineError(ValueError):
    """A content-free strict-JSON failure."""


def strict_json_loads(text: str):
    """Decode JSON while refusing duplicate keys and non-finite numbers."""

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise JsonDisciplineError(
                    "duplicate-json-key; expected unique object keys"
                )
            result[key] = value
        return result

    def reject_constant(_value):
        raise JsonDisciplineError(
            "non-finite-json-number; expected a finite JSON number"
        )

    return json.loads(
        text,
        object_pairs_hook=object_pairs,
        parse_constant=reject_constant,
    )


_DIR_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)
_FILE_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NONBLOCK", 0)
)


@dataclass(frozen=True)
class ScannedFile:
    """A root-bound file whose later open repeats the no-follow checks."""

    reader: "AtlasReader"
    parts: tuple[str, ...]

    @property
    def path(self) -> Path:
        return self.reader.root.joinpath(*self.parts)

    @property
    def name(self) -> str:
        return self.parts[-1]

    @property
    def relative_path(self) -> Path:
        return Path(*self.parts)

    def open(self, mode: str = "rb") -> IO[bytes]:
        if mode != "rb":
            raise ValueError("shared Atlas readers support binary reads only")
        return os.fdopen(self.reader._open_file(self.parts), mode)

    def read_bytes(self) -> bytes:
        with self.open("rb") as stream:
            return stream.read()

    def __fspath__(self) -> str:
        return os.fspath(self.path)

    def __str__(self) -> str:
        return str(self.path)


class AtlasReader:
    """No-follow scanner and opener bound to one resolved directory root."""

    def __init__(self, root: str | os.PathLike[str]):
        try:
            absolute = Path(os.path.abspath(root))
        except (TypeError, ValueError, OSError):
            raise ReaderError(ReasonCode.INVALID_ROOT) from None
        self._anchor = Path(absolute.anchor)
        self._root_parts = absolute.parts[1:]
        fd = self._open_root()
        os.close(fd)
        # abspath has normalized dot/traversal components, and _open_root
        # proved every remaining component is a real directory. Calling
        # Path.resolve() after closing that proof fd would reintroduce a
        # follow-capable race.
        self.root = absolute

    def is_directory(self, relative_path: str | os.PathLike[str]) -> bool:
        parts = _relative_parts(relative_path)
        fd = self._open_directory(parts, missing_ok=True)
        if fd is None:
            return False
        os.close(fd)
        return True

    def scan(
        self,
        relative_path: str | os.PathLike[str] = ".",
        *,
        suffix: str | None = None,
        recursive: bool = False,
    ) -> list[ScannedFile]:
        """Return a deterministic file list after validating the whole scan."""

        parts = _relative_parts(relative_path)
        directory_fd = self._open_directory(parts, missing_ok=True)
        if directory_fd is None:
            return []
        files: list[ScannedFile] = []
        try:
            self._scan_directory(
                directory_fd,
                parts,
                suffix=suffix,
                recursive=recursive,
                files=files,
            )
        finally:
            os.close(directory_fd)
        return files

    def has_entries(self, relative_path: str | os.PathLike[str] = ".") -> bool:
        """Report directory occupancy after lstat-checking every direct entry."""

        parts = _relative_parts(relative_path)
        directory_fd = self._open_directory(parts, missing_ok=False)
        assert directory_fd is not None
        try:
            try:
                with os.scandir(directory_fd) as iterator:
                    entries = list(iterator)
            except OSError:
                raise ReaderError(
                    ReasonCode.UNSAFE_PATH, _display_parts(parts)
                ) from None
            for entry in entries:
                child_parts = (*parts, entry.name)
                try:
                    mode = entry.stat(follow_symlinks=False).st_mode
                except OSError:
                    raise ReaderError(
                        ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                    ) from None
                if stat.S_ISLNK(mode) or not (
                    stat.S_ISDIR(mode) or stat.S_ISREG(mode)
                ):
                    raise ReaderError(
                        ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                    )
            return bool(entries)
        finally:
            os.close(directory_fd)

    def optional_file(
        self, relative_path: str | os.PathLike[str]
    ) -> ScannedFile | None:
        parts = _relative_parts(relative_path)
        try:
            fd = self._open_file(parts)
        except FileNotFoundError:
            return None
        os.close(fd)
        return ScannedFile(self, parts)

    def _open_root(self) -> int:
        try:
            directory_fd = os.open(self._anchor, _DIR_FLAGS)
            for component in self._root_parts:
                info = os.stat(
                    component, dir_fd=directory_fd, follow_symlinks=False
                )
                if not stat.S_ISDIR(info.st_mode):
                    raise OSError
                next_fd = os.open(component, _DIR_FLAGS, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = next_fd
            return directory_fd
        except OSError:
            try:
                os.close(directory_fd)
            except (OSError, UnboundLocalError):
                pass
            raise ReaderError(ReasonCode.INVALID_ROOT) from None

    def _open_directory(
        self, parts: tuple[str, ...], *, missing_ok: bool
    ) -> int | None:
        directory_fd = self._open_root()
        try:
            for component in parts:
                try:
                    info = os.stat(
                        component, dir_fd=directory_fd, follow_symlinks=False
                    )
                    if not stat.S_ISDIR(info.st_mode):
                        raise OSError
                    next_fd = os.open(component, _DIR_FLAGS, dir_fd=directory_fd)
                except FileNotFoundError:
                    if missing_ok:
                        os.close(directory_fd)
                        return None
                    raise
                os.close(directory_fd)
                directory_fd = next_fd
            return directory_fd
        except ReaderError:
            os.close(directory_fd)
            raise
        except FileNotFoundError:
            os.close(directory_fd)
            raise
        except OSError:
            os.close(directory_fd)
            raise ReaderError(
                ReasonCode.UNSAFE_PATH, _display_parts(parts)
            ) from None

    def _open_file(self, parts: tuple[str, ...]) -> int:
        if not parts:
            raise ReaderError(ReasonCode.UNSAFE_PATH)
        parent_fd = self._open_directory(parts[:-1], missing_ok=False)
        assert parent_fd is not None
        try:
            info = os.stat(
                parts[-1], dir_fd=parent_fd, follow_symlinks=False
            )
            if not stat.S_ISREG(info.st_mode):
                raise OSError
            fd = os.open(parts[-1], _FILE_FLAGS, dir_fd=parent_fd)
        except FileNotFoundError:
            raise
        except OSError:
            raise ReaderError(
                ReasonCode.UNSAFE_PATH, _display_parts(parts)
            ) from None
        finally:
            os.close(parent_fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ReaderError(
                    ReasonCode.UNSAFE_PATH, _display_parts(parts)
                )
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _scan_directory(
        self,
        directory_fd: int,
        parts: tuple[str, ...],
        *,
        suffix: str | None,
        recursive: bool,
        files: list[ScannedFile],
    ) -> None:
        try:
            with os.scandir(directory_fd) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError:
            raise ReaderError(
                ReasonCode.UNSAFE_PATH, _display_parts(parts)
            ) from None
        for entry in entries:
            child_parts = (*parts, entry.name)
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                raise ReaderError(
                    ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                ) from None
            if stat.S_ISLNK(info.st_mode):
                raise ReaderError(
                    ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                )
            if stat.S_ISDIR(info.st_mode):
                if recursive:
                    try:
                        child_fd = os.open(entry.name, _DIR_FLAGS, dir_fd=directory_fd)
                    except OSError:
                        raise ReaderError(
                            ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                        ) from None
                    try:
                        self._scan_directory(
                            child_fd,
                            child_parts,
                            suffix=suffix,
                            recursive=True,
                            files=files,
                        )
                    finally:
                        os.close(child_fd)
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ReaderError(
                    ReasonCode.UNSAFE_PATH, _display_parts(child_parts)
                )
            if suffix is None or entry.name.endswith(suffix):
                files.append(ScannedFile(self, child_parts))


def _relative_parts(relative_path: str | os.PathLike[str]) -> tuple[str, ...]:
    try:
        path = Path(relative_path)
    except (TypeError, ValueError):
        raise ReaderError(ReasonCode.UNSAFE_PATH) from None
    if path == Path("."):
        return ()
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ReaderError(ReasonCode.UNSAFE_PATH)
    return path.parts


def _safe_display(value: str) -> str:
    return "".join(char if char.isprintable() else "?" for char in value)


def _display_parts(parts: tuple[str, ...]) -> str:
    return _safe_display("/".join(parts) or ".")
