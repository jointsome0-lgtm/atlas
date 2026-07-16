## §33. External Exchange

Atlas lives among peer systems it never learns: subsystems stay mutually blind, and adapters — living outside atlas, in whatever shell composes the systems — translate between a peer's world and atlas's generic boundary formats. No peer schema or shell-specific code appears in atlas, and atlas never interprets peer identity: a delivery's `source` label (§33.2) is an opaque namespace atlas never branches on. The outward surface is exactly three: activity-ledger and plan intake (§33.2–§33.3), the state snapshot (§33.4), and the embeddable viewer (§16.4). Design pass 2026-07-06 (#19).

## §33.1 Exchange Model

```text
Blind by construction: the formats speak atlas's own vocabulary —
record kinds are the §9.12 evidence kinds plus plan documents,
scale values are atlas's scales (§9.6, §9.7, §14, §32.2–§32.3).
Translation burden is the adapter's; atlas never learns a peer's
schema.
Two lanes: structured (atlas vocabulary, deterministic) and
verbal (free text — the observer interprets: §21's hybrid at the
boundary). An adapter that cannot map its vocabulary uses the
verbal lane, never an approximation.
Inward = evidence and plans, never state: no state, no
decisions, no trail segments cross in. Understanding is not
imported (§31.3): an external claim — a diary line "I think I
understood X", a foreign mastery score — arrives as artifact
text and moves state only through the §14 rules. A plan record
is the one non-evidence kind (§9.12 excludes plans): it enters
§12 and creates candidate structure, never state (§33.3).
Outward = state as evidence: qualitative characterization with
provenance, never a verdict, score, or ranking (§4, §31.1);
consumers apply their own semantics downstream.
User-initiated only (§31.7): atlas polls no peer and pushes no
snapshot; an adapter delivers files, the user runs the flow (§24).
No third pipeline: plan records enter §12, everything else enters
§13; the snapshot is emitted from the §20 fold output. The
boundary adds no state semantics.
Versioned: each format carries format + integer version. Additive
change is the norm; a rename, removal, or semantic change bumps
the version through a Decision Log entry. Consumers must ignore
unknown fields; atlas never silently drops what it cannot place
(§33.2).
```

## §33.2 Intake: Activity Ledger

An adapter delivers a batch file under `intake/<source>/` (§8); the user runs the observer over it. Batches stay as delivered — the audit original, like `plans/imported/` (§12.2 step 1) — and are never scanned by the boundary checker (§19): a foreign system's voice may say `done` freely; what atlas makes of a batch is already structure-scanned in `state/`. For the same reason the originals never enter default agent context (§24): a raw export may carry §32.6-class text whether or not its records were marked — the one reader is the user-initiated flow processing it (§31.7).

Envelope:

```json
{
  "format": "atlas-intake",
  "version": 1,
  "source": "watch-sync",
  "batch": "2026-07-06-001",
  "records": []
}
```

Records — the §9.12 evidence kinds, plus `plan` (§33.3):

```json
{"kind": "encounter", "date": "2026-07-05", "target": {"url": "https://redis.io/docs/develop/"}, "depth": "read"}
{"kind": "artifact", "date": "2026-07-05", "type": "note", "text": "I think I understood consumer groups; rebalancing still fuzzy.", "refs": [{"title": "Kafka: The Definitive Guide"}]}
{"kind": "question", "date": "2026-07-05", "text": "when does a rebalance drop uncommitted offsets?"}
{"kind": "artifact", "date": "2026-07-06", "type": "session-log", "text": "swim 45min: 4x50 catch drills, 1500 free; HR avg 132", "sensitivity": "medical"}
```

Rules:

