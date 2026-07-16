# Vendored tooling

| Vendored file | Source in `selfos-skills` | Version | Source commit |
| --- | --- | --- | --- |
| `scripts/check_sdd_conventions.py` | `plugins/sdd/scripts/sync_conventions.py` | 1.0.0 | `fec08e3743bacdcb7f3dbd9f5e5d8330db48ca48` |
| `scripts/check_decision_log.py` | `plugins/sdd/scripts/check_decision_log.py` | 1.1.0 | `fec08e3743bacdcb7f3dbd9f5e5d8330db48ca48` |
| `AGENTS.md` conventions block | `plugins/sdd/conventions/SDD-CONVENTIONS.md` | template v1.0.0 | `fec08e3743bacdcb7f3dbd9f5e5d8330db48ca48` |
| `conventions/SDD-CONVENTIONS.md` | `plugins/sdd/conventions/SDD-CONVENTIONS.md` | template v1.0.0 | `fec08e3743bacdcb7f3dbd9f5e5d8330db48ca48` |

The committed template copy is what CI checks the `AGENTS.md` block against, so a
block edit cannot pass by recomputing its own hash; template and block update
together. Update by rerunning sync/copy against a current `selfos-skills`
checkout in an explicit PR.
