## §14. State Update Rules

Scales (§14.1–§14.4) define the levels; §14.5–§14.9 define the only allowed transitions (question status: §9.8; the body ladders and their mappings: §32.2–§32.3). Understanding state is derived at build time by the §20 fold over the `state/` journals (§8); it is never stored and never lives in content frontmatter (§9.1, §31.8).

## §14.1 Concept Exposure

```text
unseen      = exists in graph, no user contact
touched     = mentioned, noticed, lightly connected
read        = user read material connected to concept
summarized  = user wrote own summary or explanation
applied     = user created artifact applying concept
taught      = user explained concept and survived review
```

## §14.2 Confidence

```text
unknown = no signal
low     = fragile understanding or unresolved questions
medium  = can use with some support
high    = can explain/apply reliably across contexts
```

## §14.3 Clarity

```text
vague    = term exists but boundaries unclear
rough    = basic model exists
stable   = model is coherent
disputed = conflicting sources or unresolved definition
```

## §14.4 Coverage

```text
none
partial
broad
```

Coverage must be separated from depth.

Example:

```text
Kafka can be applied for producer/consumer,
but offsets and consumer groups may remain partial.
```

## §14.5 Evidence → Exposure Transitions

Concept exposure changes only from recorded evidence, and only for concepts the evidence names in `supports_state_updates` (§9.6); concepts merely listed in `touches` move at most to `touched`.

Artifact evidence (§9.6) maps to exposure:

```text
noticed              → touched
read                 → read
summarized           → summarized
explained            → summarized   (explanation alone; see taught rule)
applied              → applied
reviewed             → applied      (reviewing applies judgment to the work)
performed / drilled  → applied      (body strengths §32.3; doing applies the concept)
explained + reviewed → taught       (explained and survived review, §14.1)
```

Each ladder keeps its mapping beside itself (this table for knowledge, motor exposure in §32.3, zone contact in §32.2), all over the one §9.6 strength list, folded by the same monotone-max machinery.

Rules:

```text
Exposure is monotone: it records what happened and never decreases.
New exposure = max(current, mapped evidence).
Encounters (§9.7) feed material state (§14.8) and raise concept exposure to at most `read`;
beyond `read`, only artifacts move exposure.
```

## §14.6 Review-Gated Dimensions

`confidence`, `clarity`, and `coverage` never change automatically in the MVP (§26.2 skips automatic confidence upgrades; §28.2 requires explanation/review).

```text
Agents may propose a change, citing recorded evidence (§9.12).
The user confirms or rejects; the resolved proposal is appended to
state/decisions.jsonl (§9.13), and only a confirmed decision moves
the derived state. An unconfirmed proposal changes nothing and is
never stored; a rejected one is not re-proposed without new evidence.
The user may self-propose: a manual state change cites a note
artifact and is recorded as a decision like any other.
clarity: disputed is proposed when linked sources or artifacts
contradict each other.
Probe responses are artifacts (§9.6): evidence for proposals,
never direct writes.
```

**No decision means no knowledge.** A review-gated dimension with no confirmed decision folds to a no-knowledge value that asserts nothing, the first value of its scale: `unknown` (confidence §14.2; the zone capacities and `condition`, §32.2), `vague` and `none` (clarity §14.3, coverage §14.4; floors, not claims), `open` (question status §9.8). Edge weight keeps its own chain (§14.9): decision, else the authored hypothesis (a cited claim, not silence), else `unassessed`. A first value that claimed anything would let silence assert it (#38). The monotone ladders obey the same rule from the other side: no evidence reads `unseen` (§14.1, §32.2–§32.3). §20 step 9 is this rule's else-branch.

## §14.7 Freshness Decay

Freshness is derived from `last_seen` against the fold's as-of date (§20.1), never the wall clock, so rebuilding unchanged inputs on a later day changes nothing. Never stored by hand:

```text
fresh  ≤ 30 days
aging  ≤ 90 days
stale  > 90 days
```

A day here is a calendar day: the count is the difference between two bare year-month-day dates carrying no time and no zone. No clock, offset, or local calendar enters the comparison, so a boundary never depends on where or when the build ran.

The block above owns these numbers: canon transcribed by every implementation, never instance configuration. The viewer has no config channel to receive one (§16.5). The §20 fold is the one classifier: every contact-carrying state entry, concept understanding and material/part contact alike, is classified there, against the one as-of. The emitted graph carries the class, and a consumer renders it rather than deriving a second one (#105). Tuning the numbers is a semantic change, not a config edit, and takes a version bump with a Decision Log entry (§25.7) on both formats that publish a class, the graph (§10) and the snapshot (§33.4). Per-field thresholds stay unbuilt until a field asks for one. They first need the rule this section lacks, a classification policy for a node spanning two fields (#108); the carrier would be a named policy the consumer can visibly refuse, never raw numbers, and it also waits on a real second clock (§28.3). Staleness feeds the Frontier input (§15.1) with adjacency wording only: a stale node is an invitation, never an obligation (§25.4).

## §14.8 Material State

Material state is derived by the §20 fold from the encounters journal (§9.7), keyed by material or part id; no stored file (§31.8):

```yaml
# shape inside the derived graph output
material:fastapi-tutorial:
  depth_reached: summarized   # max encounter depth so far (§9.7 scale)
  last_seen: 2026-06-05
  freshness: fresh            # §14.7, classified by the same fold (#105)
part:fastapi-tutorial/path-operations:
  depth_reached: read
  last_seen: 2026-06-05
  freshness: fresh
```

`depth_reached` is monotone like exposure. The `status: active` field on the Material file (§9.2) is lifecycle (active/archived), not understanding.

Material state is contact, not understanding: how deeply the source was engaged, never how well its ideas are understood. Understanding is read off the concepts the material maps to (§9.3); a material's through-line is read off its `overall_concepts` (§9.2), moved by cross-part synthesis artifacts. Keys are independent: an encounter moves exactly the id it targets, part contact never aggregates into the parent material, and "read every part" fabricates no whole-material depth.

## §14.9 Edge Weight

`weight` on authored edges (`concept_edges` §9.3, `supports` §9.14) is review-gated like the §14.6 dimensions and never changes automatically:

```text
Scale: low | medium | high.
An authored value (concept_edges) is the import-time hypothesis;
supports links are authored with no weight and render as unassessed.
Agents propose weight changes citing recorded evidence (§9.12) —
the encounters and artifacts in which the helper actually helped.
The user confirms or rejects (§14.6); the resolved proposal is a
StateDecision (§9.13) with an edge target:
  {"target": "supports:part:b/y->part:a/x", "dimension": "weight"}
The fold emits the current weight: last confirmed decision, else
the authored hypothesis, else unassessed.
Help is per-direction: weight(a→b) and weight(b→a) are separate
targets and move independently (§9.14).
```

---

