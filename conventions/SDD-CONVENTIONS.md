<!-- sdd-conventions-template v1.1.0 -->
## SDD conventions — shared mechanics

Shared structural rules for SDD-stage repositories, vendored from
`selfos-skills`. Product rules, phase plans, commands, privacy classes,
lanes, and review policy stay local to each repository.

- **Stable section numbers.** A top-level § number never changes meaning:
  no renumbering, and a retired number is never reused.
- **Map plus one file per section.** `SDD.md` is the map. Where the spec is
  split, each top-level § lives in its own `spec/NN-*.md` file.
- **Point reads by default.** Read only the §§ named by the task; a full
  pass over the spec happens only on an explicit full-pass request.
- **One normative home per rule.** Every rule is owned by exactly one §;
  everywhere else references it instead of restating it.
- **Enumerable data lives in canon artifacts.** Eval cases, enum tables,
  fixture examples, and machine-readable schemas are authored as canon
  artifacts (a ledger, schema files, fixture trees), CI-validated where a
  validator exists — a missing validator defers the check, never the
  extraction; the owning § keeps the annotation, the binding rule, and
  the pointer. Decisions, invariants, and rationale stay in the §§ in
  full text, and canon never points at living implementation code as its
  source.
- **A decision lands as three writes.** An accepted decision = the SDD edit,
  one concise Decision Log line, and the rationale in the issue or commit.
- **Correction versus trade-off.** A factual or editorial fix whose desired
  state existing canon already determines may be proposed as a correction;
  everything else is an owner trade-off and needs the owner's decision.
- **No silent bends.** Implementation never quietly deviates from the SDD;
  observed friction becomes an issue, and the SDD changes only through an
  accepted decision.
- **Findings live in issues.** Review findings and open questions go to
  GitHub issues, never to committed report files.
- **Invented data only in public repositories.** Examples and fixtures carry
  no real personal data, credentials, or local agent/tool state.
