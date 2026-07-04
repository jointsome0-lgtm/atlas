## §19. Boundary Checker

`scripts/check_atlas_boundaries.py` should fail on forbidden project/task-manager language in Atlas's own voice, outside explicit forbidden-term sections. The user's voice is never checked: natural-language field values are exempt, and `plans/imported/` is never scanned — a raw plan or a trail `reason` may say `deadline` freely; the checker must never force a rewrite of user memory (§5.2).

Forbidden terms: every §4 forbidden core state (§4's list is canonical — the checker must not fork it), plus:

```text
must finish
overdue
task board
productivity ledger
target_repo
```

Allowed only when documented as forbidden.

`pressure` is forbidden as a schema key or enum value in the structure scan (#11): the pressure dimension must not exist as data anywhere in Atlas. Prose remains free to describe the no-pressure law (§4, §15, §25.4).

Scan modes:

```text
full text — where Atlas itself speaks:
  README.md, CLAUDE.md, AGENTS.md, docs/, viewer/

structure only — where user text flows through:
  atlas/, state/, graph/ — check keys, node/edge types, and
  closed-enum values (fields whose §9 schema defines a fixed
  value set, e.g. status, kind, depth, role); skip
  natural-language values (e.g. reason, text, summary, title)
```

---

