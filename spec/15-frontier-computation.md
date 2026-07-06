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

Dependency wording is governed by §15.3.

## §15.3 The Honest-Lever Rule

Guilt is not negative information. Guilt is a system exploiting the feeling of an unfulfilled plan for retention. The frontier is honest, not soft: softening a true dependency into a euphemism is manipulation of the flattering kind, and manufacturing urgency is manipulation of the pressuring kind — both are banned as mechanisms, whatever the vocabulary (§19).

A dependency suggestion — "to move X, Y is the real lever" — is allowed when all three hold:

```text
1. the edge is real: a structural link (loads, builds-on) from
   curated content or evidence, not invented at render time;
2. the anchor is the user's own: a declared direction (§9.5) or
   an open question — never a population norm or an un-adopted
   plan;
3. the evidence is cited: the records that make the claim true.
```

Without an anchor the claim has no truth value ("lagging" — behind what?); with one it is a plain fact about leverage. Unconditional imperatives ("you must"), deficit against external norms, deadlines, and retention mechanics (streaks, rings, loss warnings) remain forbidden regardless of wording (§31.6).

---

