# Vendored tooling

| Vendored file | Source in `selfos-skills` | Version | Source commit |
| --- | --- | --- | --- |
| `scripts/check_sdd_conventions.py` | `skills/sdd-conventions/scripts/sync_conventions.py` | 1.0.1 | `8e29c4120dfee90ff7869dcc9aa903ac42f7bfd3` |
| `scripts/check_decision_log.py` | `skills/sdd-conventions/scripts/check_decision_log.py` | 2.0.0 | `6c725855dd18c9fd73169481cdca7ec2719f7a28` |
| `AGENTS.md` conventions block | `skills/sdd-conventions/conventions/SDD-CONVENTIONS.md` | template v1.1.0 | `eb03fb69a657bce3f4305f2edc9d9ea35e87c0bd` |
| `conventions/SDD-CONVENTIONS.md` | `skills/sdd-conventions/conventions/SDD-CONVENTIONS.md` | template v1.1.0 | `eb03fb69a657bce3f4305f2edc9d9ea35e87c0bd` |

The recorded source commit is a commit pin, not a content hash: it cannot detect
upstream drift in either direction, so freshness is verified by diffing against a
current `selfos-skills` checkout. The template rows stay at v1.3.0's predecessor
deliberately — adopting it lands three new conventions and is its own decision
(#120), not part of keeping the scripts current.

The committed template copy is what CI checks the `AGENTS.md` block against, so a
block edit cannot pass by recomputing its own hash; template and block update
together. Update by rerunning sync/copy against a current `selfos-skills`
checkout in an explicit PR.
