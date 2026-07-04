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
8. Propose review-gated changes (confidence / clarity / coverage —
   and support-link weight, §14.9), citing evidence (§9.12); exposure
   follows from recorded evidence (§14.5) and needs no proposal.
9. Append trail segments — one per evidenced movement; an artifact
   may yield several (a star-shaped day: N from-less landings sharing
   `via`). Derive `from` per §9.9 (evidenced causal origin(s) from the
   artifact's own context — never the latest trail head, never a copy
   of `touches`). Propose corrections only (§31.2, §5.2).
10. For observation records (steps 1–7, 9): ask only when interpretation
    is ambiguous or high-impact. Review-gated proposals (step 8) always
    wait for the user's decision, recorded as a StateDecision (§9.13);
    a rejected proposal is not re-asked without new evidence.
```

Artifact and encounter records append to `state/artifacts.jsonl` / `state/encounters.jsonl`, questions to `state/open-questions.jsonl`, resolved proposals to `state/decisions.jsonl` (§8, §9.13). These journals are what §25.3 audits state updates against and what §9.10 computes influence from.

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

