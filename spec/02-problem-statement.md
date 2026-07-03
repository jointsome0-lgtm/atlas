## §2. Problem Statement

Learning plans are useful, but they usually produce pressure:

```text
“Here is the path. Follow it.”
```

The user’s actual learning is not linear. A proposed route might say:

```text
REST → Redis → Kafka → RabbitMQ → gRPC
```

But the user’s real trail might become:

```text
REST → idempotency → HTTP status semantics → Redis idempotency keys → Kafka duplicate event handling
```

Both are valuable, but they are different things.

Atlas solves this by separating `SuggestedRoute`, `PersonalTrail`, `InfluenceField`, and `StateGraph` (definitions: §6; principles: §5).

The uploaded learning plan is a good example; see §12.3 for what it becomes (direction, suggested routes, concepts, probes).

---

