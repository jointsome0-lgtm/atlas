## §1. Executive Summary

**Atlas** is a local-first system for building a living knowledge graph of a technical field and the user’s movement through it.

It imports external learning plans as **suggested routes**, extracts **concepts**, **materials**, **material parts**, **practice probes**, and **directions**, but does not treat any route as mandatory.

The system then observes the user’s actual artifacts — notes, tests, code, diagrams, explanations, reviews — and uses them to update:

```text
1. FieldGraph        — what exists in the domain
2. MaterialGraph     — which materials explain which concepts
3. StateGraph        — what the user currently understands
4. PersonalTrail     — where the user actually moved
5. InfluenceField    — which parts of the map are now affected by the user’s artifacts
6. Frontier          — nearby concepts/questions/materials naturally adjacent to current movement
```

Core principle:

```text
Suggested routes are maps.
Personal trail is memory.
Influence field is understanding becoming visible.
```

Atlas must never become a TODO system, productivity ledger, sprint board, or guilt machine.

---

