## §10. Graph Model

Generated graph file:

```json
{
  "version": 1,
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

`version` is the graph-file contract version: an integer the viewer checks before rendering (an unsupported version fails visibly, #44); it bumps only through a Decision Log entry.

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

The registry carries the field column for the region kinds (#33):

```text
concept        → knowledge
zone, pattern  → body
```

Field slugs are canonical here (§6: knowledge, the body), ordered by first appearance; §16.4's `field=` values and its default field come from this column, and a domain pass adds its rows under the same §6 rule. Every other kind's membership is computed per the §10.4 contract.

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
  "created_by": "plan-importer",
  "created_at": "2026-06-02"
}
```

`weight` is evidence-updatable (§14.9): an authored value (`concept_edges`, §9.3) is the import-time hypothesis; confirmed weight decisions (§9.13) override it; the fold emits the current value. `supports` edges (§9.14) are authored with no weight at all.

## §10.4 Per-kind Node Contract

One closed table (extended under §6's rule: a domain pass edits it in the same commit) defines, per node kind, how the builder derives `fields` — the node's field membership — and which curated fields are embedded in the node payload (#32, #33). §20 step 12 emits it; the §16 views render from it and nothing else.

Membership is a set: `fields` = the union of the fields (§10.1 column) of the region nodes reachable through the kind's listed refs. Chains bottom out at region kinds, so resolution is acyclic by construction; a cross-field material or route is a member of each field it touches.

```text
kind            | fields from                          | embedded beyond id/type/title/fields
----------------|--------------------------------------|-------------------------------------
concept         | registry (§10.1)                     | aliases
pattern         | registry (§10.1)                     | aliases
zone            | registry (§10.1)                     | notes (file body: care notes, §32.2)
material_part   | concept_edges targets                | material (parent id)
material        | overall_concepts ∪ its parts' fields | kind, url, status
suggested_route | steps                                | status, source_plan, sensitivity (§33.3)
direction       | core_concepts                        | status, attractor
question        | pulls                                | text, created_at, source
probe           | probed targets (concepts:)           | status, source_plan, body (the check, §9.11)
artifact        | touches ∪ supports_state_updates     | kind (authored type:, renamed — type is
                |                                      | §10.1's), path, observed_at, summary,
                |                                      | evidence_strength, probe
encounter       | its target's fields                  | date, target, depth, mode, context
trail_segment   | from ∪ to                            | date, direction, from, to, via, reason,
                |                                      | resulting_questions
plan            | its routes' fields (source_plan)     | —
personal_trail  | its segments' fields                 | direction
```

Rules:

```text
fields: [] is legal (no refs, or all dangling): the viewer renders
the node in the default field and flags "field undefined" — the
builder never substitutes a field it did not derive.
formerly (§34.4) is embedded on any curated node that carries it,
so a focus= URL holding a retired id still resolves.
sensitivity is embedded wherever it is persisted (§33.3 routes,
§33.2 journal rows); redacted agent-facing builds and withheld
counts are §32.6's (#38).
Derived values never enter the node payload: state, influence,
frontier, question status, depth_reached live in their own §10
keys (§31.8).
Relations are edges, not payload: related_concepts, parts, steps,
pulls, core_concepts, supported_by are already §10.2 edges and
are not duplicated as node fields.
Embedded free text and markdown travel verbatim as JSON strings.
Until the #37 threat model lands, the viewer renders them as
plain text (text nodes, no HTML or markdown interpretation); the
rendered form and its sanitization contract are #37's.
```

---

