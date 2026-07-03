# System Design Document: Atlas

**Version:** 0.1
**Status:** Draft
**Project:** Atlas — graph-first personal knowledge-state system
**Primary goal:** Extract proposed learning routes from plans, but preserve and visualize the user’s real personal trail, knowledge state, and influence field over time.

---

## 1. Executive Summary

**Atlas** is a local-first system for building a living knowledge graph of a technical field and the user’s movement through it.

It imports external learning plans as **suggested routes**, extracts **concepts**, **materials**, **material parts**, **practice probes**, and **directions**, but does not treat any route as mandatory.

The system then observes the user’s actual artifacts — notes, tests, code, diagrams, explanations, reviews — and uses them to update:

```text
1. FieldGraph        — what exists in the domain
2. MaterialGraph     — which materials explain which concepts
3. StateGraph        — what the user currently understands
4. PersonalTrail     — where the user actually moved
5. InfluenceField    — which parts of the map are now affected by the user’s artifacts
6. Frontier          — nearby concepts/questions/materials naturally adjacent to current movement
```

Core principle:

```text
Suggested routes are maps.
Personal trail is memory.
Influence field is understanding becoming visible.
```

Atlas must never become a TODO system, productivity ledger, sprint board, or guilt machine.

---

## 2. Problem Statement

Learning plans are useful, but they usually produce pressure:

```text
“Here is the path. Follow it.”
```

The user’s actual learning is not linear. A proposed route might say:

```text
REST → Redis → Kafka → RabbitMQ → gRPC
```

But the user’s real trail might become:

```text
REST → idempotency → HTTP status semantics → Redis idempotency keys → Kafka duplicate event handling
```

Both are valuable, but they are different things.

Atlas solves this by separating:

```text
SuggestedRoute  = path proposed by a plan
PersonalTrail   = path actually traversed by the user
InfluenceField  = area affected by user artifacts
StateGraph      = current understanding state
```

The uploaded learning plan is a good example: it proposes building around a `distributed-systems-python-lab` repo with FastAPI REST, Redis, Kafka, RabbitMQ, gRPC, tests, and an E2E job flow; it also proposes routes and concrete probes/tests such as idempotency, Kafka offset safety, gRPC timeout handling, RabbitMQ DLQ behavior, and rate limiting. 

---

## 3. Goals

### 3.1 Product Goals

Atlas should:

1. Import learning plans and convert them into graph structures.
2. Extract concepts, materials, sections/aspects, probes, and suggested routes.
3. Track user-created artifacts over time.
4. Update knowledge state only from meaningful evidence.
5. Preserve the user’s real personal trail.
6. Visualize the difference between proposed paths and actual movement.
7. Show the user’s current frontier without creating obligations.
8. Support agent-based analysis, review, and graph maintenance.
9. Keep all data local, versionable, inspectable, and editable.

### 3.2 Cognitive Goals

Atlas should help the user feel:

```text
“I can see where I am.”
“I can see where I have been.”
“I can see nearby territory.”
“I can ignore proposed paths without losing my own trail.”
```

Atlas must not create:

```text
“I am behind.”
“I failed the plan.”
“I did not complete the route.”
“I must finish this before moving.”
```

---

## 4. Non-Goals

Atlas is not:

```text
task manager
curriculum tracker
kanban board
sprint system
product roadmap
job-search tracker
portfolio tracker
habit tracker
spaced-repetition app
course platform
```

Atlas must not use these as core states:

```text
todo
in_progress
done
blocked
deadline
ticket
sprint
```

Atlas may show **state of understanding**, but never **task completion pressure**.

---

## 5. Core Principles

## 5.1 Suggested Routes Are Optional

A route extracted from a plan is only a proposed path through the field.

It may be:

```text
followed
partially followed
ignored
hidden
forgotten
revisited
split
merged
contradicted
```

Importing a route does not imply commitment.

