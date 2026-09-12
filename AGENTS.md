# Atlas

Atlas records interactions with learning materials through one Rust CLI. Read GOALS.md, the Map in README.md, then the relevant code and tests.

## Three sources of truth

Git holds history and reasons. Code defines current behavior. GOALS.md holds direction and tested invariants; each numbered goal names exactly one integration test file in tests/*.rs, and every such file belongs to exactly one goal. Do not add design documents, decision logs or completed-work reports.

## Work

Make changes in an assigned branch and .worktrees/<task> worktree. Only the coordinating session accepts changes into main. Preserve ordinary Git history. Do not push or publish without an explicit request. Keep changes within the requested scope; do not add abstractions for hypothetical consumers.

## Data

This is a public code repository. Real records stay in an explicitly selected private directory outside the checkout. Do not commit personal records, credentials, machine-local paths or session transcripts. Test data is invented and marked with the literal Vera Example. Saving a reference does not establish reading or understanding. Preserve the stated actor without inferring one from who invokes the CLI. The limits check rejects known private paths and file types and checks standalone fixture markers; review remains necessary because these checks do not identify every personal fact.

The owner's 2026-07-25 decision accepts provider transit for Atlas records; encryption at rest and self-hosted inference are not prerequisites. This does not authorize credential disclosure or moving private records into public code.

## Limits

CI checks a 70,000-token repository budget, counted as tracked bytes divided by four except LICENSE and lockfiles. The limit is not raised in a change that needs room. README Map has exactly one line per visible directory, at most 250 characters. Only README.md, AGENTS.md, GOALS.md and CLAUDE.md may be Markdown files. Tracked symlinks are forbidden.

The limits entrypoint is scripts/limits.py. It checks repository structure and public Git hygiene, uses Cargo to discover runnable integration tests, and calls examples/check_limits.rs for Rust syntax, comment and source-inclusion checks. tests/limits.rs exercises this checker and its failure cases. Test files use the executable; they do not import or include implementation files. Tests live in tests/*.rs, with no test modules in src/. Cargo formatting, lint with warnings denied and the goal tests must pass in CI. The pre-commit hook runs the same limits check. A checker failure is fixed rather than silenced.
