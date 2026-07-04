## §8. Repository Layout

```text
atlas/
  README.md
  CLAUDE.md
  AGENTS.md

  docs/
    SDD.md
    ATLAS_SYSTEM.md
    GRAPH_MODEL.md
    STATE_MODEL.md
    TRAIL_MODEL.md
    PLAN_IMPORT_MODEL.md
    MATERIAL_MODEL.md
    INFLUENCE_MODEL.md
    FRONTIER_MODEL.md
    TEAM_OPERATING_SYSTEM.md
    CODEX_PROTOCOL.md
    adr/
      0001-atlas-ontology.md
      0002-graph-first-atlas.md
      0003-suggested-routes-vs-personal-trail.md
      0004-contextual-primary-supporting.md

  atlas/
    concepts/
      rest-api.md
      redis.md
      kafka.md
      rabbitmq.md
      grpc.md
      idempotency.md
      observability.md
      evals.md

    materials/
      _template.md
      mdn-http-methods.md
      fastapi-tutorial.md
      redis-py-guide.md
      apache-kafka-quickstart.md
      rabbitmq-python-tutorial.md
      grpc-python-quickstart.md

    directions/
      backend-distributed-systems-python.md
      harness-engineering.md
      agent-reliability.md

    suggested-routes/
      learn-basics-swe-default.md
      learn-basics-swe-roi.md

    trails/
      _template.md
      2026-06-02-seed.md

    probes/
      duplicate-post-idempotency.md
      kafka-offset-commit-safety.md
      grpc-timeout-failure.md
      rabbitmq-dlq.md
      redis-rate-limit.md

  plans/
    imported/
      learn-basics-swe.md
    extracted/
      learn-basics-swe.yaml

  state/
    current-position.yaml
    concept-state.yaml
    material-state.yaml
    open-questions.yaml
    influence-field.yaml

  graph/
    schema.yaml
    atlas-graph.json
    build_graph.py

  viewer/
    index.html
    app.js
    styles.css

  scripts/
    import_plan.py
    observe_artifacts.py
    build_atlas_graph.py
    check_atlas_boundaries.py
    validate_atlas.py
```

---

