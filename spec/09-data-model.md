## §9. Data Model

## §9.1 Concept

A **Concept** is a knowledge region.

Example:

```yaml
---
id: concept:idempotency
type: concept
title: Idempotency
updated: 2026-06-02
aliases:
  - idempotent operations
related_concepts:
  - concept:rest-api
  - concept:redis
  - concept:kafka-idempotent-consumer
  - concept:duplicate-side-effects
---
```

Concept files carry identity, links, and content only: understanding state is derived at build time from the `state/` journals (§8, §20) and moves only per §14; material roles live on contextual edges only (§11).

Body:

```markdown
# Idempotency

## Definition

## Why it matters

## Boundaries

## Subconcepts

## Common patterns

## Failure modes

## Materials

## Related concepts

## Current belief

## Open questions
```

Allowed concept states:

```yaml
state:
  exposure: unseen | touched | read | summarized | applied | taught
  confidence: unknown | low | medium | high
  clarity: vague | rough | stable | disputed
  coverage: none | partial | broad
  freshness: fresh | aging | stale
  last_seen: YYYY-MM-DD | null
```

---

## §9.2 Material

A **Material** is a source.

Example:

```yaml
---
id: material:fastapi-tutorial
type: material
title: FastAPI Official Tutorial
kind: docs
url: ""
status: active
overall_concepts:
  - concept:fastapi
  - concept:rest-api
parts: []
---
```

`overall_concepts` is the material's through-line (motif): what the material argues or teaches as a whole — not the union of its parts' concepts. It moves like any concept state: through synthesis artifacts spanning parts (a whole-material summary, a cross-part comparison) per §14.5 — never automatically from finishing parts (§14.8). A material may also list standing helpers of the whole via optional `supported_by:` (§9.14).

Material kinds:

```text
article
docs
paper
book
repo
video
course
spec
tutorial
internal
```

---

## §9.3 MaterialPart

A **MaterialPart** is a named sub-unit of a material — a section, chapter, timestamp range, module, or block. It is created when sub-units map to different concepts than the whole.

Example:

```yaml
parts:
  - id: part:fastapi-tutorial/path-operations
    title: Path Operations
    concept_edges:
      - to: concept:rest-api
        role: implements
        weight: high
      - to: concept:http-methods
        role: explains
        weight: medium

  - id: part:fastapi-tutorial/openapi
    title: OpenAPI
    concept_edges:
      - to: concept:openapi
        role: demonstrates
        weight: high
    supported_by:
      - material:openapi-spec
```

Rule:

```text
Create MaterialPart only when whole-material mapping would be misleading.
```

Standing helpers (`supported_by:`, shown above) are defined in §9.14.

---

## §9.4 SuggestedRoute

A **SuggestedRoute** is a path proposed by a plan.

Example:

```yaml
---
id: suggested-route:learn-basics-swe-default
type: suggested_route
source_plan: plan:learn-basics-swe
title: REST → Redis → Kafka → RabbitMQ → gRPC → E2E
status: available
steps:
  - concept:rest-api
  - concept:redis
  - concept:kafka
  - concept:rabbitmq
  - concept:grpc
  - concept:e2e-distributed-job-flow
---
```

SuggestedRoute states:

```text
available
hidden
partially_followed
ignored
archived
```

Not allowed:

```text
done
failed
late
blocked
```

---

## §9.5 Direction

A **Direction** is a stable vector of movement.

Example:

```yaml
---
id: direction:backend-distributed-systems-python
type: direction
title: Backend Distributed Systems in Python
status: active
attractor: >
  Understand how backend systems coordinate HTTP APIs,
  caches, event logs, task queues, RPC services, and integration tests.
core_concepts:
  - concept:rest-api
  - concept:redis
  - concept:kafka
  - concept:rabbitmq
  - concept:grpc
  - concept:integration-testing
---
```

A direction is not a route.
It is a compass.

---

## §9.6 Artifact

An **Artifact** is user-created evidence of movement.

Examples:

```text
test file
implementation
note
diagram
summary
review response
debug trace
commit
design doc
```

Schema:

```yaml
id: artifact:test-duplicate-post-idempotency
type: test
path: tests/test_rest.py
observed_at: 2026-06-05
summary: Duplicate POST with same idempotency key returns same job.
touches:
  - concept:rest-api
  - concept:idempotency
  - concept:redis-idempotency-key
supports_state_updates:
  - concept:rest-api
  - concept:idempotency
evidence_strength: applied
probe: probe:duplicate-post-idempotency   # optional: the probe this artifact answers (§9.11)
```

Artifact evidence strengths:

```text
noticed
read
summarized
applied
explained
reviewed
performed
drilled
```

