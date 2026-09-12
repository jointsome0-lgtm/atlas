# Trail Atlas

Trail Atlas records how people and agents interact with materials. It is one local Rust CLI with the same flags for everyone. A saved reference says only that it was saved. Atlas does not infer reading, understanding or an actor.

## Install

The PyPI package `trail-atlas` installs the executable `tatlas`.

```sh
uv tool install trail-atlas
tatlas --help
```

Or, inside an activated Python virtual environment:

```sh
python -m pip install trail-atlas
tatlas --help
```

For a one-off run:

```sh
uvx --from trail-atlas tatlas --help
```

Release wheels cover Linux with glibc 2.28 or newer (x86_64 and ARM64), macOS 13 or newer (Intel and Apple silicon), and Windows x86_64. Installing a matching wheel needs no Rust toolchain. Other targets require a source build and have no native CI coverage. Data is plain JSON; the executable has no server or network access.

## Build from source

Use current stable Rust with a native linker. This implementation was checked with Rust 1.98.1.

```sh
cargo build --locked --release
cargo install --locked --path .
```

The executable is `target/release/tatlas` (`tatlas.exe` on Windows). Rust and a linker are also needed when pip builds the source archive because no wheel matches the platform.

## Try it

All data below is invented and marked Vera Example. The first example uses Bash. Every command uses an explicitly chosen absolute directory. Choose a private directory outside every public code checkout for real records. Atlas does not discover repository boundaries at runtime.

```sh
ATLAS_DEMO_DIR="$(mktemp -d /tmp/vera-example-atlas.XXXXXX)"
tatlas --data-dir "$ATLAS_DEMO_DIR" add --id vera-example-1 \
  --material https://example.org/book --actor 'Vera Example' \
  --original 'Vera Example: I opened the introduction.' \
  --action opened --portion introduction --context 'Vera Example research'
tatlas --data-dir "$ATLAS_DEMO_DIR" mark \
  --material https://example.org/book --state focus --if-revision 0
tatlas --data-dir "$ATLAS_DEMO_DIR" list --context research --state focus
tatlas --data-dir "$ATLAS_DEMO_DIR" edit --id vera-example-1 \
  --if-revision 1 --note 'Vera Example correction' --clear action
tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1
tatlas --data-dir "$ATLAS_DEMO_DIR" rm --id vera-example-1 --if-revision 2
tatlas --data-dir "$ATLAS_DEMO_DIR" mark \
  --material https://example.org/book --state none --if-revision 1
```

In PowerShell, create a temporary store and save an invented reference with:

```powershell
$AtlasDemoDir = Join-Path ([IO.Path]::GetTempPath()) ("vera-example-atlas-" + [guid]::NewGuid())
tatlas --data-dir "$AtlasDemoDir" add --material https://example.org/book --actor "Vera Example"
tatlas --data-dir "$AtlasDemoDir" --json list
```

`tatlas --help` has command examples. Each subcommand has `--help`. `--data-dir` and `--json` work before or after the subcommand. JSON is output only. JSON failures go to stderr, successful results to stdout. Exit codes are 0 for success, 1 for storage or operation errors including value validation, 2 for flag parsing and 3 for revision or ID conflicts. Conflicts include the current revision.

## Records and marks

`add` requires `--material` and `--actor`. An ID is generated unless you supply `--id`. Supplied IDs contain 1 to 64 lowercase ASCII letters, digits, hyphens or underscores. Windows device names such as `con`, `nul`, `com1` and `lpt1` are reserved on every platform, so a store can move between case-insensitive filesystems. Material references are exact strings. Atlas neither normalizes URLs nor fetches sources.

Optional flags are `--original`, `--interaction-date YYYY-MM-DD`, `--action`, `--portion`, `--context`, `--note` and `--artifact`. The original statement is stored exactly as supplied. Recording time is UTC, generated when saving, and separate from the optional interaction date. JSON represents it as Unix milliseconds in `recorded_at_ms`.

`get --id ID` reads a record and its revision. `edit --id ID --if-revision N` changes only supplied fields. Use `--clear FIELD` to remove an optional field; repeat the flag to clear several. ID and recording time remain stable. Original statements remain unchanged unless explicitly corrected or cleared. `rm --id ID --if-revision N` removes the record content and prints its deletion receipt. It leaves a content-free ID/revision tombstone, which `get` can read. File replacement does not securely erase old filesystem blocks or external backups.

