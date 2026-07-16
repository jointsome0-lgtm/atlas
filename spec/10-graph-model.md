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

`generated_at` is the fold's as-of date rendered at UTC midnight (§20.1) — the same shape as the snapshot's (§33.4); it is absent in a build with no dated input, and a consumer must tolerate its absence.

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

This list is closed like §10.1's, under the same §6 rule. The matrix below is the normative endpoint/ownership contract per type (#31): the builder's endpoint constants transcribe it and cite it, never the reverse. `part` abbreviates `material_part`; `concept, pattern` is the concept-kind pair (§32.1: patterns are concept-kind nodes).

```text
type              | source kinds           | target kinds           | ownership — authored surface / derived from
------------------|------------------------|------------------------|--------------------------------------------
related_to        | concept, pattern       | concept, pattern       | authored: concept_edges (§9.1, §32.1) or related_concepts sugar (§9.1)
prerequisite_of   | concept, part, pattern | concept, pattern       | authored: concept_edges (§9.1, §9.3, §32.1)
extends           | concept, part, pattern | concept, pattern       | authored: concept_edges (§9.1, §9.3, §32.1)
contradicts       | concept, part, pattern | concept, pattern       | authored: concept_edges (§9.1, §9.3, §32.1)
implements        | part                   | concept, pattern       | authored: concept_edges (§9.3)
explains          | part                   | concept, pattern       | authored: concept_edges (§9.3)
demonstrates      | part                   | concept, pattern       | authored: concept_edges (§9.3)
critiques         | part                   | concept, pattern       | authored: concept_edges (§9.3)
mentions          | part                   | concept, pattern       | authored: concept_edges (§9.3)
loads             | pattern                | zone                   | authored: concept_edges in the pattern (§32.1)
supports          | material, part         | material, part         | authored: supported_by on the receiver (§9.14)
has_part          | material               | part                   | derived: parts[] (§9.3)
overall_concept   | material               | concept, pattern       | derived: overall_concepts (§9.2)
part_of_direction | concept, pattern       | direction              | derived: core_concepts (§9.5)
step_of_route     | concept, pattern       | suggested_route        | derived: steps (§9.4); meta: order
suggested_next    | concept, pattern       | concept, pattern       | derived: consecutive steps of one route (§9.4); meta: context = route id
probed_by         | concept, pattern, zone | probe                  | derived: the probe's concepts: (§9.11)
pulled_by         | concept, pattern, zone | question               | derived: the question's pulls (§9.8)
visited           | encounter              | material, part         | derived: the encounter's target (§9.7)
influences        | artifact               | concept, pattern, zone | derived: the artifact's touches (§9.6)
updates_state     | artifact               | concept, pattern, zone | derived: supports_state_updates (§9.6)
moved_to          | concept, pattern       | concept, pattern       | derived: one edge per segment from-origin → to (§9.9)
via               | trail_segment          | material, part         | derived: material(part) entries of via (§9.9)
produced_artifact | trail_segment          | artifact               | derived: artifact entries of via (§9.9)
primary_for       | material, part         | suggested_route, question, trail_segment | authored for route contexts (material_roles, §9.4/§11.1; meta: step); derived for question/trail contexts (§11.2–§11.3)
supporting_for    | material, part         | suggested_route, question, trail_segment | same as primary_for
```

Rules:

```text
Direction is real, and a→b / b→a coexist as independent edges for
every type except related_to — the one symmetric type: the
builder canonicalizes it (endpoints sorted lexicographically), so
two-sided authoring collapses into one edge with provenance union
(§20.3).
Identity = (type, source, target) plus the row's meta
discriminant (order / context / step) where listed. Duplicates of
one identity collapse into one edge; conflicting authored weights
on one identity are a build ERROR (§20.3).
Weight exists on the authored species only, per the §14.9 chain
(decision, else authored hypothesis, else unassessed); supports
is authored with no weight at all (§9.14); derived edges never
carry weight.
Cycles: a prerequisite_of cycle is a build-report WARNING —
surfaced, never a build failure and never a dependency alarm
(§15.3, §25.4); supports cycles are normal (§9.14); no other
type is checked — trail topology is emergent (§9.9) and mutual
contradicts is a real shape.
influences names the record-level trace an artifact leaves on a
region; the aggregated influence field stays a top-level derived
key (§9.10), never edge data.
Per-author role sets, read off the source column: a part (§9.3)
authors the material-voice roles (implements, explains,
demonstrates, critiques, mentions) plus prerequisite_of, extends,
contradicts; a concept (§9.1) authors the concept-voice four
(related_to, prerequisite_of, extends, contradicts); a pattern
(§32.1) authors the concept-voice four — it is a concept-kind
node, not a readable source — plus loads.
```

## §10.3 Edge Metadata

Edges should support metadata:

```json
{
  "source": "part:mdn-http-methods/idempotency",
  "target": "concept:idempotency",
  "type": "explains",
  "weight": "high",
  "provenance": ["part:mdn-http-methods/idempotency"],
  "confidence": "medium",
  "created_by": "plan-importer",
  "created_at": "2026-06-02"
}
```

`weight` is evidence-updatable (§14.9): an authored value (`concept_edges`, §9.3) is the import-time hypothesis; confirmed weight decisions (§9.13) override it; the fold emits the current value. `supports` edges (§9.14) are authored with no weight at all.

Requiredness (#31):

```text
Required on every edge: source, target, type, provenance — the
complete direct derivation basis: every authoring node id or
deriving record/route id the edge rests on (a joined derivation
like §11.3's lists the segment and the encounter both — the
§32.6 sensitivity union reads this list), non-empty, unioned
when duplicates collapse, sorted (§20.3).
Required per the §10.2 matrix: weight on the authored species
(the §14.9 fold value; unassessed is legal), order on
step_of_route, context on suggested_next, step on route-context
primary_for/supporting_for — the meta discriminants are part of
edge identity.
Everything else (created_by, created_at, confidence, the §9.14
note) is optional annotation.
```

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
plan            | its routes' fields (source_plan)     | sensitivity (§33.3, §9.15)
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
Relations are edges, not payload: related_concepts,
concept_edges, parts, steps, material_roles, pulls,
core_concepts, supported_by are already §10.2 edges and are not
duplicated as node fields. Journal-backed kinds are the one
designed exception: the table embeds their record fields (a
segment's from/to/via, an encounter's target — the detail panel
shows the record, §25.3) while the builder also derives typed
edges from the same row (§10.2 matrix) — one row, one build,
both faces; the two cannot fork.
Embedded free text and markdown travel verbatim as JSON strings.
Until the #37 threat model lands, the viewer renders them as
plain text (text nodes, no HTML or markdown interpretation); the
rendered form and its sanitization contract are #37's.
```

---

