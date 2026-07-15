## §21. Importer Design

`scripts/import_plan.py` should initially support Markdown.

## §21.1 MVP Strategy

Because fully automatic plan understanding is hard, use a hybrid approach:

```text
1. Deterministic parser extracts headings, links, code blocks, test names.
2. Agent pass proposes semantic mapping.
3. Human can review extracted YAML.
4. Graph builder consumes reviewed YAML.
```

The review step is an explicit dry-run/commit split (#36): a run is dry by default — parse, propose, emit the import report, write nothing. Only an explicit commit run applies the reviewed result; a committing run is a writer like any other — it takes the instance lock (§25.6) and receipts its batch of one (§12.4).

## §21.2 Output

```yaml
id: plan:learn-basics-swe
title: Backend distributed systems practice in Python
directions: []
concepts: []
materials: []
material_parts: []
suggested_routes: []
probes: []
notes: []
```

`id` is a stable slug; `title` is taken from the plan's own heading and must match the plan node (§12.3).

## §21.3 Mapping Decisions

The review step's identity questions — "is candidate X the existing node Y?" — are remembered in a dedicated journal, `state/mapping-decisions.jsonl` (§8), mirroring the §9.13 shape:

```json
{"date": "2026-07-15", "target": "candidate:redis -> concept:redis", "evidence": ["import:sha256:ab12...", "report:plan:learn-basics-swe"], "decision": "confirmed"}
```

```text
target: <candidate> -> <existing id> — an identity mapping,
never a state dimension: §9.13's dimension list is untouched,
import mechanics never dilute knowledge-state canon (#40).
evidence: the source content hash and the import-report ref
that raised the question.
decision: confirmed | rejected. A rejected mapping is memory:
the same match is not re-asked without new evidence
(§13.2 step 10 discipline).
The journal is named for the decision kind, not the lane:
intake-record resolution (§33.2) asks the same question
through the same review step and shares the file.
The §20 fold never reads it — mapping decisions are import
machinery, not understanding state (§31.8 untouched).
A row derived from a classed source carries the class like
any journal row (§33.2), and its candidate side is the §34.6
date-serial id the classed stub already has (#50); the source
hash in evidence keeps the row inside the source's purge
closure (§34.2) — mapping memory dies with what it mapped.
```

---

