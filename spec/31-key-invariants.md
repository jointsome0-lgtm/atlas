## §31. Key Invariants (candidates)

**Status: candidates, pending grill/approval — not yet approved invariants.** Distilled from existing sections as a safety net for dedup passes: no edit may delete or weaken these statements without an explicit decision. The cited sections remain canonical.

1. **Never a TODO system or guilt machine.** `todo`, `in_progress`, `done`, `blocked`, `deadline`, `ticket`, `sprint` are forbidden as core states; the boundary checker fails on task-manager language in Atlas's own voice (schema keys, enum values, docs, UI wording — §19), never in user-authored free text. Atlas may show state of understanding, never task-completion pressure. (§1, §4, §19)

2. **The personal trail cannot fail and is never overwritten by automation.** A trail segment is a memory of actual movement, not a commitment; routes, importers, and agents may only append segments and propose corrections (applied only on user confirmation); the user's own hand-edits — including deletion — are sovereign. (§5.2, §9.9)

3. **Understanding is never imported.** Plan import creates candidate graph structure and never writes understanding state: new concepts start `unseen`/`unknown`/`vague`, existing state is untouched; plan self-claims ("already know X") become import-report proposals, applied only on user confirmation. (§5.3, §12.2 steps 10–11)

4. **No global primary/supporting on materials.** `primary`/`supporting` are roles on contextual edges (route step, question, trail segment); no global primary/supporting flags on a Material node — in authored data or derived outputs alike; aggregates over contextual roles are render-time only. (§5.5, §11)

5. **State and confidence upgrades require evidence.** Exposure is defined by user actions (§14.1) and moves only via the monotone evidence mapping (§14.5); `confidence`/`clarity`/`coverage` change only through propose→confirm (§14.6); every state update must be traceable to recorded evidence — the canonical evidence-kind list lives in §14.6/§25.3, not here; agents must not claim understanding without artifacts or upgrade confidence without reason. (§14, §17.2, §25.3)

6. **Frontier wording carries no obligation.** The frontier is the visible edge of the influence field, not a TODO list: items carry `pressure: none` and use adjacency wording (nearby, adjacent, naturally connected, open, available, possible), never `next task` / `must do` / `overdue` / `blocked` / `remaining`. (§15)

7. **Local-first: the user's machine is Atlas's only home.** The local repo is the sole canonical store, private by default; Atlas sends nothing anywhere on its own initiative (no telemetry, sync, auto-push); outward transit happens only inside a session the user explicitly started, with a provider the user chose; secrets never enter any agent context (§24 ignore paths). (§24, §25.1)

8. **Derived is never stored.** Anything derivable from trail, state, and artifacts — current position (§15.1), freshness (§14.7), influence (§9.10) — is computed at build/view time; a stored copy of a derivable value is a second source of truth and forbidden. (§9.10, §14.7, §15.1)

---

