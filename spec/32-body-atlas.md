## §32. Body Atlas — Second Domain Instantiation

The body domain instantiates the §25.5 domain rule: same core — journals (§8), evidence and decisions (§9.12–§9.13), the fold (§20), the review gate (§14.6), influence (§9.10), frontier (§15), the invariants (§31) — with its own field semantics, scales, and capture. Design pass 2026-07-06 (#17). Nothing here forks the core; where a core § needed generalizing, that § was edited in the same pass (§15.3, §19, §25.5, §31.5–§31.6).

One derived graph serves both domains. The body model is a viewer projection, not a data entity: the silhouette is curated content — a `zone → figure region` mapping holding no state; indicators (influence, freshness, condition) are rendered onto it at view time from the fold output (§31.8). A domain brings its own field geometry: knowledge has none (force-directed layout), the body is anatomical.

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

Patterns are concept-kind nodes, not materials: technique is understanding of a movement, and material state is contact only (§14.8). The pattern→zone link is the same species as `concept_edges` (§9.3): an authored edge with `role: loads` and a gated weight (§14.9).

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
  condition: fine | irritated | recovering | restricted | chronic   # gated; §32.6
  freshness: fresh | aging | stale                # derived from last load (§14.7)
```

**Down through a probe, never through a curve.** Freshness shows the fact of no contact — always, honestly. Capacity and condition move down only through the gate, on measurement evidence: a probe artifact, a diary line, a medical record. A time-based auto-decay write ("−15% after 60 days") asserts a population curve as a personal measurement — and has nothing to cite, since absence of records is not a §9.12 record — so it is unrepresentable by construction (§25.3). The honest route down is the chain: staleness (visible fact) → probe invitation (frontier) → measurement (artifact) → evidenced proposal → user decision.

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

`tried` ranks above `studied`: doing is deeper contact than reading — a motor skill is not a text. The ladder is monotone via max; §14.5 machinery unchanged. Years of swimming with no technique work reads as `tried` + `clarity: vague` — much done, little understood; the scales are built to say this without judgment.

## §32.4 Capture: the Diary Is the Only Evidence Source

The one structural difference from the knowledge domain: the work leaves no trace by itself. A coding session leaves code; a swim leaves nothing. The trace is authored separately, so capture cost decides whether the field lives or stays `unseen` forever.

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
the medical sensitivity class (§32.6).
No mandatory fields, ever: each required field doubles capture
cost and kills the habit.
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

Freshness applies to medical evidence for free: a two-year-old diagnosis ages, and the frontier may invite a re-probe — adjacency wording, never obligation (§31.6).

**Sensitivity class**: medical journals and files are excluded from agent context by default; they enter only in a session the user explicitly started for them (§24, §31.7 discipline). Today the layer is light — diary lines and thrown-in PDFs; individual development maps arrive when the layer matures, through this same design, not a new one.

---
