## §17. Agent Architecture

## §17.1 Core Agents

Four roles. Further specialization only when a role demonstrably overloads — split it then, citing the overload.

```text
plan-importer
  Extracts directions, routes, concepts, materials, probes from plans (§12, §21).

artifact-observer
  Scans user artifacts; records artifacts, encounters, and questions
  (journal appends, §13.2); appends trail segments, proposing only
  corrections (§31.2); proposes review-gated changes — confidence /
  clarity / coverage, support-link weight (§14.9), question status
  (§9.8); influence is never proposed — the builder computes it (§9.10).

field-cartographer
  Owns the ontology (§6), concept graph and area boundaries,
  material/part→concept mapping, and support-link existence and
  endpoints (§9.14) (absorbs atlas-architect, material-analyst).

state-auditor
  Guards the invariants: rejects overclaimed understanding and task-manager /
  pressure drift (absorbs red-team-reviewer; enforces the §14.6 review gate).
```

Not agent roles: the graph builder and viewer are code, owned like any code (§20, §16); Codex involvement is fully defined by §18 — no coordinator role needed.

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