`performed` and `drilled` are the body sessions' strengths (§32.3–§32.4): a session line evidences doing, a drill log deliberate practice. Every exposure/contact ladder maps this one list; each mapping lives beside its ladder (§14.5 knowledge, §32.2 zone contact, §32.3 motor).

An artifact answering a probe (§9.11) links it via `probe:`. The response is ordinary evidence — no verdict is stored; evaluation exists only as the fate of a proposal (§14.6).

---

## §9.7 Encounter

An **Encounter** is contact with a material or material part.

Example:

```yaml
id: encounter:2026-06-05-mdn-idempotency
date: 2026-06-05
target: part:mdn-http-methods/idempotency
depth: summarized
mode: plan-driven | question-driven | artifact-driven | background
context:
  question: question:post-idempotency
  artifact: artifact:test-duplicate-post-idempotency
```

Encounter depths:

```text
skim
read
summarized
applied
taught
```

Important:

```text
Encounter depth updates material state.
It may influence concept state.
It does not automatically imply concept mastery.
```

---

## §9.8 Question

A **Question** is an explicit pull in the map.

Example:

```yaml
id: question:201-vs-202
type: question
text: When should POST /jobs return 201 vs 202?
created_at: 2026-06-05
pulls:
  - concept:http-status-codes
  - concept:async-job-processing
  - concept:rest-api
source:
  artifact: artifact:create-job-endpoint
```

Question states:

```text
open
clarified
resolved
stale
```

No `done`.

A question is born `open`; the creation record — one line appended to `state/questions.jsonl` (§8) — never mutates. Status transitions are review-gated like the §14.6 dimensions: a StateDecision with `dimension: status` (§9.13), citing the evidence that makes the transition true — the artifact or encounter that resolved or clarified it; `stale` is a judgment too, citing the user's own note (nothing declines automatically, §31.5). The §20 fold derives current status: last confirmed decision, else `open`. Any transition can be proposed, `resolved → open` included — reopening is movement, not failure (§4).

---

## §9.9 PersonalTrail and TrailSegment

A **PersonalTrail** is the user’s actual movement.

A **TrailSegment** is one step.

Example:

```yaml
id: trail-segment:2026-06-05-001
type: trail_segment
date: 2026-06-05
direction: direction:backend-distributed-systems-python
from: concept:rest-api
to: concept:idempotency
via:
  - artifact:test-duplicate-post-idempotency
  - part:mdn-http-methods/idempotency
reason: >
  While implementing POST /jobs, duplicate requests forced
  the idempotency question.
resulting_questions:
  - question:where-store-idempotency-key
  - question:201-vs-202
```

`from` is the step's causal origin(s): a list of 0..n concepts, written as a scalar when there is one (the common case). Every listed origin must be evidenced by the segment's own context — co-touched in a `via` artifact as the work the movement grew out of, or the concept whose question the artifact answers (§13.2 step 9):

```text
absent  → a landing: movement into a concept with no evidenced origin
          (first contact, a side jump, a star-shaped day).
one     → a step that grew out of work on `from`.
several → a synthesis step (comparison note, design doc) that grew
          out of each listed origin.
```

Landing example:

```yaml
id: trail-segment:2026-06-07-002
type: trail_segment
date: 2026-06-07
direction: direction:backend-distributed-systems-python
to: concept:kafka
via:
  - artifact:note-kafka-conference-talk
reason: >
  Conference talk pulled attention to Kafka; no prior context.
```

Rule:

```text
A trail segment cannot fail.
It is not a commitment.
It is only a memory of actual movement.
Automation appends and proposes; only the user edits or deletes (§5.2).
`from` is never stitched to the latest trail head and never padded
with co-touched concepts: a fabricated edge is a false memory in the
sacred layer — worse than no `from` at all.
Topology is emergent: chains, forks, and stars are all normal shapes.
```

---

## §9.10 InfluenceField

The **InfluenceField** is computed from artifacts, encounters, questions, and trail segments — at build time, by the graph builder (§20). It exists only inside `graph/atlas-graph.json`; no `state/` file stores it (§31.8: derived is never stored).

Example (shape inside the derived graph output):

```yaml
concept:idempotency:
  influence:
    strength: strong
    freshness: fresh
    sources:
      - artifact:test-duplicate-post-idempotency
      - question:where-store-idempotency-key
      - trail-segment:2026-06-05-001

concept:redis-idempotency-key:
  influence:
    strength: weak
    freshness: fresh
    sources:
      - question:where-store-idempotency-key
```

Influence strength:

```text
none
weak
medium
strong
```

Influence does not mean mastery.

