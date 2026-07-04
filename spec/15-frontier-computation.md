## §15. Frontier Computation

The **Frontier** is not a TODO list.

It is the visible edge of the current influence field.

## §15.1 Inputs

```text
recent trail heads (derived)
influence field
open questions
suggested routes
concept graph neighbors
material gaps
stale nodes
weak confidence nodes
```

Current position is derived, never stored: the `to` concepts of the most recent trail segments (per direction, recency-weighted). Anything derivable from the trail must not become a second source of truth beside it.

## §15.2 Output

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

