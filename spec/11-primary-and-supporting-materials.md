## §11. Primary and Supporting Materials

`primary` and `supporting` are contextual edge roles: a material (part) is primary or supporting **for** an episode of user activity — a route step, a question, a trail segment. One storage rule (#31): the route context is authored — a route is curated proposal structure; question and trail contexts are derived at build/render from the journals and never stored (§31.8 — journals stay append-only, and a role stored in a row would freeze judgment at append time). All three emit as context-tagged `primary_for` / `supporting_for` edges (§10.2 matrix, §20.3).

## §11.1 Route Context — Authored

Authored per-step in the route file itself, as `material_roles` (§9.4); import writes it when the plan implies roles (§12.2 step 6), and it stays hand-editable like all curated content:

```yaml
material_roles:
  - step: concept:rest-api
    primary_materials:
      - material:mdn-http-methods
      - material:fastapi-tutorial
    supporting_materials:
      - material:openapi-spec
```

The builder emits material(part) → route edges carrying `step` metadata — part of edge identity (§10.2, §10.3).

## §11.2 Question Context — Derived

Derived from encounters citing the question (§9.7 `context.question`): the encounter's target material (part) folds **primary** when any such encounter is deep use (`depth: applied | taught`), else **supporting**. Nothing is stored; the fold recomputes the view from the journal. Emitted as material(part) → question edges.

## §11.3 Trail Context — Derived

Derived from the segment's own record (§9.9): a material (part) cited in `via` is **primary** — the movement literally went through it; the target of an encounter citing one of the segment's `via` artifacts (§9.7 `context.artifact`) that is not itself in `via` is **supporting**. Nothing is stored. Emitted as material(part) → trail_segment edges.

Rule:

```text
A material’s role changes by context.
The graph must never store global primary/supporting flags on Material itself —
authored data and derived outputs (graph/) alike. Aggregates over contextual
roles are computed at render time and shown context-labeled
(“primary in 5 contexts”), never materialized as fields.
```

## §11.4 Standing Support Is Not a Role

§11 contexts are episodes of user activity — a route step, a question, a trail segment; roles live inside the episode. The standing relation “B helps understand X” is not an episode but graph structure: a directed `supports` edge authored as `supported_by:` (§9.14).

The rule above stays about unary flags (§31.4): a support link is pairwise, names an explicit target, and carries no primacy. Aggregates over support links (“helps in N places”), like aggregates over roles, are computed at render time only.

---

