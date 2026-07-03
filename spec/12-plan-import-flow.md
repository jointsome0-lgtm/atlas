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
```

## §12.2 Import Steps

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

## §12.3 Example from Uploaded Plan

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

---

