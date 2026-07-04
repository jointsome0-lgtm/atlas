## §25. Non-Functional Requirements

## §25.1 Local-First

All primary data lives in the repo.

## §25.2 Versionable

All graph state should be plain text or JSON:

```text
Markdown
YAML
JSON / JSONL (journals, §8)
```

## §25.3 Auditable

Every state update must be traceable to recorded evidence (§9.12).

This holds by construction (§20, §31.8): state is a fold over the `state/` journals — exposure via the §14.5 mapping, review-gated dimensions via recorded decisions citing evidence (§9.13) — so an untraceable update is unrepresentable.

## §25.4 Low Pressure

No dashboards should imply lateness, failure, or incompletion.

## §25.5 Extensible

The system should later support:

```text
multiple learning plans
multiple domains
source annotations
spaced revisits
artifact embeddings
better visualization
external connectors
```

---

