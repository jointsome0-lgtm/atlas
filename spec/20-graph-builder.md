## §20. Graph Builder

`scripts/build_atlas_graph.py` should:

```text
1. Read concept frontmatter.
2. Read material frontmatter.
3. Expand MaterialPart nodes.
4. Read direction files.
5. Read suggested routes.
6. Read trail segments.
7. Read state YAML.
8. Read influence field YAML.
9. Validate references.
10. Emit graph/atlas-graph.json.
```

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

