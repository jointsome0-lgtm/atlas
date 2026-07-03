## §23. Progression Model

The user progresses by movement, not by completion.

## §23.1 Normal Loop

```text
1. Import a plan.
2. Atlas builds suggested routes and candidate field graph.
3. User chooses any interesting concept, question, material, or artifact.
4. User creates a small artifact.
5. Agents classify the artifact.
6. Atlas updates StateGraph.
7. Atlas records PersonalTrail.
8. Atlas expands InfluenceField.
9. Atlas shows Frontier.
```

## §23.2 Example

Plan suggests:

```text
REST → Redis → Kafka → RabbitMQ → gRPC
```

User starts with REST and writes an idempotency test.

Atlas records:

```text
PersonalTrail:
REST API → Idempotency
```

Influence expands to:

```text
HTTP methods
POST semantics
Redis idempotency key
duplicate side effects
Kafka duplicate event handling
```

Frontier shows:

```text
Redis idempotency key
201 vs 202
409 vs 422
OpenAPI idempotency header
Kafka idempotent consumer
```

None of these are tasks — they are nearby territory (see §15).

---

