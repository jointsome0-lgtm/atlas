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
4. Extract explicit questions the artifact raises.
5. Link artifact to materials if references exist.
6. Record an encounter when an artifact or a manual declaration shows contact with a material (part).
7. Link artifact to probes if matching.
8. Propose state updates.
9. Propose trail segments.
10. Propose influence updates.
11. Ask for review only when update is ambiguous or high-impact.
```

Artifact and encounter records append to `state/artifacts.yaml` / `state/encounters.yaml`, questions to `state/open-questions.yaml` (§8). These records are what §25.3 audits state updates against and what §9.10 computes influence from.

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
    - artifact:test-duplicate-idempotency-key
```

It should not infer:

```text
Redis mastered.
REST done.
Kafka next required.
```

---

