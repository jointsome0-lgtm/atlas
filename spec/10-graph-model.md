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
  "frontier": [],
  "projections": {}
}
```

`projections` is curated viewer-projection content the builder embeds (zone → figure region, §32; §20 step 12) so the viewer's single input stays single (§16.4) — a mapping, never state (§31.8).

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
zone
pattern
```

Node ids follow `prefix:kebab-case-slug`, where the prefix is the hyphenated type name (`suggested-route:…`, `trail-segment:…`) or its short form (`part:material-slug/part-slug` for material_part). Underscores appear in type names only, never in ids. Id lifecycle — retirement into `formerly:` (§34.4), the reuse ban, and non-descriptive date-serial ids for §32.6-classed records (§34.6) — is §34's.

`zone` and `pattern` are the body field's region kinds (§32.1). The list is canonical and closed — §19 scans node types as a closed set, §20 step 11 validates against it; the extension rule is §6's: a domain pass registers its kinds here in the same commit.

## §10.2 Edge Types

```text
related_to
prerequisite_of
extends
implements
contradicts
explains
demonstrates
critiques
mentions
loads
has_part
overall_concept
supports
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

`demonstrates` is a `concept_edges` role already in use (§9.3); `loads` is the body field's pattern→zone role (§32.1) — the same authored species, weight-gated (§14.9). This list is closed like §10.1's, under the same §6 rule.

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

`weight` is evidence-updatable (§14.9): an authored value (`concept_edges`, §9.3) is the import-time hypothesis; confirmed weight decisions (§9.13) override it; the fold emits the current value. `supports` edges (§9.14) are authored with no weight at all.

---

