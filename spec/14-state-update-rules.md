## §14. State Update Rules

Scales (§14.1–§14.4) define the levels; §14.5–§14.8 define the only allowed transitions. Understanding state is derived at build time by the §20 fold over the `state/` journals (§8); it is never stored and never lives in content frontmatter (§9.1, §31.8).

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
explained + reviewed → taught       (explained and survived review, §14.1)
```

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

## §14.7 Freshness Decay

Freshness is derived from `last_seen`, computed at build/view time, never stored by hand:

```text
fresh  ≤ 30 days
aging  ≤ 90 days
stale  > 90 days
```

Thresholds are config defaults, tunable per field. Staleness feeds the Frontier input (§15.1) with adjacency wording only — a stale node is an invitation, never an obligation (§25.4).

## §14.8 Material State

Material state is derived by the §20 fold from the encounters journal (§9.7), keyed by material or part id — no stored file (§31.8):

```yaml
# shape inside the derived graph output
material:fastapi-tutorial:
  depth_reached: summarized   # max encounter depth so far (§9.7 scale)
  last_seen: 2026-06-05
part:fastapi-tutorial/path-operations:
  depth_reached: read
  last_seen: 2026-06-05
```

`depth_reached` is monotone like exposure. The `status: active` field on the Material file (§9.2) is lifecycle (active/archived), not understanding.

---

