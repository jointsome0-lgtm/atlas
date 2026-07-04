## §10. Graph Model

Generated graph file:

```json
{
  "generated_at": "2026-06-02T00:00:00Z",
  "nodes": [],
  "edges": [],
  "trails": [],
  "state": {},
  "influence": {},
  "frontier": []
}
```

## §10.1 Node Types

```text
plan
concept
material
material_part
direction
suggested_route
personal_trail
trail_segment
artifact
encounter
question
probe
```

Node ids follow `prefix:kebab-case-slug`, where the prefix is the hyphenated type name (`suggested-route:…`, `trail-segment:…`) or its short form (`part:material-slug/section-slug` for material_part). Underscores appear in type names only, never in ids.

## §10.2 Edge Types

```text
related_to
prerequisite_of
extends
implements
contradicts
explains
critiques
mentions
has_part
overall_concept
part_of_direction
step_of_route
suggested_next
visited
moved_to
via
pulled_by
produced_artifact
updates_state
influences
probed_by
primary_for
supporting_for
```

## §10.3 Edge Metadata

Edges should support metadata:

```json
{
  "source": "part:mdn-http-methods/idempotency",
  "target": "concept:idempotency",
  "type": "explains",
  "weight": "high",
  "context": "suggested-route:learn-basics-swe-default",
  "confidence": "medium",
  "created_by": "plan_importer",
  "created_at": "2026-06-02"
}
```

---

