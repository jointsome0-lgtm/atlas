## §25. Non-Functional Requirements

## §25.1 Local-First

All primary data lives in the instance repository (§25.6; the
engine/instance topology is the composing shell's decision).

## §25.2 Versionable

All graph state should be plain text or JSON:

```text
Markdown
YAML
JSON / JSONL (journals, §8)
```

## §25.3 Auditable

Every state update must be traceable to recorded evidence (§9.12).

## §25.4 Low Pressure

No dashboards should imply lateness, failure, or incompletion.

## §25.5 Extensible

The system should later support:

```text
multiple learning plans
multiple domains (first instantiated: body atlas — §32, #17)
source annotations
spaced revisits
artifact embeddings
better visualization
external connectors (adapters outside atlas, targeting the §33 formats)
```

Domain rule: the core is domain-parameterized. Core means the journals (§8), evidence and decisions (§9.12–§9.13), the fold (§14.5–§14.8, §20), influence (§9.10), the frontier (§15), and the no-guilt invariants (§31). What varies per domain: field semantics (what a region is), the state scales (§14.1–§14.4), observer interpretation (§13), probe and material meaning, field geometry (knowledge is force-directed; the body is anatomical, §32), suggestion-time constraints (domain state may constrain route/frontier suggestions, §32.5), and data sensitivity classes (§32.6). A second domain arrives as its own field with its own scales through its own design pass, never as a fork of the core. The first one is instantiated in §32 (body atlas, #17) and confirmed the parameterization. The design test stands for the next candidate: prefer decisions that do not hardwire domain semantics into the core, and build no abstraction machinery a real domain has not asked for (§28.3).

## §25.6 Durable

The Atlas instance repository is a git repository, not optionally so: journals and curated content are committed as part of normal operation, and version history is the recovery mechanism. Truncating compaction is already forbidden (§8). The one carve-out is a purge (§34, by standing Decision Log entry), and it restarts the history-as-recovery clock at the rewrite point. Derived outputs are the exception to committing: the emitted graph and snapshots are untracked in the instance. Recovery of a derivable file is a rebuild, not a checkout (§31.8), and tracked builds would drag every historical blob into every rewrite set (§34.2). Durability beyond the machine is a user-initiated copy of the whole repo, to a private remote or another medium. Atlas itself never syncs, pushes, or backs up on its own initiative (§24, §31.7). A stored copy of derivable values is not a backup but a second source of truth (§31.8).

The instance is single-writer (#36). Every writing flow (import §12/§21, observation §13, the builder §20, snapshot export §33.4, the purge runbook §34, and any future writer) takes `.atlas-lock` at the instance root: created atomically (acquire-if-absent, O_CREAT|O_EXCL semantics, never check-then-create), untracked, holding `{pid, started_at}`. A run that finds it already held refuses (exit 1); no merge semantics exist. A stale lock after a crash is removed by hand on the refusal message's evidence; there is no automatic reclaim (§28.3). Git is the durability layer, not a concurrency model: merging two branches' JSONL journals is out of scope. Single-writer covers the model.

## §25.7 Persisted and Contract Formats

Every persisted format and transient runner-contract format has one machine-readable schema: JSON Schema 2020-12, one file per format, authored under `spec/schemas/` (#30, #46). Schemas are canon like the §§ they sit beside, never emitted artifacts. Enum canon stays the § prose (§9, §14; #24): a schema transcribes and cites the lists, never forks them. The validator (§8) validates instance files against the schemas and checks the builder's constants against the same schemas: code constants are checked, never canonical (§20.3's discipline, format-wide). The YAML-shaped surfaces parse by the §20.4 grammar first; a schema validates the parsed object, never raw markdown.

Two serialised forms, because a reader must reproduce bytes it did not write and §20.1's byte-identical rebuild leaves no room for a house style. An emitted document (the graph, the snapshot, a report, a run manifest) is indented two spaces, keeps its keys in the order its emitter built them, writes non-ASCII literally rather than escaped, and ends in exactly one LF. A journal or receipt row is one line: no space after any separator, keys sorted by code point (§20.3), non-ASCII literal. The two are not interchangeable, and neither is a formatting preference an implementation may re-choose: adopting either everywhere silently changes the other surface's bytes. Reading is strict on both, and at the §17.7 runner boundary: a duplicate key and a non-finite number are errors, never a last-wins or an infinity (§24.2).

Versioning, stated here once for every registered format (the boundary formats, §33.1, are its instances):

```text
Emitted files — the graph (§10), the snapshot (§33.4), the
redacted variant, every report, the run manifest (§17.6) —
carry format + integer version.
Transient runner input/output files (§17.7) carry the same
envelope and version discipline; their delete-on-exit lifecycle
does not make their wire shape open or implicit.
Additive change is the norm, landed with its schema in the
emitting change — the schemas are closed (#37), so an emitted
file never carries a field its schema lacks; a rename, removal,
or semantic change bumps the version through a Decision Log
entry. Forward tolerance for unknown fields is the OUT
consumer's (§33.4): a downstream adapter ignores what it does
not know. Atlas's own readers never do — a schema violation,
unknown keys included, fails closed (§16.5, §24.2, §33.2); an
unsupported version fails visibly (§10, #44). Inward intake is
stricter still: a new record field is a schema version bump
(§33.2), never a silently tolerated extra.
Journal rows carry no version key: journals are append-only
history and are never migrated (§8), so a row-kind schema evolves
additively only — a new field is optional forever, and a semantic
change is a new field or a new row kind, never a reinterpretation
of stored rows.
Curated frontmatter and the extracted plan document carry no
version key: the instance pins an engine revision (§8) whose
schema set is the contract; a breaking curated-schema change
ships with the migration of the curated content — curation is
editable where journals are not.
```

The registered formats and their schema files (`spec/schemas/<name>.schema.json`; the numeric ceilings are §20.4's and §25.8's, #23):

```text
concept, zone, pattern, material, direction, suggested-route,
trail-segment, probe   — curated frontmatter, one per §6 kind
                         (material embeds its parts, §9.3)
plan-extract           — plans/extracted/ document (§21.2)
journal-artifact, journal-encounter, journal-question,
journal-decision, journal-mapping-decision, journal-receipt,
journal-purge          — one per state/ row kind (§8)
atlas-graph            — graph emission (§10); the redacted
                         variant included — withheld required
                         there, forbidden on the full graph (§20)
atlas-snapshot         — state snapshot (§33.4)
atlas-intake           — intake envelope + records (§33.2)
report-batch           — deterministic intake result (§33.2, #56)
run-manifest           — per-run audit of a model-assisted
                         agent run (§17.6, #41); the #46 runner
                         is its one writer
runner-plan-importer-input, runner-plan-importer-output,
runner-artifact-observer-input, runner-artifact-observer-output
                       — transient closed role boundary (§17.7,
                         #46), deleted with the contract workspace
report-import, report-build
                       — reserved derived, purgeable reports (§12.2
                         step 11, §20); their shapes stay their
                         flows' to define so no report ships schema-less
```

The registry is closed: a new persisted or runner-contract format registers here in the same change that creates it.

## §25.8 Executable Floors

The environment and limits §27 tests against (#23, #42); any value changes only through a Decision Log entry:

```text
Runtime: TypeScript executed by Bun 1.3.14 — the CI pin and the
supported floor; entry points stay dependency-free (§20).
Platform: the platforms the boundary below has a registered
target for, today Linux alone; macOS is intended and becomes
supported in the change that registers its triple, not before.
Since nothing falls back to a path, an unbuilt target is a
refusal at startup rather than a slower route — so a platform
listed here and a platform Atlas runs on are the same list, and
this line is the one that has to move. Windows is a non-goal —
the root-bound directory operations below have no native
equivalent there, and a platform that cannot hold §24.2's
containment is not one Atlas claims.
Filesystem boundary: one compiled component owns the operations
whose containment cannot be expressed on a path — root-bound
no-follow opens, directory reads from a pinned descriptor,
atomic durable replace, and the lock primitive (§24.2, §25.6).
It takes descriptors and flags and returns descriptors, bounded
bytes, and the true errno; it knows no node kind, journal shape,
schema, id, or diagnostic text, and every containment policy
stays above it. A descriptor is a capability: re-deriving one
through a path — including a per-process filesystem view of it —
re-checks permissions and collapses distinct failures into
"absent", which turns a use-after-close into an empty successful
scan. That is the failure this boundary exists to make
impossible, so no path-based fallback stands behind it: the
capability probe at startup either finds the boundary or the run
refuses. The artifact ships committed, one per supported target,
beside its source and a pinned build recipe, with a CI job that
rebuilds and verifies it — so a plain checkout still runs
everything, and §17.5's `deterministic` marking stays literally
true, the pinned engine revision containing the very bytes that
ran. The toolchain version, edition, and target triples are
recorded values here like any other floor: Rust 1.96.0, edition
2024, `x86_64-unknown-linux-gnu`; further triples register here
in the change that first builds them, which is the same change
that widens the platform line above. The crate is `no_std`,
declares the libc entry points it calls, and resolves no
dependency, so the built library's undefined-symbol list is the
complete set of calls it can make — the blindness claimed above
is something a reviewer checks in one command rather than a
promise the prose makes.
Viewer build: the viewer's source of truth is TypeScript under
viewer/src/; Bun type-strips it to the committed viewer/*.js the
browser loads, and TypeScript 6.0.3 typechecks the sources. The
emission is pure erasure: a construct that survives stripping —
enum, namespace, parameter properties, import aliases,
decorators — is barred in the source, by erasableSyntaxOnly and,
for decorators (which that flag does not reach), by the build
refusing to emit them. Output equality is the second gate, not
the ban: the committed file must reproduce byte for byte from
its source, which alone would pass a regenerated enum. No
consumer of the viewer may require Bun — the emission stays
committed, and an embedder (§16.4) loads bytes, never a build.
That half of the rule is untouched by the runtime above: the
operator of an Atlas command now needs Bun; a viewer consumer
still does not.
Text: strict UTF-8 without BOM, LF only — every Atlas-authored
persisted text file (§20.4 states it for frontmatter); delivered
intake batches and imported plan originals stay as delivered
(§33.2, §12.2 step 1).
Build floor: fixtures/perf/10k — 10,000 nodes at ~2.3 edges/node,
deterministically generated, output untracked (§27) — builds in
≤ 24 s wall time and ≤ 400 MiB peak RSS on the CI runner.
Emission budget: the emitted graph averages ≤ 4,500 bytes per
node.
Journal row: ≤ 16,384 bytes per JSONL record — a policy ceiling,
no corpus exists yet: a row that outgrows it is content in event
clothing.
Viewer: interactive at 1,000 nodes in view (measured: 3.1 ms per
naive-layout iteration, 0.65 ms per canvas frame); past 2,400
nodes in view — the measured frame-budget crossing of the naive
n² layout — the §27.8 list fallback engages; a smarter layout
raises the ceiling through the Decision Log, never silently. The
count is what the view draws, so the stubs a focus horizon leaves
at its rim (§16.3) count with the plates: they are not laid out,
but each is drawn.
Viewer acceptance ceilings (#37, §16.5, #44): graph file
≤ 67,108,864 bytes, ≤ 131,072 nodes, ≤ 262,144 edges — the
byte cap before parsing, the counts before any per-item work;
raw fragment ≤ 1,024 bytes and each decoded parameter value
≤ 512 bytes — checked before use. Measured floor 2026-07-21:
the 10k corpus emitted 7,294,150 B / 10,000 nodes / 19,479
edges; the longest legitimate fragment was 74 B raw, the
longest parameter value 40 B decoded — values are ×~10 rounded
to powers of two, conjunctive (whichever bound trips first
rejects). The 2,400-node line above stays a rendering
fallback, never an acceptance bound.
Foreign-input acceptance ceilings (#37, §24.2): intake batches
≤ 16,777,216 total bytes, ≤ 16,384 records, ≤ 16,384 bytes per
record, ≤ 8,192 bytes per string, nesting depth ≤ 8 (§33.2, #56).
Manual-capture record file (#47, §26.1): ≤ 16,384 total bytes,
≤ 8,192 bytes per string, nesting depth ≤ 8; the appended row
keeps the journal-row ceiling above.
Values remain pending the same measured-floor process for
imported-plan file bytes (§12), and observer per-file bytes,
manifest entries, and per-session corpus bytes (§13).
CLI contract (every script): exit 0 success, 1 failure, 2 usage;
diagnostics to stderr, one per line, prefixed ERROR: / WARNING:;
stdout carries the result summary.
Determinism: §20.1's byte-identical rebuild — §27.7 executes it.
Atomicity: §20.2's discipline; the builder's own crash-path
tests exercise it (#60), no acceptance criterion restates it.
Restore drill (documented, run on demand — not a CI job): a
fresh clone of the instance repository plus one build reproduces
the emitted graph byte-identically (§25.6).
Privacy: §27.11's redaction criterion is the floor for every
derived export (§20, §33.4).
```

---