```text
References (target, refs) are {id} — an id learned from a
snapshot — or {url} / {title} / {text}. Resolution is the
observer's job: match an existing node, else a candidate node
through §21's review step, else an open item in the batch report.
Scale values (depth, evidence_strength) are atlas's own scales;
anything unmappable goes down the verbal lane (§33.1).
source is an opaque namespace, fixed when the user configures
the adapter: beyond the syntax and reservation checks below,
atlas attaches no semantics to it and never branches on it —
it scopes the intake/ path, provenance, and idempotency,
nothing else. The user may name it after a peer —
user's voice, like a diary line naming a brand; atlas's
blindness is that it cannot tell.
source and batch are slugs — lowercase letters, digits, hyphens
— so intake/<source>/ paths and <source>/<batch>#<n> receipt
keys parse unambiguously by construction; no escaping scheme
exists. A delivery violating this is refused in the batch
report, like a content-mismatched batch id. import and observe
are reserved — the direct lanes' receipt namespaces (§12.4,
§13.2) — and a delivery claiming either source is refused the
same way. A source expected
to deliver §32.6-classed records takes a neutral slug (feed-1,
not a provider or subject name) and date-serial batch ids
(2026-07-14-001 — the §34.6 pattern, mirrored here): both
survive purge by design in provenance refs and receipts
(§34.2, §34.6), so a telling slug would put the class in
every one of them — an adapter-contract convention atlas
cannot enforce, source being opaque.
Records carry their activity dates: backfill is normal —
last_seen and freshness follow the record's date, not delivery.
Processing is the §13 flow verbatim: journal appends, trail
segments derived (§13.2 step 9), review-gated proposals through
§14.6. A batch claiming broad deep exposure (dozens of applied)
is §13.2 step 10's high-impact ask, never a silent write.
Provenance: every journal row created from a batch carries
intake: "<source>/<batch>#<n>" — n the record's position in
records — the §25.3 audit line from journal entry back to the
delivered line. A batch id names one immutable delivery: the
same id arriving with different content is refused in the batch
report; a corrected batch is a new id.
Receipts: state/receipts.jsonl (§8) holds a pair per record —
opened {intake, date} appended before any output, processed
{intake, date} appended after the last one. The journal is
named for the record kind, not the lane: every flow running
this receipt discipline shares it — intake batches under
<source>/<batch>#<n>, direct plan import under
import/<date-serial>#0 (§12.4), observation runs under
observe/<date-serial>#<n> (§13.2). A receipt key never
derives from content: receipts survive purge (§34.2), and a
content hash on a surviving row is the digest registry §34
rejects — date-serial is the pattern (§34.6). The pair is
durable in order: opened is fsynced before any output, every
output — journal rows and file renames alike — is durable
before processed is fsynced; only then may a run report
success. The schema is
closed — the idempotency key, the marker, the date, nothing
else: receipts survive every rewrite deliberately (§34.2), so
the row is content-free by construction, never by care. What
a record appended is recoverable from the journal rows' own
intake: keys; what went to the report lives in the batch
report — a derived, purgeable artifact, never the receipt.
The marker is not named done: state/ is atlas's own voice,
structure-scanned by §19, where §4 bans the term as data —
the boundary's bookkeeping obeys the law it enforces. Receipt
rows are provenance, not evidence: §9.12 is untouched and the
§20 fold never reads them. processed also covers records
whose outputs are not journal rows — a plan record's outputs
are files and report lines (§33.3).
Idempotency is per receipt: a record is handled iff its
processed row exists — re-delivering a batch appends nothing, a
run that stopped mid-batch resumes at the first record without
one. An opened row without processed is an interrupted record,
whatever its outputs — journal rows, an original under
plans/imported/, candidate files (§12) — and is never silently
reprocessed or overwritten: the observer is an interpreter
(§21), a second pass may read the record differently, so the
partial surfaces in the batch report for the user to resolve
(§13.2 step 10 discipline).
Nothing is silently dropped: the batch report lists every record
that could not be resolved or placed (§12.2 step 11 discipline).
Sensitivity is declared, never inferred: source is opaque, so a
record carrying §32.6-class content says so — sensitivity:
"medical" on the record, or on the envelope as the batch-wide
default (a record's own value wins). Values are the §32.6
classes — today exactly {medical}; a new class is a Decision
Log entry. Classifying is part of the adapter's translation
burden (§33.1): health telemetry — HR, labs — is medical per
§32.4; the verbal lane is classed by the observer at
interpretation, like any diary line. The observer persists the
class onto every journal row derived from the record — the bit
the §33.4 default exclusion and the §32.6 agent-context rule
follow. Tier-2 body capture arrives through this format (§32.4).
```

