## §29. Implementation Phases

The package table sequences work only; MVP scope is §26's, acceptance §27's.

### Current implementation posture

**State: Partial freeze.** The knowledge-domain vertical is active. Approved work may proceed through named issues and their prerequisites, including #29, #30, #31, #34, #36, #37, #42, #44, #49, and #56; every issue's own entry gates remain binding. An approved knowledge slice may land before unrelated Atlas specification debt closes, but this does not waive its gate or authorize divergence from the SDD. Normative friction discovered during implementation becomes a focused issue and, if accepted, an SDD edit plus Decision Log entry before code changes behavior.

### Body Atlas freeze

§32 remains an extension design and second-domain test, but Body Atlas implementation is frozen under #45. The trunk and the knowledge verticals and their tickets must not depend on §32-specific code. During the freeze, excluded work is Body Atlas code, real health journals, silhouette implementation, medical-derived state, new body-specific features, fields, or modes, and public sample health data. Accordingly, §20's body-domain branches are deferred as active implementation requirements. The pre-freeze Phase 1 spike's existing zone/pattern parsing, `figure_region` projection hook, and invented non-sensitive Vera Example second-domain fixtures may remain only as generic-core regression evidence: trunk and knowledge-vertical work must not extend them, make an issue depend on them, render a silhouette, fold body or medical state, or admit sample health data. §20 becomes active in full only after unfreeze. A §32 defect may still be corrected when it affects the generic core.

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

### Trunk and verticals (#18)

Every interface between components is a file contract — journals (§8), curated frontmatter (§20.4), the emitted graph (§10) — so implementation parallelizes as verticals over one small sequential trunk: agents share formats, never code. Each vertical owns its §§, its script, its §27 criteria, and its scenario fixtures (the shared golden set is the trunk's — §27), and is provable without its neighbors — the guards land first because the checker, grammar, and validator are the executable invariants that keep parallel work from drifting.

| Package | Content | Proof |
|---------|---------|-------|
| Trunk — guard/contract (sequential, first) | §8 skeleton; boundary checker (§19); §20.4 grammar, §25.7 schemas, `validate_atlas.py` (#30); §10.2 edge matrix transcribed (#31); the shared §27 golden fixtures; CI running every guard | §27.9; §20.4 conformance |
| V-build — builder convergence | full §20 pipeline: §14 fold with `--as-of` (#29), retired-id map (#49), lock + atomic emission (#60), influence and frontier baselines (§9.10, §15.4), `--redact` | §27.3, §27.5–§27.7, §27.11 |
| V-view — viewer | §16 over the graph fixture (#44) | §27.2, §27.8 |
| V-capture — deterministic capture/intake | the §26.1 manual observation floor documented (#47); intake batches (#56); deterministic import lanes — dry-run/commit, receipts, diffed re-import (§12.4, §21.1) | §27.1, §27.4 |
| V-agents — agent governance/runner | §17 role contracts (#41); isolated runner boundary (#46); model-assisted importer/observer stay disabled until both land | §17, §24 |
| Integration proof (sequential finale) | the example plan end-to-end through every vertical on the live path | §27.1–§27.11 |
| V-body — frozen lane | §32 instantiation; not MVP (§26); enters only through the freeze gate above, riding the same trunk | §32 |

The trunk is sequential and lands first; verticals run in parallel once it exists and meet only through fixtures (the viewer renders the hand-written graph sample before the builder converges); the integration proof is sequential and last.

---
