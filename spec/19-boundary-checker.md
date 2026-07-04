## §19. Boundary Checker

`scripts/check_atlas_boundaries.py` should fail on forbidden project/task-manager language outside explicit forbidden-term sections.

Forbidden terms: every §4 forbidden core state (§4's list is canonical — the checker must not fork it), plus:

```text
must finish
overdue
task board
productivity ledger
target_repo
```

Allowed only when documented as forbidden.

The checker should scan:

```text
README.md
CLAUDE.md
AGENTS.md
docs/
atlas/
state/
graph/
```

---

