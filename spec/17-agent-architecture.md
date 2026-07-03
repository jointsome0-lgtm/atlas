## §17. Agent Architecture

## §17.1 Core Agents

```text
atlas-architect
  Owns ontology and conceptual consistency.

plan-importer
  Extracts directions, routes, concepts, materials, probes.

field-cartographer
  Maintains concept graph and area boundaries.

material-analyst
  Maps materials and material parts to concepts.

artifact-observer
  Scans user artifacts and proposes state/trail updates.

state-auditor
  Prevents overclaiming understanding.

graph-engineer
  Owns graph schema, builder, validation.

viewer-engineer
  Owns static viewer and graph interaction.

red-team-reviewer
  Attacks task-manager drift, pressure leakage, overengineering.

codex-coordinator
  Uses Codex only for checkpoint review/rescue.
```

## §17.2 Agent Rules

Agents may:

```text
extract
classify
suggest
link
summarize
flag gaps
propose state updates
```

Agents must not:

```text
claim the user understands something without artifacts
turn routes into obligations
create todo/done statuses
invent user trail segments
hide uncertainty
upgrade confidence without reason
```

---