## §33.3 Intake: Plans

A `plan` record — inline `text` or a `ref` to a delivered file — enters §12 unchanged: the original lands under `plans/imported/`, the §12.2 steps apply, structure is created and state never is (§31.3); plan self-claims surface only in the import report (§12.2 step 11). A route from an external plan is an ordinary SuggestedRoute: optional, hideable, ignorable (§5.1).

A sensitive plan (§33.2's marker) keeps its class across the copy: the original lands under `plans/imported/<class>/` — placement, never an edit, an as-delivered document stays byte-identical — and the SuggestedRoute built from it carries `sensitivity: <class>` in frontmatter; the §32.6 default-context exclusion follows both (the batch original under `intake/` is already covered, §24). Candidate concept stubs from a classed input carry the class like the route — `sensitivity: <class>` in frontmatter — so everything already keyed to the class follows without a new mechanism: §34.6 gives the stub a date-serial id at creation (the title stays in the body — content, purged with it), the §33.4 default exclusion keeps it out of snapshots, and §34.2 keeps it in the input's purge closure while the input is its only provenance. The user adopts a stub by re-authoring it as their own (§5.2) — that curation deliberately removes the class and takes the stub out of the closure. Stubs from unclassed inputs stay plain — there, ids and links are structure; when the source is classed, a slug derived from its text is content (the 2026-07-06 rule, scoped — Decision Log 2026-07-15).

## §33.4 Export: State Snapshot

An emitted view, not a store: `scripts/export_snapshot.py` writes `graph/atlas-snapshot.json` (§8) on the user's explicit run — never on a schedule, never pushed (§24, §31.7). Atlas never reads a snapshot back: the journals stay the only truth, each export is a full regeneration, and §31.8 stands — the snapshot is the same derived class `graph/` already holds.

```json
{
  "format": "atlas-snapshot",
  "version": 1,
  "generated_at": "2026-07-06T00:00:00Z",
  "withheld": {"state": 0, "materials": 0, "trail": 1, "questions": 0, "evidence_refs": 1},
  "scales": {
    "concept": {
      "exposure": ["unseen", "touched", "read", "summarized", "applied", "taught"],
      "confidence": ["unknown", "low", "medium", "high"],
      "clarity": ["vague", "rough", "stable", "disputed"],
      "coverage": ["none", "partial", "broad"],
      "freshness": ["fresh", "aging", "stale"]
    },
    "material": {"depth_reached": ["skim", "read", "summarized", "applied", "taught"]},
    "pattern": {
      "exposure": ["unseen", "touched", "studied", "tried", "drilled", "reviewed"],
      "confidence": ["unknown", "low", "medium", "high"],
      "clarity": ["vague", "rough", "stable", "disputed"],
      "coverage": ["none", "partial", "broad"],
      "freshness": ["fresh", "aging", "stale"]
    },
    "zone": {
      "contact": ["unseen", "touched", "loaded", "probed"],
      "strength": ["unknown", "low", "medium", "high"],
      "endurance": ["unknown", "low", "medium", "high"],
      "mobility": ["unknown", "low", "medium", "high"],
      "condition": ["unknown", "fine", "irritated", "recovering", "restricted", "chronic"],
      "freshness": ["fresh", "aging", "stale"]
    }
  },
  "evidence_refs": {
    "artifact:test-duplicate-post-idempotency": {"kind": "artifact", "date": "2026-06-05"},
    "encounter:2026-06-05-fastapi-ch3": {"kind": "encounter", "date": "2026-06-05"},
    "artifact:create-job-endpoint": {"kind": "artifact", "date": "2026-06-05"}
  },
  "state": {
    "concept:idempotency": {
      "exposure": "applied",
      "confidence": "medium",
      "clarity": "rough",
      "coverage": "partial",
      "freshness": "fresh",
      "last_seen": "2026-06-05",
      "evidence": ["artifact:test-duplicate-post-idempotency"],
      "decisions": [{"dimension": "confidence", "date": "2026-07-04", "evidence": ["artifact:test-duplicate-post-idempotency"]}]
    }
  },
  "materials": {"material:fastapi-tutorial": {"depth_reached": "summarized", "last_seen": "2026-06-05", "evidence": ["encounter:2026-06-05-fastapi-ch3"]}},
  "trail": [{"id": "trail-segment:2026-06-05-001", "date": "2026-06-05", "from": "concept:rest-api", "to": "concept:idempotency", "via": ["artifact:test-duplicate-post-idempotency"]}],
  "questions": [{"id": "question:201-vs-202", "text": "When should POST /jobs return 201 vs 202?", "status": "open", "pulls": ["concept:http-status-codes"], "source": ["artifact:create-job-endpoint"]}]
}
```

The included set is closed — extending it is a Decision Log entry, made when a real adapter asks (§28.3):

```text
per-node derived state on the node's own scales — freshness and
last_seen included, honest derived facts (§14.5–§14.7);
material contact state (§14.8), with its evidence refs like any
state entry;
trail segments as recorded (§9.9);
open questions, with their source evidence ids (§9.8);
evidence refs — one home, no exceptions (#27): every
evidence-bearing field (state and decision evidence, trail via,
question source) holds ids only; each §9.12 evidence id among
them resolves in the top-level evidence_refs table to {kind,
date} — content stays home, and §33.1's provenance promise holds
for every evidence ref in the file; the curated node ids via may
also carry (§9.9 — a material part) are node refs, not evidence
(§9.12), and are never table entries;
the confirmed decisions behind gated dimensions (§9.13) — node
and material targets only in v1: an edge-target decision
(dimension: weight, §14.9) is excluded until a real adapter asks
(§28.3) — the format has no edge section and no weight ladder,
and this section's own rule makes a value whose ladder is absent
malformed;
per-section withheld counts: withheld maps every content section
to the count of entries wholly or partly kept home by the §32.6
default exclusion or a per-export choice — counts only, never
ids; always present, an all-zero map is the honest "complete";
the scales themselves, complete per node kind: every dimension
an exported entry carries has its ladder under scales — the
motor exposure ladder (§32.3) beside the knowledge one, the full
zone set (§32.2), the §9.7 depth ladder for material contact — a
snapshot emitting a value whose ladder is absent is malformed; a
consumer never hardcodes a ladder, and per-domain scale
evolution (§25.5) is not a breaking change.
```

Excluded:

```text
by construction — aggregates, scores, percentages, ranks,
completion measures: the format has no field for them (§4,
§31.1), and graph/ structure scanning (§19) bans the key stems;
always — pending proposals (derivable, never stored — §31.8);
frontier items and route suggestions: suggestions address the
user in the viewer (§15, §16.4) — re-presented downstream they
are a todo list (§31.6);
by default — the §32.6 sensitivity class, applied by provenance,
not by section (§32.6 states the taint rule once — union by
provenance; this exclusion is its export instance): the class
travels from an evidence record to everything derived from it —
state and decisions resting on it (zone condition), the evidence
refs themselves, trail segments citing it in via, questions
extracted from it, contact state of medical materials — so no
snapshot section leaks it; the withheld counts disclose that it
stayed home; any of it enters a snapshot only by the user's
explicit per-export choice (§32.6 declassification).
```

Stability: node ids are stable slugs (§10.1) and persist across snapshots; a consumer must tolerate an id that vanishes — deletion is the owner's right (§5.2, §34), the same tolerance §20 requires of the builder. Id retirement resolves inside atlas (§34.4): a snapshot exports living ids only; no redirect map is exported until a real adapter asks (§28.3).

---
