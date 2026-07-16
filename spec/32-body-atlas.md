## §32. Body Atlas — Second Domain Instantiation

The body domain instantiates the §25.5 domain rule: same core, its own field semantics, scales, and capture — nothing here forks the core.

One derived graph serves both domains. The body model is a viewer projection, not a data entity: the silhouette is curated content — a `zone → figure region` mapping holding no state, authored as `figure_region` in each zone's frontmatter (§8: one mapping, no second registry of zones) and embedded by the builder into the emitted graph (§20 step 12, §10), so the viewer's single input stays single (§16.4); the figure artwork itself is a viewer asset, like its stylesheet. Indicators (influence, freshness, condition) are rendered onto the regions at view time from the fold output (§31.8). A domain brings its own field geometry: knowledge has none (force-directed layout), the body is anatomical.

## §32.1 Field: Zones and Patterns

Two region kinds, one graph:

```text
zone    = anatomical/functional region (shoulders, lats, hips,
          low back…) — carries adaptation and condition; medical
          evidence attaches here; has silhouette geometry
pattern = movement skill (freestyle stroke, freestyle catch,
          squat, bench press…) — carries technique understanding,
          questions, clarity; node-link geometry, like concepts
```

Patterns are concept-kind nodes, not materials: technique is understanding of a movement, and material state is contact only (§14.8). The pattern→zone link is the same species as `concept_edges` (§9.3): an authored edge with `role: loads` and a gated weight (§14.9), authored in the pattern's frontmatter as a part authors its `concept_edges`.

Materials stay materials — programs, technique videos, methodology articles. A program part maps to patterns like a chapter maps to concepts:

```text
material:program-x/squat-block ──concept_edges──▶ pattern:squat
pattern:squat ──loads: high──▶ zone:hips
pattern:squat ──loads: medium──▶ zone:low-back
```

## §32.2 Zone State

```yaml
zone:
  contact:   unseen | touched | loaded | probed   # monotone ladder (§14.5 machinery):
                                                  # never targeted / incidentally loaded /
                                                  # trained directly / measured by a probe
  strength:  unknown | low | medium | high        # capacities — review-gated (§14.6);
  endurance: unknown | low | medium | high        # probes, diary numbers, and medical
  mobility:  unknown | low | medium | high        # records are the evidence
  condition: unknown | fine | irritated | recovering | restricted | chronic   # gated; §32.6
  freshness: fresh | aging | stale                # derived from last load (§14.7)
```

Contact moves by the §14.5 machinery over the §9.6 strengths, mapped structurally — by what the evidence did to the zone, not what it says:

```text
touched = in a session artifact's touches, or behind a weaker
          (medium/low/unassessed) loads edge from a performed or
          drilled pattern — incidental load
loaded  = named in the artifact's supports_state_updates
          (targeted work), or behind a loads: high edge from a
          performed/drilled pattern (§32.1, §14.9)
probed  = an artifact answering a probe on the zone (§9.11)
```

Encounters and study artifacts never move contact: reading about a zone is not loading it — they feed material state (§14.8) and pattern study (§32.3).

