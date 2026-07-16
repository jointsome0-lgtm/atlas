# atlas — agent instructions

The primary artifact remains the binding specification — `SDD.md` (map) + `spec/` (body, one file per §). Atlas is under a **partial freeze**: the named knowledge-domain slices in §29 may be implemented through their owning issues and prerequisites, while Body Atlas implementation remains frozen under atlas#45. Point implementation work must follow §29 and its owning issue; normative friction becomes a focused issue and, if accepted, an SDD edit plus Decision Log entry before code changes behavior.

## SDD refinement rules

- Review findings → GitHub issues (section quote + severity). Never create report files.
- Review verdicts are falsifiable: BLOCKED | NEEDS_FIXES | APPROVED_WITH_NOTES. "Fine overall" is forbidden.
- A decision = an SDD edit in the same pass + a Decision Log line + the rationale in the commit message.
- A session after which the SDD did not change and no issue was opened or closed did not happen.

## Canon

Specification: `SDD.md` is the map (§ index and numbering rules); the body lives in `spec/` (one file per §, file names start with the § number); decisions live in `DECISION-LOG.md`. The map is imported into session context (line below); @-importing the body or the log is forbidden:
- point task → pick the § from the map's index and read only its file in `spec/`;
- full read (all of `spec/` in index order) — only for full-pass reviews or cross-section decisions.

@SDD.md

## Public data boundary

This is a public engine repository. All real data lives in a private instance repository outside this checkout. Only invented demo fixtures authored by the synthetic persona and marked with the literal `Vera Example` belong here. The [architecture](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/architecture.md), [private-instance ownership](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/instance.md), and [deletion](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/deletion.md) contracts are canonical in selfos. Enable the committed pre-commit hook once per clone with `git config core.hooksPath .githooks`.

## Skills

Shared skills ship as the `sdd` plugin from the `selfos-skills` repo (a Claude Code plugin marketplace): `/plugin marketplace add jointsome0-lgtm/selfos-skills` (or the local checkout `~/projects/selfos-skills`), then `/plugin install sdd@selfos`. To grill the spec: `/sdd:grill-sdd`. If a needed skill is missing from a session, ask the user to install/update the plugin.
