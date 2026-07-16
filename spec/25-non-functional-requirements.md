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

This holds by construction (§20, §31.8): state is a fold over the `state/` journals — exposure via the §14.5 mapping, review-gated dimensions via recorded decisions citing evidence (§9.13) — so an untraceable update is unrepresentable.

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

Domain rule: the core — journals (§8), evidence and decisions (§9.12–§9.13), the fold (§14.5–§14.8, §20), influence (§9.10), frontier (§15), the no-guilt invariants (§31) — is domain-parameterized. What varies per domain: field semantics (what a region is), the state scales (§14.1–§14.4), observer interpretation (§13), probe and material meaning, field geometry (knowledge is force-directed; the body is anatomical — §32), suggestion-time constraints (domain state may constrain route/frontier suggestions — §32.5), and data sensitivity classes (§32.6). A second domain arrives as its own field with its own scales through its own design pass — never as a fork of the core; the first one is instantiated in §32 (body atlas, #17) and confirmed the parameterization. The design test stands for the next candidate: prefer decisions that do not hardwire domain semantics into the core, and build no abstraction machinery a real domain has not asked for (§28.3).

## §25.6 Durable

The Atlas instance repository is a git repository — not optionally so: journals and curated content are committed as part of normal operation, and version history is the recovery mechanism (truncating compaction is already forbidden, §8; the one carve-out is a purge — §34, by standing Decision Log entry — and it restarts the history-as-recovery clock at the rewrite point). Derived outputs are the exception to committing: the emitted graph and snapshots are untracked in the instance — recovery of a derivable file is a rebuild, not a checkout (§31.8), and tracked builds would drag every historical blob into every rewrite set (§34.2). Durability beyond the machine is a user-initiated copy of the whole repo — a private remote or another medium; Atlas itself never syncs, pushes, or backs up on its own initiative (§24, §31.7). A stored copy of derivable values is not a backup but a second source of truth (§31.8).

The instance is single-writer (#36). Every writing flow — import (§12/§21), observation (§13), the builder (§20), snapshot export (§33.4), the purge runbook (§34), and any future writer — takes `.atlas-lock` at the instance root: created atomically (acquire-if-absent — O_CREAT|O_EXCL semantics, never check-then-create), untracked, holding `{pid, started_at}`. A run that finds it already held refuses (exit 1); no merge semantics exist. A stale lock after a crash is removed by hand on the refusal message's evidence — there is no automatic reclaim (§28.3). Git is the durability layer, not a concurrency model: merging two branches' JSONL journals is out of scope — single-writer covers the model.

## §25.7 Persisted Formats

Every persisted format has one machine-readable schema — JSON Schema 2020-12, one file per format, authored under `spec/schemas/` (#30). Schemas are canon like the §§ they sit beside, never emitted artifacts; enum canon stays the § prose (§9, §14 — #24): a schema transcribes and cites the lists, never forks them. `scripts/validate_atlas.py` (§8) validates instance files against the schemas and checks the builder's constants against the same schemas — code constants are checked, never canonical (§20.3's discipline, format-wide). The YAML-shaped surfaces parse by the §20.4 grammar first; a schema validates the parsed object, never raw markdown.

Versioning — §33.1's discipline, stated here once for every persisted format (the boundary formats are its instances):

```text
Emitted files — the graph (§10), the snapshot (§33.4), the
redacted variant, every report — carry format + integer version.
Additive change is the norm; a rename, removal, or semantic
change bumps the version through a Decision Log entry; consumers
ignore unknown fields; an unsupported version fails visibly
(§10, #44).
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

The persisted formats and their schema files (`spec/schemas/<name>.schema.json`; the files land with #30's mechanical PR, their numeric ceilings with #23):

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
report-import, report-batch, report-build
                       — derived, purgeable reports (§12.2 step
                         11, §13.2/§33.2, §20); their shapes stay
                         their flows' to define — the ids are
                         reserved so no report ships schema-less
```

The set is closed: a new persisted format registers here in the same change that creates it.

---

