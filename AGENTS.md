# atlas — agent instructions

The design reference is `SDD.md` (map) + `spec/` (body, one file per §). It documents what Atlas is; it does not gate when code may change. Atlas is under a **partial freeze**: the named knowledge-domain slices in §29 may be implemented through their owning issues and prerequisites, while Body Atlas implementation remains frozen under atlas#45.

## How work happens

- Default: issue → PR. No spec edit unless the PR moves a documented contract.
- A PR that moves a documented contract updates the owning § file in the same PR.
- Trade-offs get one Decision Log line; the rationale lives in the issue or commit.
- § numbers are stable anchors: never renumber, never reuse a retired number.
- Findings and open questions go to GitHub issues, never to committed report files.
- Design before code only where reversal is expensive: schemas, deletion and
  lifecycle semantics, cross-repo contracts.

## Canon

Specification: `SDD.md` is the map (§ index and numbering rules); the body lives in `spec/` (one file per §, file names start with the § number); decisions live in `DECISION-LOG.md`. The map is imported into session context (line below); @-importing the body or the log is forbidden:
- point task → pick the § from the map's index and read only its file in `spec/`;
- full read (all of `spec/` in index order) — only for full-pass reviews or cross-section decisions.

@SDD.md

## Public data boundary

This is a public engine repository. All real data lives in a private instance repository outside this checkout. Only invented demo fixtures authored by the synthetic persona and marked with the literal `Vera Example` belong here. The [architecture](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/architecture.md), [private-instance ownership](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/instance.md), and [deletion](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/deletion.md) contracts are canonical in selfos. Enable the committed pre-commit hook once per clone with `git config core.hooksPath .githooks`.

## Privacy posture

Owner decision, 2026-07-25 (Decision Log): provider transit is accepted for every Atlas record class, §32.6-classed medical records included — the model is the owner's machine plus the chosen provider's retention terms (§24.3), and encryption at rest is deployment hygiene, never an Atlas gate (§24). Do not raise encryption at rest, provider transit on owner-confidentiality grounds, or self-hosted inference as an obstacle, a precondition, or a standing caveat: the decision is made and dated, and re-deriving it each session is friction, not diligence.

Untouched by that decision, because they address independent risks: §24.3's credential preflight before transit — which still aborts a session on a hit, transit acceptance notwithstanding — §24.1–§24.2 input hardening and reader containment, and §32.6's exclusion of classed rows from this public checkout and from contexts that have no use for them.

## Skills

Shared skills install from the `selfos-skills` repo (an Agent Skills catalog): `npx skills add jointsome0-lgtm/selfos-skills --skill grill-sdd slice --agent claude-code --global --yes` (full catalog: `--skill '*'`). To grill the spec: `/grill-sdd`. If a needed skill is missing from a session, ask the user to install/update it with the same command.

Git worktrees: create them only in `.worktrees/<name>` inside the repo (globally gitignored via `~/.config/git/ignore`), never as sibling directories. Any work that will open a PR branches and builds in such a worktree, never in the primary checkout — the primary checkout stays on a clean `main` so parallel sessions don't fight for its index. Trivial read-only work and single-file doc edits on a clean main need no worktree. Remove the worktree and delete its local branch once its PR merges.

## Style

- Avoid code comments unless explicitly asked to add comments.
- Deliver what was asked, at the scope asked — no extra features,
  refactoring, or abstractions beyond the task.
- In prose (PR text, docs, summaries): lead with the outcome, cut
  anything that doesn't change what the reader does next.
