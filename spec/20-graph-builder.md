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
8. Read questions, artifacts, encounters, and decisions from state/ (JSONL journals).
9. Fold current understanding, material, question, and body state from the journals (§14.5–§14.8, §9.8, §9.13; body mappings §32.2–§32.3): exposure and zone contact = monotone max over mapped evidence; confidence/clarity/coverage and the gated body dimensions (§32.2) = last confirmed decision; question status = last confirmed decision, else open; depth_reached/last_seen from encounters.
10. Compute influence field from artifacts, encounters, questions, and trail segments (§9.10).
11. Validate references.
12. Emit graph/atlas-graph.json.
```

Step 11 distinguishes broken curated links (errors) from references to records the user deleted: a missing trail segment, artifact, or encounter is skipped with a warning, never a build failure — deletion is the owner’s right (§5.2).

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