## 5.2 Personal Trail Is Sacred

The user’s actual trail must not be overwritten by proposed routes.

A trail is generated from:

```text
artifacts
encounters
questions
notes
tests
code
diagrams
reviews
explanations
decisions
```

A trail cannot fail. It is historical memory.

## 5.3 Understanding Is Not Imported

Importing a plan creates candidate graph structure.

It does not update user understanding.

For example:

```text
Plan mentions Kafka offsets.
```

This creates:

```yaml
concept:kafka-offsets
state:
  exposure: unseen
  confidence: unknown
  clarity: vague
```

Only user artifacts can update that state.

## 5.4 Materials Are Not Concepts

A material is a source.
A concept is an area of knowledge.

One material can touch many concepts.
One concept can be supported by many materials.
One section of a material can be useful for a different concept than the material’s overall topic.

## 5.5 Primary/Supporting Are Contextual Roles

A material is not globally primary or supporting.

It can be primary in one context and supporting in another.

Correct:

```text
material X is primary for route step Y
material X is supporting for question Z
material X is primary for trail segment W
```

Incorrect:

```text
material X is primary forever
```

---

## 6. Core Ontology

```text
Field          = knowledge space
Direction      = stable vector of movement
Concept        = region of the field
Material       = canonical source
MaterialPart   = section/aspect of a material
Encounter      = contact with a material or material part
Artifact       = user-created trace: code, note, test, diagram, explanation
Probe          = practice check that can reveal understanding
Question       = explicit uncertainty or pull
SuggestedRoute = route proposed by a plan
PersonalTrail  = actual movement through the field
TrailSegment   = one movement step in the personal trail
InfluenceField = area affected by user artifacts
State          = current understanding state
Frontier       = nearby territory naturally suggested by current state
```

---

## 7. High-Level Architecture

```text
                   ┌────────────────────┐
                   │ Learning Plan Input │
                   └─────────┬──────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Plan Importer   │
                    └───────┬─────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐    ┌────────────────┐    ┌────────────────┐
│ Concepts     │    │ Materials      │    │ SuggestedRoutes │
└──────┬───────┘    └───────┬────────┘    └───────┬────────┘
       │                    │                     │
       └────────────┬───────┴─────────────┬───────┘
                    ▼                     ▼
             ┌──────────────┐      ┌───────────────┐
             │ FieldGraph   │      │ MaterialGraph │
             └──────┬───────┘      └───────┬───────┘
                    │                      │
                    ▼                      ▼
              ┌─────────────────────────────────┐
              │ Graph Builder                   │
              └───────────────┬─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ atlas-graph.json │
                     └────────┬────────┘
                              │
                              ▼
                         ┌────────┐
                         │ Viewer │
                         └────────┘


User artifacts / notes / code / tests
                │
                ▼
       ┌───────────────────┐
       │ Artifact Observer │
       └─────────┬─────────┘
                 ▼
       ┌───────────────────┐
       │ State Updater     │
       └───────┬───────────┘
               ▼
   ┌─────────────────────────────┐
   │ StateGraph + PersonalTrail  │
   └────────────┬────────────────┘
                ▼
        ┌───────────────┐
        │ InfluenceField │
        └───────┬───────┘
                ▼
          ┌──────────┐
          │ Frontier │
          └──────────┘
```

---

## 8. Repository Layout

