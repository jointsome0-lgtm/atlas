## §8. Repository Layout

Placement principles:

```text
1. One directory per §6 entity kind; the § that owns a flow owns its paths.
2. atlas/  = curated knowledge — written by hand or through review.
3. state/  = observed records — append-only YAML (§13 writes, §20 reads).
4. graph/  = derived outputs — never edited by hand (§20 emits).
5. File names inside atlas/ are content, not structure: the spec does not
   predict them; the example import lives in §12.3.
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
    imported/
    extracted/

  state/
    concept-state.yaml
    material-state.yaml
    open-questions.yaml
    artifacts.yaml
    encounters.yaml
    influence-field.yaml

  graph/
    schema.yaml
    atlas-graph.json

  viewer/
    index.html
    app.js
    styles.css

  scripts/
    import_plan.py
    observe_artifacts.py
    build_atlas_graph.py
    check_atlas_boundaries.py
    validate_atlas.py
```

ADRs are created when a decision needs one — none are pre-named. Templates (`_template.md`) live inside their entity directory.

---
