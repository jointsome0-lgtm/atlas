## §13. Artifact Observation Flow

## §13.1 Inputs

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

## §13.2 Observation Steps

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

## §13.3 Example

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