```text
atlas/
  README.md
  CLAUDE.md
  AGENTS.md

  docs/
    SDD.md
    ATLAS_SYSTEM.md
    GRAPH_MODEL.md
    STATE_MODEL.md
    TRAJECTORY_MODEL.md
    PLAN_IMPORT_MODEL.md
    MATERIAL_MODEL.md
    INFLUENCE_MODEL.md
    FRONTIER_MODEL.md
    TEAM_OPERATING_SYSTEM.md
    CODEX_PROTOCOL.md
    adr/
      0001-atlas-ontology.md
      0002-graph-first-atlas.md
      0003-suggested-routes-vs-personal-trail.md
      0004-contextual-primary-supporting.md

  atlas/
    concepts/
      rest-api.md
      redis.md
      kafka.md
      rabbitmq.md
      grpc.md
      idempotency.md
      observability.md
      evals.md

    materials/
      _template.md
      mdn-http-methods.md
      fastapi-tutorial.md
      redis-py-guide.md
      apache-kafka-quickstart.md
      rabbitmq-python-tutorial.md
      grpc-python-quickstart.md

    directions/
      backend-distributed-systems-python.md
      harness-engineering.md
      agent-reliability.md

    suggested-routes/
      learn-basics-swe-default.md
      learn-basics-swe-roi.md

    trajectories/
      _template.md
      2026-06-02-seed.md

    probes/
      duplicate-post-idempotency.md
      kafka-offset-commit-safety.md
      grpc-timeout-failure.md
      rabbitmq-dlq.md
      redis-rate-limit.md

  plans/
    imported/
      learn-basics-swe.md
    extracted/
      learn-basics-swe.yaml

  state/
    current-position.yaml
    concept-state.yaml
    material-state.yaml
    open-questions.yaml
    influence-field.yaml

  graph/
    schema.yaml
    atlas-graph.json
    build_graph.py

  viewer/
    index.html
    app.js
    styles.css

  scripts/
    import_plan.py
    observe_artifacts.py
    build_atlas_graph.py
    check_atlas_boundaries.py
    validate_atlas.py
```

---

## 9. Data Model

## 9.1 Concept

A **Concept** is a knowledge region.

Example:

```yaml
---
id: concept:idempotency
type: concept
title: Idempotency
status: rough
stability: medium
updated: 2026-06-02
aliases:
  - idempotent operations
related_concepts:
  - concept:rest-api
  - concept:redis
  - concept:kafka-idempotent-consumer
  - concept:duplicate-side-effects
material_roles: []
---
```

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

## 9.2 Material

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

## 9.3 MaterialPart

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

## 9.4 SuggestedRoute

A **SuggestedRoute** is a path proposed by a plan.

Example:

```yaml
---
id: suggested-route:learn-basics-swe-default
type: suggested_route
source_plan: plan:learn-basics-swe
title: REST → Redis → Kafka → RabbitMQ → gRPC → E2E
pressure: none
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

## 9.5 Direction

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

## 9.6 Artifact

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

---

## 9.7 Encounter

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

## 9.8 Question

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

## 9.9 PersonalTrail and TrailSegment

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
```

---

## 9.10 InfluenceField

The **InfluenceField** is computed from artifacts, encounters, questions, and trail segments.

Example:

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

## 10. Graph Model

Generated graph file:

```json
{
  "generated_at": "2026-06-02T00:00:00Z",
  "nodes": [],
  "edges": [],
  "trajectories": [],
  "state": {},
  "influence": {},
  "frontier": []
}
```

## 10.1 Node Types

```text
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
snapshot
```

## 10.2 Edge Types

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

## 10.3 Edge Metadata

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

## 11. Primary and Supporting Materials

`primary` and `supporting` are contextual edge roles.

## 11.1 Route Context

```yaml
context: suggested-route:learn-basics-swe-default
step: concept:rest-api
primary_materials:
  - material:mdn-http-methods
  - material:fastapi-tutorial
supporting_materials:
  - material:openapi-spec
```

## 11.2 Question Context

```yaml
context: question:201-vs-202
primary_materials:
  - material:mdn-http-status-codes
supporting_materials:
  - material:rest-api-guidelines
reason: Needed to resolve async creation response semantics.
```

## 11.3 Trail Context

```yaml
context: trail-segment:2026-06-05-001
primary_materials:
  - part:mdn-http-methods/idempotency
supporting_materials:
  - material:redis-idempotency-patterns
```

Rule:

