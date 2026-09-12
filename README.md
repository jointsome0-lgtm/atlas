# Trail Atlas

Trail Atlas keeps a local log of what people and agents do with books, articles and other materials. Each record names the material and the person or agent involved. Optional fields store their original statement and other details. Saving a reference alone does not claim reading or understanding.

## Install

The package is `trail-atlas`. The command is `tatlas`.

```sh
pip install trail-atlas
tatlas --help
```

Run pip in a Python environment where you can install packages. On supported platforms it installs a ready-made program; Rust and uv are not needed. Wheels cover Linux with glibc 2.28 or newer on x86_64 and ARM64, macOS 13 or newer on Intel and Apple silicon, and Windows x86_64. Other targets require a source build.

## Make a record

```sh
tatlas add --help
```

Each command's help explains its fields, gives a complete example with invented Vera Example data, and describes the result. Commands that change data also explain recovery after a conflict or uncertain result. Examples use Bash on Linux/macOS and PowerShell on Windows.

Choose an absolute private data directory and pass it as `--data-dir` on every data command. Use the same directory for later commands. Keep real records outside public code checkouts; Atlas does not discover repository boundaries at runtime. The temporary directories in the help examples are for disposable data.

`--material` is an exact URL or other reference. Atlas does not fetch or normalize it. `--actor` names the person or agent who interacted with the material; the caller and actor may be different. Preserve the supplied account rather than inferring an action from the reference.

Use `--json` when a program or agent will read the result. Results go to stdout, errors to stderr. JSON is output only. `--data-dir` and `--json` work before or after the subcommand.

## Commands

| Command | Purpose |
| --- | --- |
| `add` | Save a reference and any supplied account of interaction. |
| `list` | Read live interactions, newest recording time first. |
| `get` | Read one record and its revision, including a deletion receipt. |
| `edit` | Change specified fields or clear optional fields. |
| `rm` | Remove record content, keeping its ID/revision deletion receipt. |
| `mark` | Set Focus/Later or clear a material's current mark. |
| `marks` | Read current marks and their revisions. |

Run `tatlas COMMAND --help` for the command you need. The common route is `add`, then `list` or `get`. Before `edit` or `rm`, read the record with `get` and use its revision. Before `mark`, read `marks` and use the material's mark revision. These are separate revision counters.

Focus and Later are mutually exclusive current marks on exact material references. They are independent of the interaction records. Clearing uses `--state none`. Marks can exist without records and never change automatically. In `list`, omit `--state` for All; `--state none` includes unmarked materials and cleared marks. Filters combine with AND. `--context` matches a case-sensitive substring.

Recording time is generated in UTC when saving and appears as Unix milliseconds in `recorded_at_ms`. The optional `--interaction-date` is separate and does not control list order. Equal recording times use ascending IDs. Supplied IDs use 1 to 64 lowercase ASCII letters, digits, hyphens or underscores; Windows device names are reserved on every platform.

Exit codes are 0 for success, 1 for an operation or storage error, 2 for flag parsing errors and 3 for revision or ID conflicts. Conflicts include the current revision.

## Recovery and storage

For a retry-safe creation, choose and retain `--id` before sending `add`. Repeating the same ID and caller fields returns the existing revision-1 record with `replayed: true`. Changed fields, an edited record or a deleted ID cause a conflict. A generated-ID creation with an unknown outcome must be recovered with `list --material` and `get`; blindly repeating it can create a duplicate. If several records match, the result remains uncertain until the caller identifies it.

Edits and marks require the revision observed by the caller. A stale write fails without changing state. After losing an edit or mark receipt, use `get` or `marks` and compare the intended state with the returned revision. A matching value alone does not prove which caller wrote it. Repeating a successful deletion with the same pre-deletion revision confirms its tombstone without another write. IDs remain reserved after deletion.

The store is a directory containing `records/<id>.json`, optional `marks.json`, and `.lock`. JSON schema version 1 rejects unknown fields and invalid record identities. Writers initialize the store; reads require an initialized store. New directories and files use private permissions on Unix. Existing directory permissions remain the owner's responsibility.

All Atlas processes using a store coordinate through the same OS advisory lock. Writers hold an exclusive lock across reading, revision checks and replacement; readers use a shared lock. A writer creates a temporary file beside its destination, flushes and syncs it, renames it atomically, then syncs the directory on Linux and macOS. Windows flushes the record file but does not sync the containing directory; a power loss can therefore lose a recently completed rename. Process coordination and complete file replacement still apply. The OS releases locks when processes die. Leftover `.atlas-*` temporary files are ignored; they may retain uncommitted content and may be removed only while no Atlas process is using the store. Keep `.lock` in place.

Use a local filesystem with working advisory locks and atomic rename. Network filesystems and uncoordinated direct edits are outside this protocol. Malformed JSON fails visibly, and Atlas does not repair it automatically. Lists fail without partial output if any record is malformed. A failure after rename or a lost output receipt may mean the write committed; read current state before retrying. These tests exercise process restarts and concurrent processes, not power-loss simulation.

## Other installation methods

If you already use uv:

```sh
uv tool install trail-atlas
```

For one run:

```sh
uvx --from trail-atlas tatlas --help
```

A source build needs current stable Rust and a native linker. This implementation was checked with Rust 1.98.1. Pip also needs these tools when it must build the source archive because no wheel matches the platform.

```sh
cargo build --locked --release
cargo install --locked --path .
```

The built executable is `target/release/tatlas`, or `tatlas.exe` on Windows. It has no server or network access.

## Development

Read AGENTS.md and GOALS.md for repository rules. Check changes with:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
python3 scripts/limits.py
```

Stage new files before running limits. The public-hygiene check reads staged blobs, so an unstaged edit cannot hide an unmarked staged fixture or missing ignore rule. Known path checks do not detect every personal fact; review data before committing. The optional pre-commit hook runs formatting and limits without changing Git hook configuration.

CI runs the checks on all five supported platforms, then builds and installs each wheel through pip, uv tool and uvx. One Linux job also builds and installs the source archive. The publisher uploads those same tested artifacts to PyPI; the GitHub release attaches them and SHA256SUMS. It does not rebuild packages. Rust SBOM generation is disabled because its metadata includes local build paths.

Publishing uses repository `jointsome0-lgtm/atlas`, workflow `ci.yml` and environment `pypi`. A tag `vX.Y.Z` must match Cargo.toml and Cargo.lock and point to a commit on main. The tag must also be allowed by the environment's deployment policy; the first release configured only `v0.1.0`. Changes to publishing access require the owner's approval.

## Map

- `examples/`: Rust syntax checker used by the limits entrypoint.
- `scripts/`: Repository limits, distribution contents and installed CLI checks.
- `src/`: CLI parsing, presentation, record operations and JSON storage.
- `tests/`: Product and limits tests through executable boundaries.
- `tests/support/`: Temporary-store and subprocess helpers for CLI tests.
