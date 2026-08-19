# Vendored tooling

| Vendored file | Source in `selfos-skills` | Version | Source commit |
| --- | --- | --- | --- |
| `scripts/check_decision_log.ts` | `skills/sdd-conventions/scripts/check_decision_log.ts` | 2.0.0 | `5feaf8dbb0b80b417b3d966847e06f3ce321df08` |

The checker was vendored twice for the length of the TypeScript migration
(#119) — a `.ts` copy and the `.py` copy it was proved against. The cutover
tranche removed the Python side along with every other Python file, so what is
listed above is now the whole of it. Upstream holds the two forms to identical
arguments, output, exit status and written bytes with a differential harness;
here they were compared on this repository's own `DECISION-LOG.md`, including
the 202-diagnostic unbaselined run, and agreed byte for byte before the Python
copy went.

Upstream records two divergences it does not fix (`selfos-skills#116`), both the
runtime's Unicode table rather than a checker's rules: CPython 3.12 answers from
Unicode 15.0 and Bun from 16.0, so a code point assigned between the two
releases is escaped differently by `repr()` and matched differently by `\d`.
Neither reaches this repository — no path or issue number here is spelled in one
— but a fixture that adopted such a character would make the two copies disagree.

The recorded source commit is a commit pin, not a content hash: it cannot detect
upstream drift in either direction, so freshness is verified by diffing against a
current `selfos-skills` checkout. Update by rerunning the copy against a current
`selfos-skills` checkout in an explicit PR.

`check_sdd_conventions.ts` and its template left on 2026-08-20 with the SDD
process gate (see the Decision Log). The spec stays as reference
documentation; AGENTS.md no longer has a CI-checked conventions block.