```text
A material’s role changes by context.
The graph must never store global primary/supporting flags on Material itself.
```

---

## 12. Plan Import Flow

## 12.1 Input

Supported initial input:

```text
Markdown learning plan
```

Future inputs:

```text
PDF
webpage
Notion/Google Docs export
course syllabus
repo README
chat transcript
```

## 12.2 Import Steps

```text
1. Store original plan under plans/imported/.
2. Parse headings, lists, code blocks, links, and test names.
3. Extract candidate directions.
4. Extract candidate concepts.
5. Extract materials and URLs.
6. Detect material roles if the plan implies them.
7. Extract practice probes/tests.
8. Extract proposed sequence as SuggestedRoute.
9. Create candidate graph.
10. Mark all understanding state as unseen/unknown unless prior artifacts exist.
11. Generate import report.
```

## 12.3 Example from Uploaded Plan

The uploaded plan would create a direction like:

```yaml
direction:backend-distributed-systems-python
```

It would create suggested routes such as:

```text
REST → Redis → Kafka → RabbitMQ → gRPC → E2E
REST → Redis → Kafka → gRPC → RabbitMQ
```

It would create concepts including:

```text
REST API
FastAPI
HTTP methods
HTTP status codes
idempotency
pagination
OpenAPI
Redis
cache-aside
TTL
rate limiting
Redis Streams
Kafka
topics
partitions
offsets
consumer groups
at-least-once delivery
idempotent consumer
RabbitMQ
exchange
queue
ack/nack
DLQ
prefetch
gRPC
Protocol Buffers
deadlines
interceptors
integration testing
E2E job flow
```

It would create probes such as:

```text
duplicate POST idempotency
Kafka offset commit safety
gRPC timeout failure
RabbitMQ DLQ behavior
Redis rate limiting
```

The plan describes these ideas around a single integrated Python lab using FastAPI, Redis, Kafka, RabbitMQ, gRPC, pytest/Testcontainers, and E2E job-flow tests. 

---

## 13. Artifact Observation Flow

## 13.1 Inputs

The observer scans:

```text
notes/
atlas/
tests/
src/
app/
docs/
commits
diffs
review comments
diagrams
manual declarations
```

## 13.2 Observation Steps

```text
1. Detect changed or new user artifacts.
2. Classify artifact type.
3. Extract touched concepts.
4. Link artifact to materials if references exist.
5. Link artifact to probes if matching.
6. Propose state updates.
7. Propose trail segments.
8. Propose influence updates.
9. Ask for review only when update is ambiguous or high-impact.
```

## 13.3 Example

If user creates:

```text
tests/test_rest.py::test_duplicate_idempotency_key_returns_same_job
```

Atlas may infer:

```yaml
artifact:
  touches:
    - concept:rest-api
    - concept:idempotency
    - concept:duplicate-side-effects
    - concept:redis-idempotency-key

state_update:
  concept:rest-api:
    exposure: applied
    clarity: rough
  concept:idempotency:
    exposure: applied
    clarity: rough

trail_segment:
  from: concept:rest-api
  to: concept:idempotency
  via:
    - artifact:test_duplicate_idempotency_key
```

It should not infer:

```text
Redis mastered.
REST done.
Kafka next required.
```

---

## 14. State Update Rules

## 14.1 Concept Exposure

```text
unseen      = exists in graph, no user contact
touched     = mentioned, noticed, lightly connected
read        = user read material connected to concept
summarized  = user wrote own summary or explanation
applied     = user created artifact applying concept
taught      = user explained concept and survived review
```

## 14.2 Confidence

```text
unknown = no signal
low     = fragile understanding or unresolved questions
medium  = can use with some support
high    = can explain/apply reliably across contexts
```

## 14.3 Clarity

```text
vague    = term exists but boundaries unclear
rough    = basic model exists
stable   = model is coherent
disputed = conflicting sources or unresolved definition
```

