## §12. Plan Import Flow

## §12.1 Input

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
external plan record via the intake boundary (§33.3)
```

## §12.2 Import Steps

```text
1. Store original plan under plans/imported/.
2. Parse headings, lists, code blocks, links, and test names.
3. Extract candidate directions.
4. Extract candidate concepts.
5. Extract materials and URLs.
6. Detect material roles and declared support links ("for section X
   use B") if the plan implies them; support links import as
   supported_by existence only — weight is never imported (§9.14).
7. Extract practice probes/tests.
8. Extract proposed sequence as SuggestedRoute.
9. Create candidate graph.
10. New concepts start unseen/unknown/vague; existing state is never
    touched — import neither downgrades (§14.5) nor raises state.
11. Generate import report; plan self-claims ("already know X") appear
    there as proposals only, applied on user confirmation (§14.6).
```

## §12.3 Example from Uploaded Plan

The example plan is a demo fixture authored by the ecosystem synthetic
persona Vera Example
([selfos docs/persona.md](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/persona.md));
its subject is on her fact sheet.

The uploaded plan becomes a plan node:

```yaml
plan:
  id: plan:learn-basics-swe
  title: Backend distributed systems practice in Python
```

It would create a direction like:

```yaml
direction:backend-distributed-systems-python
```

It would create suggested routes such as:

```text
REST → Redis → Kafka → RabbitMQ → gRPC → E2E
REST → Redis → Kafka → gRPC → RabbitMQ
```

with ids:

```text
suggested-route:learn-basics-swe-default
suggested-route:learn-basics-swe-roi
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

with ids such as:

```text
concept:rest-api
concept:fastapi
concept:redis
concept:kafka
concept:rabbitmq
concept:grpc
concept:idempotency
concept:rate-limiting
concept:kafka-offsets
concept:rabbitmq-dlq
concept:grpc-deadlines
concept:e2e-distributed-job-flow
```

It would create probes such as:

```text
probe:duplicate-post-idempotency
probe:kafka-offset-commit-safety
probe:grpc-timeout-failure
probe:rabbitmq-dlq
probe:redis-rate-limit
```

All extracted understanding state starts as `unseen` / `unknown` / `vague`; understanding is never imported (see §5.3; §12.2 step 10).

The plan describes these ideas around a single integrated Python lab (`distributed-systems-python-lab` repo) using FastAPI, Redis, Kafka, RabbitMQ, gRPC, pytest/Testcontainers, and E2E job-flow tests.

## §12.4 Re-Run Semantics

A direct import is a batch of one — §33.2's discipline reused, never a third semantics (#40):

```text
Each committing run is one batch, receipted in
state/receipts.jsonl (§33.2) under import/<date-serial>#0
(2026-07-15-001 — the §34.6 pattern; a receipt key never
derives from content: receipts survive purge, and a hash is
content) — opened before any output, processed after the last.
Re-importing byte-identical content is a no-op: the importer
hashes the source against the stored originals under
plans/imported/ — the purgeable audit layer, so after a purge
the check finds nothing and the import runs fresh: the content
is gone, and bringing it back is the user's explicit act
(§31.7).
A changed plan is a new version, never an overwrite: the
predecessor is the stored original with the same plan slug
(§21.2 — the id from the plan's own heading), the new original
lands beside it under a dated name, and the importer diffs
against the predecessor's original and extracted YAML,
proposing updates in the import report.
Curated hand edits win: the importer never clobbers a file
under atlas/ — §8's "written by hand or through review" is a
rule, not a hope; a conflict surfaces in the import report.
A candidate that matches an existing node (import proposes
concept:redis, the file exists) surfaces as a merge / link /
skip proposal — the user decides; the resolution appends to
state/mapping-decisions.jsonl (§21.3) and is not re-asked
without new evidence.
A partially reviewed import surfaces like an interrupted
intake record (§33.2): opened without processed goes to the
report, never silently reprocessed or overwritten.
Import is dry-run by default (§21.1): a dry run writes
nothing; only an explicit commit run takes the lock, writes,
and receipts.
```

---