**No decision means no knowledge (§14.6).** With no confirmed decision the gated zone dimensions fold to `unknown` — capacities and `condition` alike. `fine` is a positive medical claim ("nothing is wrong here"), exactly as gated as `chronic`: it enters only through a confirmed decision citing measurement evidence, so an implicit `fine` is unrepresentable and an unexamined zone never renders as a healthy one (#38).

**Down through a probe, never through a curve.** Freshness shows the fact of no contact — always, honestly. Capacity and condition move down only through the gate, on measurement evidence: a probe artifact, a diary line, a medical record. The honest route down is the chain: staleness (visible fact) → probe invitation (frontier) → measurement (artifact) → evidenced proposal → user decision.

**`chronic` lives in shadow.** A permanent condition (old injury, standing precaution) renders as a subtle shading on the silhouette, visible on focus — never an alarm badge or a permanent red flag (§25.4). But it is always on the table at suggestion time (§32.5). Care notes ("overhead pressing — cautious") are curated markdown in the zone file, like §9.1 concept-file sections — no schema. Leaving `chronic` (or `restricted`) is proposed only on medical evidence, through the gate.

## §32.3 Pattern State

Technique is understanding of a movement: patterns take the knowledge scales (§14.2–§14.4) verbatim — confidence (executes reliably across contexts: pool vs open water, fresh vs fatigued), clarity (model of the movement; `disputed` = technique schools conflict), coverage (facets: breathing on both sides, paces, turns), freshness. Only the exposure ladder is domain-worded:

```text
unseen   = in the graph, never met
touched  = learned it exists; light contact
studied  = worked through the technique (video, article, coach's cue)
tried    = performed it
drilled  = deliberately practiced it
reviewed = technique survived external review (coach, video analysis)
```

`tried` ranks above `studied`: doing is deeper contact than reading — a motor skill is not a text. The ladder is monotone via max; §14.5 machinery unchanged. Years of swimming with no technique work reads as `tried` + `clarity: vague` — much done, little understood.

The §9.6 strengths map to the ladder — the mapping lives here, beside it (§14.5):

```text
noticed                       → touched
read / summarized / explained → studied
applied                       → studied
performed                     → tried
drilled                       → drilled
performed|drilled + reviewed  → reviewed
```

Paper work is study for a motor skill: a program note applying squat theory moves `studied`, never `tried` — only `performed`/`drilled` session evidence (§32.4) means doing. `reviewed` requires the performance reviewed (coach's eye, video analysis), not an explanation of it. Encounters raise motor exposure to at most `studied` — §14.5's read-cap, domain-worded.

## §32.4 Capture: the Diary Is the Only Evidence Source

Intake is the one observer flow (§13) over a three-tier spectrum; nothing is mandatory, richer input only sharpens proposals:

```text
tier 0 (the floor — sacred): one free line, ≤30 seconds
       "45 min: catch drills 4×50, then 1500 free; elbow drops
        on right-side breathing"
tier 1: semi-structured log — exercises, weights, reps,
        sensations, session flow
tier 2: device export (watch: HR, laps, duration) — through the
        generic intake boundary (§33.2)
```

Rules:

```text
A week without entries is not an event: freshness ages, nothing
else happens (§25.4). Any trace counts; absence of trace counts
as nothing.
Diary numbers are measurements: "squat 80×5×5" is evidence for
capacity proposals (§14.6). Probes stay curated deliberate tests
(§9.11) — a 1RM attempt, a timed 200m; the everyday log is the
background signal between them.
Sensations are first-class evidence: "shoulder ached on press" →
condition proposal citing that line; "felt heavy" is RPE, not
lyric. The observer extracts questions ("why does the elbow
drop?") — questions are evidence (§9.12).
A training day is a star-shaped trail day (§9.9): N landings
sharing the session's via.
Device data: imported only on user initiative (§31.7); telemetry
is evidence only — never goals, streaks, rings, or weekly targets
(`streak` is checker-banned, §19). Health telemetry (HR) inherits
the medical sensitivity class (§32.6) — declared by the adapter
at intake (§33.2), never inferred from source.
No mandatory fields, ever.
```

## §32.5 Frontier: Five Suggestion Kinds

Body frontier items, same §15 machinery:

```text
stale_zone / stale_pattern — fact of no contact ("shoulders: no
                             load in 60 days")
probe_invitation           — the honest route down ("a timed 200m
                             is available")
open_question              — "elbow on right-side breathing —
                             still unresolved"
untried_adjacent_pattern   — butterfly untouched while freestyle
                             is drilled
imbalance                  — pressing grows while its antagonist
                             sits in shadow
```

Imbalance speaks plainly under the honest-lever rule (§15.3): a real structural edge, the user's own declared direction or question as the anchor, cited evidence — "if the goal is pressing: the back is the real lever; no rowing in 6 weeks (diary)". Deficit against population norms stays forbidden.

**Suggestion-time constraints** (a per-domain surface, §25.5): route import and frontier generation read zone `condition`. A step loading a `chronic`/`restricted` zone is neither silently dropped nor silently passed — it surfaces in the import report flagged "loads a chronic zone — adapt?", and the user decides (§31.3 discipline).

## §32.6 Medical Layer

Medicine decomposes onto the existing ontology — no new subsystem, no second graph:

```text
reference knowledge (anatomy maps, contraindication rules)
    = curated content, no state — like the silhouette mapping
measurements and diagnoses (lab report, doctor's note)
    = probe-linked artifacts (§9.6, §9.11) — evidence
current condition ("shoulder: impingement, active")
    = derived by the fold from that evidence (§31.8)
individual development map
    = SuggestedRoute over the body field respecting condition
      (§32.5) — route machinery unchanged
```

Medical evidence ages per §14.7; a frontier re-probe invitation stays adjacency wording, never obligation (§31.6).

**Atlas characterizes; it never diagnoses or prescribes.** Derived condition is a characterization of recorded evidence, never a diagnosis; suggestions stay propose-and-decide (§32.5); moving any class boundary — declassification included — is the user's explicit act, never an inference (§33.4).

**Sensitivity class — taint is union by provenance.** The class is per-row, never per-journal: §33.2 persists it onto every journal row derived from a classed record, §33.3 onto imported routes and stubs, §34.6 shapes the ids. From there it travels to everything derived from a classed row: a derived value is classed iff any record in its provenance is classed — fold output (a `condition` resting on a medical row), influence sources, frontier items citing classed evidence, graph entries, snapshot sections. This is the rule's one statement (#38): §33.4's default exclusion is its export instance, §20 step 12 emits under it, §10.4 defers to it. The taint roots are exactly the persisted classes — classed journal rows (§33.2) and classed curated files (§33.3); curation is the owner's own voice, and re-authoring content as one's own deliberately removes the class (§33.3 adoption) — so a care note in a zone file (§32.2) is unclassed by construction, and content that must stay classed stays in classed records, never re-authored into curation.

The class keeps classed content out of default agent context (§24, §31.7 discipline): a mixed journal or a derived file containing classed rows or values inherits the exclusion whole — it enters only a session the user explicitly started for it. An agent-facing build is therefore produced by the builder's explicit redaction flag (§20 step 12), never by hand-editing output; every redacted emission — the snapshot included — discloses per-section withheld counts: counts only, never ids (§33.4).

The class also sets the deletion default — a classed record is purged when deleted (§34.1) — and the id convention: classed records take non-descriptive date-serial ids at creation (§34.6). Today the layer is light — diary lines and thrown-in PDFs; individual development maps arrive when the layer matures, through this same design, not a new one.

---