## 14.4 Coverage

```text
none
partial
broad
```

Coverage must be separated from depth.

Example:

```text
Kafka can be applied for producer/consumer,
but offsets and consumer groups may remain partial.
```

---

## 15. Frontier Computation

The **Frontier** is not a TODO list.

It is the visible edge of the current influence field.

## 15.1 Inputs

```text
current position
influence field
open questions
suggested routes
concept graph neighbors
material gaps
stale nodes
weak confidence nodes
```

## 15.2 Output

Example:

```yaml
frontier:
  - id: frontier:redis-idempotency-key
    kind: adjacent_concept
    concept: concept:redis-idempotency-key
    reason: REST idempotency artifact raised storage question.
    pressure: none

  - id: frontier:201-vs-202
    kind: open_question
    question: question:201-vs-202
    reason: Async job creation response semantics unclear.
    pressure: none

  - id: frontier:kafka-duplicate-event
    kind: future_consequence
    concept: concept:kafka-idempotent-consumer
    reason: Duplicate request handling may later reappear as duplicate event handling.
    pressure: none
```

Forbidden frontier wording:

```text
next task
must do
overdue
blocked
remaining
```

Allowed frontier wording:

```text
nearby
adjacent
naturally connected
open
available
possible
```

---

## 16. Viewer Design

## 16.1 Viewer Modes

The viewer should support at least:

```text
Field View
Material View
Suggested Route View
Personal Trail View
Influence Field View
State View
Frontier View
Question View
```

## 16.2 Visual Semantics

Suggested routes:

```text
thin gray lines
optional
hideable
```

Personal trail:

```text
bright line
chronological
persistent
```

Influence field:

```text
soft halo around affected concepts
strength shown by opacity/size
```

State:

```text
node border or badge
confidence/clarity/exposure visible
```

Questions:

```text
pulsing or highlighted nodes
pulling nearby concepts
```

## 16.3 Required UI Behavior

The viewer should let the user answer:

```text
What did the plan suggest?
Where did I actually go?
What concepts have I touched?
What artifacts affected this area?
Which materials are connected to this concept?
Which sections of this material matter?
What questions are pulling me now?
What is nearby but not obligatory?
```

---

## 17. Agent Architecture

## 17.1 Core Agents

```text
atlas-architect
  Owns ontology and conceptual consistency.

plan-importer
  Extracts directions, routes, concepts, materials, probes.

field-cartographer
  Maintains concept graph and area boundaries.

material-analyst
  Maps materials and material parts to concepts.

artifact-observer
  Scans user artifacts and proposes state/trail updates.

state-auditor
  Prevents overclaiming understanding.

graph-engineer
  Owns graph schema, builder, validation.

viewer-engineer
  Owns static viewer and graph interaction.

red-team-reviewer
  Attacks task-manager drift, pressure leakage, overengineering.

codex-coordinator
  Uses Codex only for checkpoint review/rescue.
```

## 17.2 Agent Rules

Agents may:

```text
extract
classify
suggest
link
summarize
flag gaps
propose state updates
```

Agents must not:

```text
claim the user understands something without artifacts
turn routes into obligations
create todo/done statuses
invent user trail segments
hide uncertainty
upgrade confidence without reason
```

---

## 18. Codex Role

Codex is not a permanent teammate.

Codex roles:

```text
reviewer
adversarial reviewer
rescue worker
second-opinion architect
```

Codex checkpoints:

```text
after graph schema design
after plan importer design
after state update rules
after viewer MVP
before major refactor
```

Codex should challenge:

```text
Is Atlas becoming a task manager?
Are state updates overclaiming?
Are suggested routes too pressure-like?
Is primary/supporting modeled incorrectly?
Is the graph too complex to maintain?
```

---

## 19. Boundary Checker

`scripts/check_atlas_boundaries.py` should fail on forbidden project/task-manager language outside explicit forbidden-term sections.

