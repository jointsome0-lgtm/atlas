## §31. Key Invariants (candidates)

**Status: candidates, pending grill/approval — not yet approved invariants.** Distilled from existing sections as a safety net for dedup passes: no edit may delete or weaken these statements without an explicit decision. The cited sections remain canonical.

1. **Never a TODO system or guilt machine.** `todo`, `in_progress`, `done`, `blocked`, `deadline`, `ticket`, `sprint` are forbidden as core states; the boundary checker fails on task-manager language. Atlas may show state of understanding, never task-completion pressure. (§1, §4, §19)

2. **The personal trail cannot fail and is never overwritten.** A trail segment is a memory of actual movement, not a commitment; proposed routes must not overwrite the user's actual trail. (§5.2, §9.9)

3. **Understanding is never imported.** Plan import creates candidate graph structure with state `unseen`/`unknown` (unless prior artifacts exist); only user artifacts update understanding state. (§5.3, §12.2 step 10)

4. **No global primary/supporting on materials.** `primary`/`supporting` are roles on contextual edges (route step, question, trail segment); the graph must never store global primary/supporting flags on a Material node. (§5.5, §11)

5. **State and confidence upgrades require evidence.** Exposure levels are defined by user actions (read, summarized, applied, taught); every state update must be traceable to an artifact, encounter, question, manual note, or agent review; agents must not claim understanding without artifacts or upgrade confidence without reason. (§14, §17.2, §25.3)

6. **Frontier wording carries no obligation.** The frontier is the visible edge of the influence field, not a TODO list: items carry `pressure: none` and use adjacency wording (nearby, adjacent, naturally connected, open, available, possible), never `next task` / `must do` / `overdue` / `blocked` / `remaining`. (§15)

---

