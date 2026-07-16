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
  - kind: open_question
    question: question:201-vs-202
    reason: Async job creation response semantics unclear.
    evidence:
      - question:201-vs-202

  - kind: adjacent_concept
    concept: concept:redis-idempotency-key
    reason: REST idempotency artifact raised storage question.
    evidence:
      - artifact:test-duplicate-post-idempotency
      - trail-segment:2026-06-05-001

  - kind: stale_concept
    concept: concept:rest-api
    reason: Touched by real movement earlier; no contact in over 90 days.
    evidence:
      - artifact:create-job-endpoint
```

An item carries no synthetic id: its identity is the (kind, target) pair, and the array is emitted sorted by target id (§15.4). `evidence` is mandatory — the records that make the item true (§15.3).

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
1. the edge is real: a structural link (loads, prerequisite_of,
   extends — authored types, §10.2) from curated content or
   evidence, not invented at render time;
2. the anchor is the user's own: a declared direction (§9.5) or
   an open question — never a population norm or an un-adopted
   plan;
3. the evidence is cited: the records that make the claim true.
```

Without an anchor the claim has no truth value ("lagging" — behind what?); with one it is a plain fact about leverage. Unconditional imperatives ("you must"), deficit against external norms, deadlines, and retention mechanics (streaks, rings, loss warnings) remain forbidden regardless of wording (§31.6).

## §15.4 Deterministic Baseline (v1)

The MVP frontier is a pure function of the journals, curated content, and the build as-of (#34): same inputs, same as-of, same array (#39). It is a floor to tune after real trail data; any change bumps through the Decision Log.

Candidate kinds, in selection-priority order:

```text
open_question    — questions whose derived status (§9.8) is open
adjacent_concept — one authored hop (§9.10's weak-halo edge set)
                   from a recent trail head; heads are the `to`
                   concepts of segments whose date is not stale
                   per §14.7 against the as-of (§15.1: several
                   heads are normal, none is "main")
stale_concept    — nodes with influence ≠ none whose influence
                   freshness (§9.10, §14.7) is stale: touched by
                   real movement once, unvisited long since
```

The §32.5 body kinds (stale_zone, stale_pattern, …) run through this same machinery once the body field has data; future_consequence and the remaining §32.5 kinds have no deterministic v1 formula, and the other §15.1 inputs (routes, material gaps, weak-confidence nodes) stay inputs for post-v1 kinds — each joins only via a Decision Log entry.

Selection:

```text
One item per target: a node qualifying under several kinds keeps
the highest-priority one.
Under the cap: kind priority, then within a kind by date —
open_question newest created first, adjacent_concept newest head
segment first, stale_concept longest-unseen first — then target
id.
Cap: 7 items (a config default, tunable like the §14.7
thresholds; changing the default is a Decision Log entry).
The emitted array is sorted by target id: selection order is
internal and never surfaces as a ranking (§4).
```

---