Forbidden terms:

```text
todo
in_progress
done
blocked
deadline
sprint
ticket
target_repo
must finish
overdue
task board
productivity ledger
```

Allowed only when documented as forbidden.

The checker should scan:

```text
README.md
CLAUDE.md
AGENTS.md
docs/
atlas/
state/
graph/
```

---

## 20. Graph Builder

`scripts/build_atlas_graph.py` should:

```text
1. Read concept frontmatter.
2. Read material frontmatter.
3. Expand MaterialPart nodes.
4. Read direction files.
5. Read suggested routes.
6. Read trajectories.
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

## 21. Importer Design

`scripts/import_plan.py` should initially support Markdown.

## 21.1 MVP Strategy

Because fully automatic plan understanding is hard, use a hybrid approach:

```text
1. Deterministic parser extracts headings, links, code blocks, test names.
2. Agent pass proposes semantic mapping.
3. Human can review extracted YAML.
4. Graph builder consumes reviewed YAML.
```

## 21.2 Output

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

## 22. Example: Uploaded Plan as Atlas Data

The uploaded plan becomes:

```yaml
plan:
  id: plan:learn-basics-swe
  title: Backend distributed systems practice in Python

directions:
  - direction:backend-distributed-systems-python

suggested_routes:
  - suggested-route:learn-basics-swe-default
  - suggested-route:learn-basics-swe-roi

concepts:
  - concept:rest-api
  - concept:fastapi
  - concept:redis
  - concept:kafka
  - concept:rabbitmq
  - concept:grpc
  - concept:idempotency
  - concept:rate-limiting
  - concept:kafka-offsets
  - concept:rabbitmq-dlq
  - concept:grpc-deadlines
  - concept:e2e-distributed-job-flow

probes:
  - probe:duplicate-post-idempotency
  - probe:kafka-offset-commit-safety
  - probe:grpc-timeout-failure
  - probe:rabbitmq-dlq
  - probe:redis-rate-limit
```

Initial state:

```yaml
concept:rest-api:
  exposure: unseen
  confidence: unknown
  clarity: vague

concept:kafka-offsets:
  exposure: unseen
  confidence: unknown
  clarity: vague