`mark --material REF --state focus|later|none --if-revision N` updates one current material mark. Use revision 0 for a material never marked. `marks` lists marks and their revisions, including cleared entries. Focus and Later are mutually exclusive. Marks can exist without records, and deleting or correcting an interaction does not change marks. No time-based transitions occur.

`list` returns all live interactions, newest recording time first. Equal recording times use ascending IDs. The optional interaction date does not affect this order. `--material` matches the exact reference; `--context` searches a case-sensitive substring; `--state` filters by the current material mark. Filters combine with AND. Omit `--state` for All. Unmarked and explicitly cleared materials both match `--state none`.

## Recovery and concurrent commands

For a retry-safe creation, choose and retain `--id` before sending `add`. Repeating the same ID and caller fields returns the existing revision-1 record with `replayed: true`. Changed fields, an edited record or a deleted ID cause a conflict. A generated-ID creation with an unknown outcome must be recovered with `list --material` and `get`; blindly repeating it can create a duplicate. If several records match, the result remains uncertain until the caller identifies it.

Edits and marks require the revision observed by the caller. A stale write fails without changing state. After losing an edit or mark receipt, use `get` or `marks` and compare the intended state with the returned revision. A matching value alone does not prove which caller wrote it. Repeating a successful deletion with the same pre-deletion revision confirms its tombstone without another write. IDs remain reserved after deletion.

The store is a directory containing `records/<id>.json`, optional `marks.json`, and `.lock`. JSON schema version 1 rejects unknown fields and invalid record identities. Writers initialize the store; reads require an initialized store. New directories and files use private permissions on Unix. Existing directory permissions remain the owner's responsibility.

All Atlas processes using a store coordinate through the same OS advisory lock. Writers hold an exclusive lock across reading, revision checks and replacement; readers use a shared lock. A writer creates a temporary file beside its destination, flushes and syncs it, renames it atomically, then syncs the directory on Linux and macOS. Windows flushes the record file but does not sync the containing directory; a power loss can therefore lose a recently completed rename. Process coordination and complete file replacement still apply. The OS releases locks when processes die. Leftover `.atlas-*` temporary files are ignored; they may retain uncommitted content and may be removed only while no Atlas process is using the store. Keep `.lock` in place.

Use a local filesystem with working advisory locks and atomic rename. Network filesystems and uncoordinated direct edits are outside this protocol. Malformed JSON fails visibly, and Atlas does not repair it automatically. Lists fail without partial output if any record is malformed. A failure after rename or a lost output receipt may mean the write committed; read current state before retrying. These tests exercise process restarts and concurrent processes, not power-loss simulation.

## Development

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
python3 scripts/limits.py
```

The repository follows the limits model. The Python entrypoint checks tracked size, directories, Markdown and public Git hygiene. It uses Cargo's integration-target discovery, verifies that each target lists runnable tests, and uses a Rust syntax checker built with `rustc_lexer` and `syn` for comments, doc attributes, test discovery and source-inclusion rules. Tests exercise the executable and the checker with invented temporary repositories. This is an explicit Rust adaptation of the Python-oriented limits skill.

Stage new files before running the repository limits check. The public-hygiene check reads staged blobs, so an unstaged edit cannot hide an unmarked staged fixture or missing ignore rule. Its known path rules do not detect every personal fact. Review data before committing. The optional `.githooks/pre-commit` runs formatting and limits; no tool changes your Git hook configuration.

The CI workflow runs the goal tests, formatting, lint and limits checks on each supported platform, then builds a wheel and installs it through both pip and uv. The installed CLI probe uses an empty PATH and invented data. One Linux job also builds and installs the source archive. Distribution checks restrict archive contents to the binary and package metadata, or the explicitly included build sources, README and license.

Before the first PyPI release, configure a [Trusted Publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) for repository `jointsome0-lgtm/atlas`, workflow `ci.yml` and environment `pypi`. Use a tag `vX.Y.Z` matching the stable version in Cargo.toml and Cargo.lock, pointing to a commit on main. The tag run repeats all checks. Only after every platform passes does the publisher upload those same artifacts to PyPI; the following GitHub release attaches them with SHA256 checksums. The publisher does not rebuild packages. Rust SBOM generation is disabled because its metadata includes local build paths.

## Map

- `examples/`: Rust syntax checker used by the limits entrypoint.
- `scripts/`: Repository limits, distribution contents and installed CLI checks.
- `src/`: CLI parsing, presentation, record operations and JSON storage.
- `tests/`: Product and limits tests through executable boundaries.
- `tests/support/`: Temporary-store and subprocess helpers for CLI tests.
