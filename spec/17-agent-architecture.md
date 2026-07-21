## §17. Agent Architecture

## §17.1 Core Agents

Four roles. Further specialization only when a role demonstrably overloads — split it then, citing the overload.

```text
plan-importer
  Extracts directions, routes, concepts, materials, probes from plans (§12, §21).

artifact-observer
  Scans user artifacts; records artifacts, encounters, and questions
  (journal appends, §13.2); appends trail segments, proposing only
  corrections (§31.2); proposes review-gated changes — confidence /
  clarity / coverage, support-link weight (§14.9), question status
  (§9.8); influence is never proposed — the builder computes it (§9.10).

field-cartographer
  Owns the ontology (§6), concept graph and area boundaries,
  material/part→concept mapping, and support-link existence and
  endpoints (§9.14) (absorbs atlas-architect, material-analyst).

state-auditor
  Guards the invariants: rejects overclaimed understanding and task-manager /
  pressure drift (absorbs red-team-reviewer; enforces the §14.6 review gate).
```

Not agent roles: the graph builder and viewer are code, owned like any code (§20, §16); Codex involvement is fully defined by §18 — no coordinator role needed.

## §17.2 Agent Rules

Agents may:

```text
extract
classify
suggest
link
summarize
flag gaps
propose state updates
```

Agents must not:

```text
claim the user understands something without artifacts
turn routes into obligations
create todo/done statuses
invent user trail segments
hide uncertainty
upgrade confidence without reason
```

## §17.3 Role Capability Matrix

