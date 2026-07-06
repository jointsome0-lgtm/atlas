## §25. Non-Functional Requirements

## §25.1 Local-First

All primary data lives in the repo.

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

The Atlas repository is a git repository — not optionally so: journals and curated content are committed as part of normal operation, and version history is the recovery mechanism (truncating compaction is already forbidden, §8). Durability beyond the machine is a user-initiated copy of the whole repo — a private remote or another medium; Atlas itself never syncs, pushes, or backs up on its own initiative (§24, §31.7). A stored copy of derivable values is not a backup but a second source of truth (§31.8).

---

