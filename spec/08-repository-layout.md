## §8. Repository Layout

Placement principles:

```text
1. One directory per §6 entity kind; the § that owns a flow owns its paths.
2. atlas/  = curated knowledge — written by hand or through review.
3. state/  = event journals — append-only JSONL (§13 writes, §20 folds).
   A journal may rotate into per-year files under a directory of the
   same name (state/decisions/2026.jsonl); the fold reads the
   concatenation. Truncating compaction is forbidden: journals are
   the audit trail (§25.3); the one carve-out is a purge (§34), by
   standing Decision Log entry. Current understanding and material
   state are derived by the §20 fold — no stored state files (§31.8).
4. graph/  = derived outputs — never edited by hand (§20 emits).
5. File names inside atlas/ are content, not structure: the spec does not
   predict them; the example import lives in §12.3.
6. intake/ = delivered batches (§33.2) — kept as delivered (audit),
   never edited by atlas, never checker-scanned (§19).
7. Two repositories realize this tree: the public engine (docs/,
   scripts/, viewer/) and the private instance holding the data
   dirs (atlas/, plans/, intake/, state/; graph/ is derived and
   untracked — §25.6). The instance pins an engine revision; the
   layout table is the composing shell's (§25.1, §34).
```

Normative skeleton — the paths other sections rely on:

```text
atlas/
  README.md
  CLAUDE.md
  AGENTS.md

  docs/
    SDD.md
    spec/
    DECISION-LOG.md
    adr/

  atlas/
    concepts/
    zones/        # body field regions (§32.1)
    patterns/     # body field skills (§32.1)
    materials/
    directions/
    suggested-routes/
    trails/
    probes/

  plans/
    imported/     # sensitive plans under imported/<class>/ (§33.3)
    extracted/

  intake/

  state/
    artifacts.jsonl
    encounters.jsonl
    questions.jsonl
    decisions.jsonl
    intake.jsonl
    purges.jsonl    # §34.3 purge notes — runbook-written

  graph/
    schema.yaml
    atlas-graph.json
    atlas-snapshot.json

  viewer/
    index.html
    app.js
    styles.css

  scripts/
    import_plan.py
    observe_artifacts.py
    build_atlas_graph.py
    export_snapshot.py
    check_atlas_boundaries.py
    validate_atlas.py
```

ADRs are created when a decision needs one — none are pre-named. Templates (`_template.md`) live inside their entity directory.

---
