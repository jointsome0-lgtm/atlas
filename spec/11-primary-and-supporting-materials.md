## §11. Primary and Supporting Materials

`primary` and `supporting` are contextual edge roles.

## §11.1 Route Context

```yaml
context: suggested-route:learn-basics-swe-default
step: concept:rest-api
primary_materials:
  - material:mdn-http-methods
  - material:fastapi-tutorial
supporting_materials:
  - material:openapi-spec
```

## §11.2 Question Context

```yaml
context: question:201-vs-202
primary_materials:
  - material:mdn-http-status-codes
supporting_materials:
  - material:rest-api-guidelines
reason: Needed to resolve async creation response semantics.
```

## §11.3 Trail Context

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
The graph must never store global primary/supporting flags on Material itself —
authored data and derived outputs (graph/) alike. Aggregates over contextual
roles are computed at render time and shown context-labeled
(“primary in 5 contexts”), never materialized as fields.
```

---

