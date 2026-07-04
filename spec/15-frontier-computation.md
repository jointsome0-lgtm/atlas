## §15. Frontier Computation

The **Frontier** is not a TODO list.

It is the visible edge of the current influence field.

Pressure-freedom is a design law, not per-item data: no schema carries a `pressure` field — the boundary checker fails on the key itself (§19).

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

Current position is derived, never stored: the `to` concepts of the most recent trail segments (per direction, recency-weighted). A direction may have several simultaneous heads (forks, star-shaped days; a landing counts like any segment) — no head is "main"; recency, not topology, fades old ones. Anything derivable from the trail must not become a second source of truth beside it.

## §15.2 Output

Example:

```yaml
frontier:
  - id: frontier:redis-idempotency-key
    kind: adjacent_concept
    concept: concept:redis-idempotency-key
    reason: REST idempotency artifact raised storage question.

  - id: frontier:201-vs-202
    kind: open_question
    question: question:201-vs-202
    reason: Async job creation response semantics unclear.

  - id: frontier:kafka-duplicate-event
    kind: future_consequence
    concept: concept:kafka-idempotent-consumer
    reason: Duplicate request handling may later reappear as duplicate event handling.
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