It means:

```text
“This area has been affected by real user movement.”
```

---

## §9.11 Probe

A **Probe** is a curated practice check that can reveal state (§6): understanding for knowledge, capacity for the body (§32.2). Probes live in `atlas/probes/` (§8): extracted at plan import (§12.2 step 7) or written by hand; lifecycle is editing the file, like all curated content.

Example:

```yaml
---
id: probe:duplicate-post-idempotency
type: probe
title: Duplicate POST with idempotency key
concepts:
  - concept:idempotency
  - concept:rest-api
source_plan: plan:learn-basics-swe
status: active
---
```

`source_plan` is optional (absent for hand-written probes); `status: active | archived` is lifecycle, as in §9.2. Body (Markdown): the check itself — task, scenario, “explain what happens and why”.

Deliberately absent: `expected:` / answer / rubric fields. A formalized correct answer is a drift vector toward grading (§25.4). The user’s answer to a probe is an Artifact linked via `probe:` (§9.6); its evaluation exists only as the fate of a proposal (§14.6).

---

## §9.12 Evidence

**Evidence** is a recorded trace that can justify a state update (§6). Exactly three record kinds are evidence:

```text
Artifact  (§9.6) — including notes and probe responses
Encounter (§9.7)
Question  (§9.8)
```

This list is canonical: §14.6, §25.3, and §31.5 cite it and must not re-enumerate it — a copy is a future fork (#8, #15).

Not evidence: trail segments (memory of movement, §9.9 — their `via` already points at evidence), plans and routes (§31.3), agent output. An agent review is a mechanism (propose→confirm, §14.6), not a record kind: the user’s review responses are artifacts; the verdict is the fate of the proposal, recorded as a StateDecision (§9.13).

---

## §9.13 StateDecision

A **StateDecision** is the resolution of a review-gated proposal (§14.6): the user confirmed or rejected it. One JSONL line appended to `state/decisions.jsonl` (§8):

```json
{"date": "2026-07-04", "target": "concept:idempotency", "dimension": "confidence", "to": "medium", "evidence": ["artifact:test-duplicate-post-idempotency", "question:where-store-idempotency-key"], "proposed_by": "state-auditor", "decision": "confirmed"}
```

Rules:

```text
dimension: confidence | clarity | coverage (concepts, §14.6)
           | weight (edges, §14.9) | status (questions, §9.8);
exposure needs no decision — it derives via §14.5.
target: a node id, or an edge designation
        <type>:<source>-><target> for weight decisions (§14.9),
        e.g. supports:part:b/y->part:a/x.
Only resolved proposals are recorded; a pending proposal is
derivable from evidence + current state and is never stored (§31.8).
evidence cites §9.12 records only and must be non-empty.
proposed_by: an agent role (§17) or user — a manual state edit
is a self-proposal citing a note artifact.
from is not stored — derivable.
A rejected decision is memory: the same proposal is not re-asked
without new evidence (§13.2 step 10).
decision: confirmed | rejected — the user’s judgment on a proposal,
not a task state (§4).
```

---

## §9.14 SupportRelation

A **SupportRelation** is a standing, directed link between materials or parts: the source deepens understanding of the target — “B helps understand X”. It is authored graph structure, the same species as `concept_edges` (§9.3), not a §11 role (§11.4).

Authored on the receiving side: `supported_by:` on a Material (§9.2) or inside a `parts[]` entry (§9.3). An entry is an id, or a map with an optional note:

```yaml
parts:
  - id: part:a/x
    title: X
    supported_by:
      - part:b/y
      - id: material:c
        note: Unpacks the motivation X assumes.
```

The builder derives one directed `supports` edge per entry (§10.2), help flowing source→target: `part:b/y → part:a/x`.

Rules:

```text
Endpoints are materials or parts, on either side.
Direction is real: a→b and b→a coexist as two independent records
in two files, each with its own weight — help(A→B) ≠ help(B→A).
A symmetric “mutual support” relation is forbidden; cycles are
normal.
Weight is never authored: a new link is unassessed until weight
decisions pass the review gate (§14.6, §14.9). Import creates
existence only (§12.2 step 6) — help depth is learned from
evidence, never declared.
Angle = part: when help targets a facet, author the edge from/to
the part — the §9.3 misleading-mapping rule applies to endpoints.
No required contact depth is ever stored: the viewer joins the
edge with the endpoints’ own state (§14.8) at render time;
sufficiency is the user’s judgment, never a gate.
A support link carries no primacy: it never makes a material
globally primary/supporting (§11.4, §31.4).
Removal is a file edit; past weight decisions stay in the journal
as audit (§25.3).
```

---

