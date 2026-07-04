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

A **MaterialPart** is created when a material has sections that map to different concepts.

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
```

Rule:

```text
Create MaterialPart only when whole-material mapping would be misleading.
```

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
```

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
status: open
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

Rule:

```text
A trail segment cannot fail.
It is not a commitment.
It is only a memory of actual movement.
Automation appends and proposes; only the user edits or deletes (§5.2).
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

A **Probe** is a curated practice check that can reveal understanding (§6). Probes live in `atlas/probes/` (§8): extracted at plan import (§12.2 step 7) or written by hand; lifecycle is editing the file, like all curated content.

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
dimension: confidence | clarity | coverage (§14.6);
exposure needs no decision — it derives via §14.5.
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

