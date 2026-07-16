## §19. Boundary Checker

`scripts/check_atlas_boundaries.py` should fail on forbidden project/task-manager language in Atlas's own voice, outside explicit forbidden-term sections. The user's voice is never checked: natural-language field values are exempt, and `plans/imported/` and `intake/` are never scanned (§33.2: a delivered batch keeps a foreign system's voice) — a raw plan or a trail `reason` may say `deadline` freely; the checker must never force a rewrite of user memory (§5.2).

Forbidden terms: every §4 forbidden core state (§4's list is canonical — the checker must not fork it), plus:

```text
must finish
overdue
task board
productivity ledger
target_repo
streak
```

`streak` guards the retention-mechanics ban (§15.3, §32.4).

Allowed only when documented as forbidden.

`pressure` is forbidden as a schema key or enum value in the structure scan (#11): the pressure dimension must not exist as data anywhere in Atlas. Prose remains free to describe the no-pressure law (§4, §15, §25.4).

The §4 measurement ban enters the structure scan the same way (#20): the following stems are forbidden as schema keys or closed-enum values —

```text
score
rating
percent
rank
level
progress
completion
mastery
```

— an aggregate or mastery measure must not exist as data anywhere in Atlas; `graph/` emissions, the §33.4 snapshot included, are scanned like the rest — field names and closed-enum values, never identifiers (the scan-mode rule below). §4 stays the canonical ban; these stems are its checker translation (§4's UI phrasings — "progress bars", "percent mastered" — don't name keys). Prose remains free to name them, as §4 itself does.

Scan modes:

```text
full text — where Atlas itself speaks:
  README.md, CLAUDE.md, AGENTS.md, docs/, viewer/

structure only — where user text flows through:
  atlas/, state/, graph/ — check keys, node/edge types, and
  closed-enum values (fields whose §9 schema defines a fixed
  value set, e.g. status, kind, depth, role); skip
  natural-language values (e.g. reason, text, summary, title)
  and identifiers — a node id (§10.1) is user vocabulary (§5.2)
  wherever it appears, map keys included: concept:isolation-level
  must not trip level, nor zone:blood-pressure pressure
```

---

