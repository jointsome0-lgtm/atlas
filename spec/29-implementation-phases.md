## §29. Implementation Phases

The phase table sequences work only; MVP scope is defined in §26.

### Current implementation posture

**State: Partial freeze.** The knowledge-domain vertical is active. Approved work may proceed through named issues and their prerequisites, including #29, #30, #31, #34, #36, #37, #42, #44, #49, and #56; every issue's own entry gates remain binding. An approved knowledge slice may land before unrelated Atlas specification debt closes, but this does not waive its gate or authorize divergence from the SDD. Normative friction discovered during implementation becomes a focused issue and, if accepted, an SDD edit plus Decision Log entry before code changes behavior.

### Body Atlas freeze

§32 remains an extension design and second-domain test, but Body Atlas implementation is frozen under #45. Phases 1–3 and their tickets must not depend on §32-specific code. During the freeze, excluded work is Body Atlas code, real health journals, silhouette implementation, medical-derived state, new body-specific features, fields, or modes, and public sample health data. A §32 defect may still be corrected when it affects the generic core.

Body Atlas may be considered for implementation only after every objective gate below is satisfied:

- the graph builder and first knowledge field viewer are usable (#44);
- at least one real plan has been imported through a reviewed, idempotent flow;
- at least one week of non-medical artifact observation has been folded and inspected by the owner;
- the rename, deletion, and history contract is resolved (#35);
- the Atlas threat model and agent-context boundary are resolved (#37);
- no-evidence medical state and sensitivity-taint propagation are resolved (#38);
- the public-engine/private-instance deployment model is decided in the selfos integration repository;
- a private-data test fixture and explicit purge and backup story exist before any real health record enters the system.

Satisfying any one prerequisite, including the first knowledge viewer, does not unfreeze Body Atlas. After all objective gates are satisfied, implementation still requires a new explicit owner decision and Decision Log entry.

| Phase | Content |
|-------|---------|
| 0 — Repo skeleton | Create `docs/`, `atlas/`, `state/`, `graph/`, `viewer/`, `scripts/`; add SDD, ADRs, templates, boundary checker |
| 1 — Graph MVP | Concept/material/direction/suggested-route parsing; graph JSON builder; static viewer |
| 2 — Plan import | Markdown plan import; extracted YAML; manual review flow; example import from the uploaded SWE plan |
| 3 — Artifact observation | Observe notes/tests/code; propose artifacts; update state; record trail segments |
| 4 — Influence and frontier | Influence computation; frontier suggestions; question graph |
| 5 — Agent team integration | Agent roles; review workflows; Codex checkpoints; state-auditor gate |

---