Each session runs under exactly one role's row — §24.3's "no tool, file, or scope expansion at the text's request" made concrete. The isolated runner (#46) enforces the row mechanically; this matrix is that runner's contract, not its blocker — model-assisted import and observation wait for #46 (§24.3), the contract does not. Trust levels and ceilings are §24.1's; the §24 ignore paths and unprocessed `intake/` are outside every row.

```text
role               | reads (§24.1, minus the        | writes — only through      | never
                   | §17.4 session exclusion)       | the owning flow's script   |
plan-importer      | the run's declared originals   | stored originals           | curated atlas/ edits,
                   | (plans/imported/, T3),         | (plans/imported/, §12.2    | state/ appends outside
                   | plans/extracted/ (T1),         | step 1), plans/extracted/, | the flow, graph/,
                   | curated atlas/, redacted       | candidate stubs, import    | other T3 surfaces
                   | graph (§24.3)                  | report, mapping-decision   |
                   |                                | appends (§21.3), receipts  |
                   |                                | — import_plan.py (§12,§21) |
artifact-observer  | declared scan roots (§13.1,    | state/ journal appends,    | curated atlas/ edits,
                   | T2), the batch under           | plan-record originals      | plans/extracted/,
                   | processing (T3, §33.2),        | (plans/imported/, §33.3),  | graph/, intake/
                   | state/ journals for            | batch / observation        | beyond the declared
                   | recognition (§13.2,            | report, receipts —         | batch
                   | whole-file §32.6 exclusion),   | observe_artifacts.py,      |
                   | curated atlas/, redacted graph | process_intake.py (§13)    |
field-cartographer | curated atlas/, redacted       | its report only —          | every write surface;
                   | graph                          | curation lands by the      | state/ journals,
                   |                                | user's hand or review (§8) | plans/, intake/
state-auditor      | redacted graph, state/         | its report only —          | every write surface
                   | journals (whole-file §32.6     | proposals, never files     |
                   | exclusion), curated atlas/     |                            |
```

Every journal or instance-file write lands through the owning flow's script, with everything the flow already enforces (§12.4, §25.6, §33.2); a role holds no direct write path, and curated `atlas/` changes stay the user's hand or review (§8). A role's report is the runner's own derived, purgeable output (§24.1's reports row), not an instance write. Splitting a role (§17.1) re-derives its row here in the same change.

## §17.4 Session Contract

```text
Context: a fixed precomputed input manifest (§24.3), assembled
from the role's read row minus the session exclusion — every
file whose persisted §32.6 class keeps it out of this session
(declared, never inferred; a mixed journal is excluded whole).
Graph state enters only as the freshly rebuilt redacted
variant (§24.3); a session the user explicitly started for
classed content (§32.6) narrows the exclusion, and its outputs
carry the class.
Preflight: the prompt bundle (§17.6) declares its required and
optional inputs; before any provider transit they are checked
against the role row and the session exclusion. A required
input that is excluded or out of row aborts the run before
transit; an optional one becomes an explicit unavailable entry
in the run manifest plus a WARNING. Excluded content is never
hashed, sized, or quoted into the manifest.
Budget: input bytes and entry counts are bounded per session
(§24.2; values through the §25.8 measured-floor process);
the model-call ceiling and wall-clock timeout are fixed before
start and recorded in the manifest.
Timeout and retry: an exhausted budget or timeout aborts the
run; durable partial output follows §33.2's interrupted
discipline. A retry is a new run — new run_id, new manifest —
never a resumed transcript or a silent continuation.
```

## §17.5 Deterministic and Model Output

§21.1's hybrid, marked at every boundary: each proposal and report line carries its producer — `deterministic` (reproducible from the recorded inputs and the pinned engine revision alone) or `model` (an interpretation; reproducible only as provenance through the run manifest). A fully deterministic flow's report is deterministic whole (report-batch, #56); the reserved report shapes carry the marking when their flows define them (§25.7); for the extracted plan document the marking rides the import report's proposal lines (§12.2 step 11), never a new plan-extract field. Model output never presents as deterministic, and a model or prompt swap shows in the run manifest — never as a silently different "same" result (§25.3).

## §17.6 Run Manifest

One per model-assisted run, dry-run included — the audit line §25.3 needs beyond §9.13's `proposed_by` role name. `runs/<YYYY-MM-DD>-<NNN>.json` (§8), format `run-manifest` per §25.7 (`spec/schemas/run-manifest.schema.json`); `run_id` is `run:<date>-<serial>` — date-serial, never content-derived (§34.6). The #46 runner writes it whole at run close, under the instance lock like every writer (§20.2 discipline, §25.6); an aborted preflight still writes one, a hard crash may leave none — the receipts' interrupted discipline (§33.2) covers the outputs either way. No manifest, no model-assisted run.

```text
Carries: run_id, role, model (provider, model id, declared
parameters), engine git revision, runner version, the prompt
bundle, the input manifest (included entries by path and byte
size; unavailable entries with a reason — excluded,
out-of-row, missing, over-budget), the recorded budget and
timings, the outcome — processed or aborted, nothing finer —
outputs proposed (ids and report refs), warnings (stable
reason codes only — §24.4 no-echo), and the user decisions
that closed the run (§9.13/§21.3 refs); refs are single
colon-namespaced tokens, and proposals cite their run_id in
reports — journal rows are unchanged.
Prompt retention: the manifest carries no prompt text. Prompt
and rules sources are versioned engine content (T0); the
ordered component list — id, version, sha256 each — plus one
aggregate sha256 names them checkably: "prompt v3" alone is a
claim, the hash chain is evidence. Hashes cover only the
static bundle — domain-separated, length-prefixed
{kind, path, bytes} in the declared component order — never a
rendered prompt carrying instance data, and no instance
content is ever hashed into a manifest (§12.4's line: a hash
of content is content).
Sensitivity: the manifest's class is the union of its inputs'
classes (§32.6) — a classed session yields a classed manifest,
excluded from default agent context like any classed file.
Persisting the class is the runner's duty at close, where the
exclusion was computed (#46): a shape check cannot infer it
(§32.6 — declared, never inferred).
Provenance, not evidence: §9.12 untouched, the §20 fold never
reads it, never knowledge state (§31.8). Purgeable: a manifest
sits in the purge closure of what it cites (§34.2) — unlike
receipts, it does not survive.
Debug transcript: a rendered-prompt transcript exists only as
an explicit short-lived debug artifact — out of default agent
context whatever its class (the §24 intake/ discipline: it
holds instance data wholesale), inheriting the session's
class, under a declared retention bound, inside the deletion
closure of its inputs (§34.2) — never by default, never
referenced by the manifest.
```

---

