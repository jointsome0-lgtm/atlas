## §19. Boundary Checker

`scripts/check_atlas_boundaries.py` should fail on forbidden project/task-manager language outside explicit forbidden-term sections.

Forbidden terms:

```text
todo
in_progress
done
blocked
deadline
sprint
ticket
target_repo
must finish
overdue
task board
productivity ledger
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

