# Atlas goals

Long term: keep an honest record of how people and agents interact with materials, as a source for a future learning map.

Short term: ship the Rust CLI with explicit actors, editable JSON records and independent Focus/Later marks. All fixtures are invented and marked Vera Example.

## Invariants

1. A record preserves an exact material reference, explicit actor, stable ID, recording time and supplied statement. Bare references infer no action. Explicit corrections and deletion survive process restart. `tests/records.rs`

2. Focus and Later are mutually exclusive current marks on exact material references. Clearing and filtering never rewrite interactions; All includes every live interaction. `tests/marks.rs`

3. Atomic writes, coordinated processes and revision checks prevent partial records and silent stale overwrites. Uncertain creation has a documented recovery route, deleted IDs cannot resurrect records, and malformed storage fails visibly. `tests/reliability.rs`

4. The repository enforces its 70,000-token budget, directory map, Markdown allowlist, no tracked symlinks, Rust comment ban and goal-to-public-test bindings. `tests/limits.rs`

## Scope

Real records belong outside this public code checkout. Saving a reference never claims reading or learning. No source fetching, scheduling, automatic mark transitions, scoring, map, server, UI or agent-specific mode belongs in this version.