```

Nothing becomes understood just because the plan was imported.

---

## 23. Progression Model

The user progresses by movement, not by completion.

## 23.1 Normal Loop

```text
1. Import a plan.
2. Atlas builds suggested routes and candidate field graph.
3. User chooses any interesting concept, question, material, or artifact.
4. User creates a small artifact.
5. Agents classify the artifact.
6. Atlas updates StateGraph.
7. Atlas records PersonalTrail.
8. Atlas expands InfluenceField.
9. Atlas shows Frontier.
```

## 23.2 Example

Plan suggests:

```text
REST → Redis → Kafka → RabbitMQ → gRPC
```

User starts with REST and writes an idempotency test.

Atlas records:

```text
PersonalTrail:
REST API → Idempotency
```

Influence expands to:

```text
HTTP methods
POST semantics
Redis idempotency key
duplicate side effects
Kafka duplicate event handling
```

Frontier shows:

```text
Redis idempotency key
201 vs 202
409 vs 422
OpenAPI idempotency header
Kafka idempotent consumer
```

None of these are tasks.

They are nearby territory.

---

## 24. Security and Privacy

Atlas is local-first.

MVP should not:

```text
send files to remote services automatically
read secrets
scan .env
push to remote
modify production resources
store credentials
```

Ignore paths:

```text
.env
.env.*
secrets/
node_modules/
.venv/
dist/
build/
.git/
```

---

## 25. Non-Functional Requirements

## 25.1 Local-First

All primary data lives in the repo.

## 25.2 Versionable

All graph state should be plain text or JSON:

```text
Markdown
YAML
JSON
```

## 25.3 Auditable

Every state update should be traceable to:

```text
artifact
encounter
question
manual note
agent review
```

## 25.4 Low Pressure

No dashboards should imply lateness, failure, or incompletion.

## 25.5 Extensible

The system should later support:

```text
multiple learning plans
multiple domains
source annotations
spaced revisits
artifact embeddings
better visualization
external connectors
```

---

## 26. MVP Scope

## 26.1 MVP Must Have

```text
manual/assisted plan import
concept files
material files
material parts
suggested routes
state YAML
trajectory template
influence field YAML
graph builder
graph JSON
static viewer
boundary checker
one imported example plan
```

## 26.2 MVP Can Skip

```text
full automatic material scraping
semantic embeddings
large interactive UI
multi-user support
cloud sync
database
auth
complex analytics
automatic confidence upgrades
```

---

## 27. Acceptance Criteria

The MVP is acceptable when:

1. The uploaded learning plan can be represented as a plan node, direction, suggested routes, concepts, materials, probes, and initial state.
2. Suggested routes are visible but clearly optional.
3. A user artifact can create or update a trail segment.
4. State updates are separate from route import.
5. Influence field can show affected concepts.
6. Frontier can show nearby concepts/questions without TODO wording.
7. Graph JSON builds successfully.
8. Viewer can show at least concepts, routes, trail, and state.
9. Boundary checker rejects TODO/done/project-management leakage.
10. The SDD and ADRs clearly preserve the distinction:

```text
suggested route ≠ personal trail ≠ understanding state
```

---

## 28. Risks and Mitigations

## 28.1 Risk: Atlas Becomes a Task Manager

Mitigation:

```text
ban todo/done states
use optional suggested routes
use frontier language
boundary checker
red-team reviewer
```

## 28.2 Risk: Agents Overclaim Understanding

Mitigation:

```text
state updates require artifacts
confidence upgrades require explanation/review
state-auditor agent checks claims
```

## 28.3 Risk: Graph Becomes Unmaintainable

Mitigation:

```text
create MaterialPart only when needed
allow rough/stub concepts
avoid exhaustive linking
generated views from simple files
```

## 28.4 Risk: Suggested Routes Dominate Personal Trail

Mitigation:

```text
different visual layers
suggested routes hideable
personal trail rendered as primary memory
```

## 28.5 Risk: Primary/Supporting Becomes Global Again

Mitigation:

```text
store roles only on contextual edges
validate no global primary/supporting on material node
```

---

## 29. Implementation Phases

## Phase 0 — Repo Skeleton

Create:

```text
docs/
atlas/
state/
graph/
viewer/
scripts/
```

Add SDD, ADRs, templates, boundary checker.

## Phase 1 — Graph MVP

Implement:

```text
concept/material/direction/suggested-route parsing
graph JSON builder
static viewer
```

## Phase 2 — Plan Import

Implement:

```text
Markdown plan import
extracted YAML
manual review flow
example import from uploaded SWE plan
```

## Phase 3 — Artifact Observation

Implement:

```text
observe notes/tests/code
propose artifacts
update state
record trail segments
```

## Phase 4 — Influence and Frontier

Implement:

```text
influence computation
frontier suggestions
question graph
```

## Phase 5 — Agent Team Integration

Implement:

```text
agent roles
review workflows
Codex checkpoints
state-auditor gate
```

---

## 30. Final Design Statement

Atlas should preserve three layers that must never collapse into one:

```text
SuggestedRoute:
  The paths others proposed.

PersonalTrail:
  The path we actually walked.

InfluenceField:
  The part of the forest that now carries our marks.
```

The system succeeds when the user can look at the graph and say:

```text
I see the proposed paths.
I see my own trail.
I see what I have touched.
I see what remains dark.
I see nearby territory.
I do not feel judged by the map.
```

Core sentence:

> **Atlas does not tell the user what they failed to complete. Atlas shows where the user is, how they got there, and what nearby parts of the field are now visible.**

