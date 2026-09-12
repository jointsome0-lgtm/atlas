# Trail Atlas

Trail Atlas is a command-line log for people and agents working with books, articles and other materials. Save an account such as "Vera Example: I opened the introduction", find it later, and correct it when needed. Atlas keeps the records in local JSON files.

## Install

The package is `trail-atlas`. It installs the `tatlas` command:

```sh
pip install trail-atlas
```

Run this in a Python environment where you can install packages. Supported platforms need neither Rust nor uv. See [other installation methods](#other-installation-methods) for platform requirements and source builds.

## Save and read a record

The following example uses invented Vera Example data in a fresh temporary directory. Choose the setup line for your shell.

Bash on Linux or macOS:

```sh
ATLAS_DEMO_DIR="$(mktemp -d /tmp/vera-example-atlas.XXXXXX)"
```

PowerShell on Windows:

```powershell
$ATLAS_DEMO_DIR = Join-Path ([IO.Path]::GetTempPath()) ("vera-example-atlas-" + [guid]::NewGuid())
```

Then run these commands in the same shell:

```sh
tatlas --data-dir "$ATLAS_DEMO_DIR" --json add --id vera-example-1 --material https://example.org/book --actor "Vera Example" --original "Vera Example: I opened the introduction."
tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1
```

`add` saves the record. `get` reads it back by ID. Both JSON results contain `record.id` set to `vera-example-1` and `record.revision` set to `1`.

- `--material` identifies the book, article or other material by an exact URL or reference. Atlas does not fetch it or rewrite the reference.
- `--actor` names the person or agent who interacted with that material. This can be someone other than the caller.
- `--original` stores the supplied statement word for word.

Only material and actor are required record fields. Saving a reference alone leaves the action unspecified. `tatlas add --help` explains the optional fields.

For real records, choose a fixed, absolute, private directory outside public code checkouts. Pass it as `--data-dir` every time. Later commands must use the same directory. Atlas creates the store on the first write; it does not detect repository boundaries. The example's temporary directory is for disposable data.

`--json` produces operation results on stdout and errors on stderr. Help remains text. Input comes from flags. `--data-dir` and `--json` work before or after the command name.

## Records and marks

A record describes one interaction with a material. If Vera Example opens a book today and reads a chapter tomorrow, those can be two records with different IDs. Use `add` for another interaction and `edit` to correct an existing record. Choose and retain a new ID for each interaction so you can retry by ID. If you omit `--id`, Atlas generates one.

A mark describes a material's current priority. Use `focus` for materials to work on now, `later` for ones to revisit, or `none` to clear it. One material can have many records and at most one current mark. Marks can exist without records. Editing or deleting a record does not change the mark, and marks never change automatically.

## Choose a command

| To | Use |
| --- | --- |
| Save another interaction | `add` |
| Find saved records | `list` |
| Read a record by ID | `get` |
| Correct a record or clear optional fields | `edit` |
| Delete a record's content | `rm` |
| Set or clear a material's mark | `mark` |
| Read material marks | `marks` |

Run `tatlas COMMAND --help` for the fields and a complete example of that command.

`list` puts the newest saved records first and omits deletion receipts. Filter by an exact reference with `--material`, or by a case-sensitive substring with `--context`. Add `--state focus`, `--state later` or `--state none` to filter by material marks. Omit `--state` for all records. `none` includes both never-marked and cleared materials. A record must match every supplied filter.

## Change existing data

A revision identifies a saved version. Atlas increases it on each edit, deletion or mark update. `--if-revision` makes your command fail if the current revision differs from the one you read.

- Before `edit` or `rm`, use `get --id ID` and pass its `record.revision`.
- Before `mark`, use `marks`, find the exact material reference and pass that entry's `revision`. Use `0` only when the material is absent. Clearing a mark increases its revision; it does not reset to `0`.

Record revisions and mark revisions are separate counters. If the revision has changed, Atlas rejects the write and returns `current_revision`. Read the current data and reconsider your change before trying again.

`edit` changes only the fields you supply. Repeat `--clear FIELD` to clear multiple optional fields. The record ID and recording time stay unchanged. `rm` removes the content but keeps an ID/revision deletion receipt that `get` can read. The deleted ID stays reserved. Deletion does not securely erase old filesystem blocks or backups.

## Recover from an uncertain result

An error or missing response does not always mean the write failed. Check saved state before repeating a command.

| Command | What to do |
| --- | --- |
| `add` with a retained ID | Repeat the same ID and all the same fields. `replayed: true` confirms the revision-1 record without another write. Different fields, a later revision or a deleted record cause a conflict. |
| `add` without a known ID | Find it with `list --material` and `get`. Repeating `add` can create a duplicate. Several matching records leave the outcome unresolved until you identify yours. |
| `edit` or `mark` | Read `get` or `marks` and compare fields and revision with the intended change. Matching values alone do not prove which caller wrote them. |
| `rm` | Repeat with the same pre-deletion revision to confirm its receipt without another write, or read `get`. |

Exit codes are `0` for success, `1` for an operation or storage error, `2` for flag parsing errors and `3` for revision or ID conflicts.

## Storage details

The store contains `records/<id>.json`, optional `marks.json` and `.lock`. Reads require an initialized store. Schema version 1 rejects unknown fields and invalid record identities. IDs use 1 to 64 lowercase ASCII letters, digits, hyphens or underscores; Windows device names are reserved on every platform. On Unix, Atlas creates private directories and files. Existing directory permissions remain the owner's responsibility.

Atlas generates recording time in UTC, stored as Unix milliseconds in `recorded_at_ms`. The optional `--interaction-date` describes when the interaction happened. It does not change list order. Equal recording times use ascending IDs.

Processes coordinate through an OS advisory lock. Readers hold a shared lock. Writers hold an exclusive lock while reading, checking revisions and replacing files. A writer writes a temporary file beside the destination, flushes and syncs it, then renames it atomically. Linux and macOS also sync the containing directory. Windows does not, so power loss can lose a recently completed rename. Process coordination and complete file replacement still apply. Tests cover process restarts and concurrent processes, not power loss.

Use a local filesystem with working advisory locks and atomic rename. Network filesystems and direct edits outside Atlas are outside this protocol. Malformed data fails visibly without automatic repair; lists fail without partial output.

The OS releases locks when processes die. Keep `.lock` in place. Leftover `.atlas-*` temporary files are ignored and may contain uncommitted data. Remove them only while no Atlas process is using the store.

## Other installation methods

Ready-made packages cover Linux with glibc 2.28 or newer on x86_64 and ARM64, macOS 13 or newer on Intel and Apple silicon, and Windows x86_64. Other targets require a source build and have no native CI coverage.

With uv, use `uv tool install trail-atlas`. For one run, use `uvx --from trail-atlas tatlas --help`.

A source build needs current stable Rust and a native linker. This implementation was checked with Rust 1.98.1. Pip also needs these tools if no ready-made package matches the platform.

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
