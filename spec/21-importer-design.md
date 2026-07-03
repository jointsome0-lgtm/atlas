## §21. Importer Design

`scripts/import_plan.py` should initially support Markdown.

## §21.1 MVP Strategy

Because fully automatic plan understanding is hard, use a hybrid approach:

```text
1. Deterministic parser extracts headings, links, code blocks, test names.
2. Agent pass proposes semantic mapping.
3. Human can review extracted YAML.
4. Graph builder consumes reviewed YAML.
```

## §21.2 Output

```yaml
id: plan:learn-basics-swe
title: Learn Basics SWE
directions: []
concepts: []
materials: []
material_parts: []
suggested_routes: []
probes: []
notes: []
```

---

