## §33. External Exchange

Atlas lives among peer systems it never learns by name: subsystems stay mutually blind, and adapters — living outside atlas, in whatever shell composes the systems — translate between a peer's world and atlas's generic boundary formats. No peer name, peer schema, or shell-specific code appears in atlas. The outward surface is exactly three: activity-ledger and plan intake (§33.2–§33.3), the state snapshot (§33.4), and the embeddable viewer (§16.4). Design pass 2026-07-06 (#19).

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
Inward = evidence only: no state, no decisions, no trail segments
cross in. Understanding is not imported (§31.3): an external
claim — a diary line "I think I understood X", a foreign mastery
score — arrives as artifact text and moves state only through
the §14 rules.
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

An adapter delivers a batch file under `intake/<source>/` (§8); the user runs the observer over it. Batches stay as delivered — the audit original, like `plans/imported/` (§12.2 step 1) — and are never scanned by the boundary checker (§19): a foreign system's voice may say `done` freely; what atlas makes of a batch is already structure-scanned in `state/`.

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
{"kind": "artifact", "date": "2026-07-06", "type": "session-log", "text": "swim 45min: 4x50 catch drills, 1500 free; HR avg 132"}
```

Rules:

```text
References (target, refs) are {id} — an id learned from a
snapshot — or {url} / {title} / {text}. Resolution is the
observer's job: match an existing node, else a candidate node
through §21's review step, else an open item in the batch report.
Scale values (depth, evidence_strength) are atlas's own scales;
anything unmappable goes down the verbal lane (§33.1).
Records carry their activity dates: backfill is normal —
last_seen and freshness follow the record's date, not delivery.
Processing is the §13 flow verbatim: journal appends, trail
segments derived (§13.2 step 9), review-gated proposals through
§14.6. A batch claiming broad deep exposure (dozens of applied)
is §13.2 step 10's high-impact ask, never a silent write.
Provenance: every journal record created from a batch carries
intake: "<source>/<batch>#<n>" — n the record's position in
records — the §25.3 audit line from journal entry back to the
delivered line. A batch id names one immutable delivery: the
same id arriving with different content is refused in the batch
report; a corrected batch is a new id. Idempotency is per
record: processing appends only records whose intake key no
journal holds yet, so re-delivering a batch appends nothing and
a run that stopped mid-batch resumes at the first unrecorded
record.
Nothing is silently dropped: the batch report lists every record
that could not be resolved or placed (§12.2 step 11 discipline).
Device and health telemetry inherits the §32.6 sensitivity class;
tier-2 body capture arrives through this format (§32.4).
```

## §33.3 Intake: Plans

A `plan` record — inline `text` or a `ref` to a delivered file — enters §12 unchanged: the original lands under `plans/imported/`, the §12.2 steps apply, structure is created and state never is (§31.3); plan self-claims surface only in the import report (§12.2 step 11). A route from an external plan is an ordinary SuggestedRoute: optional, hideable, ignorable (§5.1).

## §33.4 Export: State Snapshot

An emitted view, not a store: `scripts/export_snapshot.py` writes `graph/atlas-snapshot.json` (§8) on the user's explicit run — never on a schedule, never pushed (§24, §31.7). Atlas never reads a snapshot back: the journals stay the only truth, each export is a full regeneration, and §31.8 stands — the snapshot is the same derived class `graph/` already holds.

```json
{
  "format": "atlas-snapshot",
  "version": 1,
  "generated_at": "2026-07-06T00:00:00Z",
  "scales": {
    "concept": {
      "exposure": ["unseen", "touched", "read", "summarized", "applied", "taught"],
      "confidence": ["unknown", "low", "medium", "high"],
      "clarity": ["vague", "rough", "stable", "disputed"],
      "coverage": ["none", "partial", "broad"],
      "freshness": ["fresh", "aging", "stale"]
    },
    "zone": {"contact": ["unseen", "touched", "loaded", "probed"]}
  },
  "state": {
    "concept:idempotency": {
      "exposure": "applied",
      "confidence": "medium",
      "clarity": "rough",
      "coverage": "partial",
      "freshness": "fresh",
      "last_seen": "2026-06-05",
      "evidence": [{"id": "artifact:test-duplicate-post-idempotency", "kind": "artifact", "date": "2026-06-05"}],
      "decisions": [{"dimension": "confidence", "date": "2026-07-04", "evidence": ["artifact:test-duplicate-post-idempotency"]}]
    }
  },
  "materials": {"material:fastapi-tutorial": {"depth_reached": "summarized", "last_seen": "2026-06-05"}},
  "trail": [{"id": "trail-segment:2026-06-05-001", "date": "2026-06-05", "from": "concept:rest-api", "to": "concept:idempotency", "via": ["artifact:test-duplicate-post-idempotency"]}],
  "questions": [{"id": "question:201-vs-202", "text": "When should POST /jobs return 201 vs 202?", "status": "open", "pulls": ["concept:http-status-codes"]}]
}
```

The included set is closed — extending it is a Decision Log entry, made when a real adapter asks (§28.3):

```text
per-node derived state on the node's own scales — freshness and
last_seen included, honest derived facts (§14.5–§14.7);
material contact state (§14.8);
trail segments as recorded (§9.9);
open questions;
evidence refs (id, kind, date — content stays home) and the
confirmed decisions behind gated dimensions (§9.13);
the scales themselves: the document is self-describing, a
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
not by section: the class travels from an evidence record to
everything derived from it — state and decisions resting on it
(zone condition), the evidence refs themselves, trail segments
citing it in via, questions extracted from it, contact state of
medical materials — so no snapshot section leaks it; any of it
enters a snapshot only by explicit per-export choice.
```

Stability: node ids are stable slugs (§10.1) and persist across snapshots; a consumer must tolerate an id that vanishes — deletion is the owner's right (§5.2), the same tolerance §20 requires of the builder.

---
