## §20. Graph Builder

`scripts/build_atlas_graph.py` should:

```text
1. Read concept, pattern, and zone frontmatter (§32.1).
2. Read material frontmatter.
3. Expand MaterialPart nodes.
4. Read direction files.
5. Read suggested routes.
6. Read trail segments.
7. Read probes.
8. Read questions, artifacts, encounters, and decisions from state/ (JSONL journals);
   build the retired→living id map from formerly: frontmatter and resolve
   journal and curated refs through it (§34.4).
9. Fold current understanding, material, question, and body state from the journals (§14.5–§14.8, §9.8, §9.13; body mappings §32.2–§32.3): exposure and zone contact = monotone max over mapped evidence; confidence/clarity/coverage and the gated body dimensions (§32.2) = last confirmed decision; question status = last confirmed decision, else open; depth_reached/last_seen from encounters.
10. Compute influence field from artifacts, encounters, questions, and trail segments (§9.10).
11. Validate references — §34.4 included: a retired id that is living,
    or present in two formerly lists, is an error.
12. Emit graph/atlas-graph.json, embedding the silhouette projection collected from zone frontmatter (`figure_region`, §32) under `projections` (§10) — the viewer's single input stays single (§16.4).
```

Step 11 classifies a broken reference by the ref's origin, never the target's kind: a ref in a retained journal row — whatever it targets: a trail segment, artifact, encounter, question, or a curated node (zone, material, concept, pattern) — is skipped with a warning, never a build failure — deletion is the owner’s right (§5.2), and §34.2 promises exactly such survivors; a ref authored in a living curated file is an error — curation converges (§34.4), journals never have to. The report groups dangling journal refs apart from curated-link errors; purge notes explain purge-era dangles (§34.2–§34.3).

No external dependencies for MVP.

Allowed standard library:

```text
json
pathlib
datetime
re
```

If YAML is needed, either:

```text
use simple frontmatter parser manually
or vendor a tiny parser
or require PyYAML later
```

MVP should prefer minimal dependencies.

---

