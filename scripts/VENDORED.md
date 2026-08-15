# Vendored tooling

| Vendored file | Source in `selfos-skills` | Version | Source commit |
| --- | --- | --- | --- |
| `scripts/check_sdd_conventions.ts` | `skills/sdd-conventions/scripts/sync_conventions.ts` | 1.0.1 | `5feaf8dbb0b80b417b3d966847e06f3ce321df08` |
| `scripts/check_decision_log.ts` | `skills/sdd-conventions/scripts/check_decision_log.ts` | 2.0.0 | `5feaf8dbb0b80b417b3d966847e06f3ce321df08` |
| `scripts/check_sdd_conventions.py` | `skills/sdd-conventions/scripts/sync_conventions.py` | 1.0.1 | `8e29c4120dfee90ff7869dcc9aa903ac42f7bfd3` |
| `scripts/check_decision_log.py` | `skills/sdd-conventions/scripts/check_decision_log.py` | 2.0.0 | `6c725855dd18c9fd73169481cdca7ec2719f7a28` |
| `AGENTS.md` conventions block | `skills/sdd-conventions/conventions/SDD-CONVENTIONS.md` | template v1.1.0 | `eb03fb69a657bce3f4305f2edc9d9ea35e87c0bd` |
| `conventions/SDD-CONVENTIONS.md` | `skills/sdd-conventions/conventions/SDD-CONVENTIONS.md` | template v1.1.0 | `eb03fb69a657bce3f4305f2edc9d9ea35e87c0bd` |

Each checker is vendored twice for the length of the TypeScript migration
(#119). The `.ts` copies are what CI runs; the `.py` copies stay until the
cutover tranche removes every Python file at once, so the migration keeps an
oracle to compare against and never has a moment where a checker exists only in
its unproven form. Upstream holds the two forms to identical arguments, output,
exit status and written bytes with a differential harness; here they were
compared on this repository's own `AGENTS.md` and `DECISION-LOG.md`, including
the 202-diagnostic unbaselined run, and agreed byte for byte.

Upstream records two divergences it does not fix (`selfos-skills#116`), both the
runtime's Unicode table rather than a checker's rules: CPython 3.12 answers from
Unicode 15.0 and Bun from 16.0, so a code point assigned between the two
releases is escaped differently by `repr()` and matched differently by `\d`.
Neither reaches this repository — no path or issue number here is spelled in one
— but a fixture that adopted such a character would make the two copies disagree.

The recorded source commit is a commit pin, not a content hash: it cannot detect
upstream drift in either direction, so freshness is verified by diffing against a
current `selfos-skills` checkout. The template rows stay at v1.3.0's predecessor
deliberately — adopting it lands three new conventions and is its own decision
(#120), not part of keeping the scripts current.

The committed template copy is what CI checks the `AGENTS.md` block against, so a
block edit cannot pass by recomputing its own hash; template and block update
together. Update by rerunning sync/copy against a current `selfos-skills`
checkout in an explicit PR.
