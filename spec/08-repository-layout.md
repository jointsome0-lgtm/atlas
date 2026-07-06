## §8. Repository Layout

Placement principles:

```text
1. One directory per §6 entity kind; the § that owns a flow owns its paths.
2. atlas/  = curated knowledge — written by hand or through review.
3. state/  = event journals — append-only JSONL (§13 writes, §20 folds).
   A journal may rotate into per-year files under a directory of the
   same name (state/decisions/2026.jsonl); the fold reads the
   concatenation. Truncating compaction is forbidden: journals are
   the audit trail (§25.3). Current understanding and material state
   are derived by the §20 fold — no stored state files (§31.8).
4. graph/  = derived outputs — never edited by hand (§20 emits).
5. File names inside atlas/ are content, not structure: the spec does not
   predict them; the example import lives in §12.3.
6. intake/ = delivered batches (§33.2) — kept as delivered (audit),
   never edited by atlas, never checker-scanned (§19).
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
