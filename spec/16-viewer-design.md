## §16. Viewer Design

## §16.1 Viewer Modes

The viewer should support at least:

```text
Field View
Material View
Suggested Route View
Personal Trail View
Influence Field View
State View
Frontier View
Question View
```

One view set serves every field: a view renders in the focused field's geometry (§16.2); a domain brings geometry, not new views (§25.5, §32).

## §16.2 Visual Semantics

Semantics are per-geometry. The blocks below are the node-link geometry — the knowledge field, and body patterns with their `loads` edges (§32.1); body zones render in silhouette geometry (end of section).

Layout:

```text
Layout is a property of the geometry, never of the mode: where
authored order carries the meaning (route steps, trail
chronology) it is deterministic by construction; where only
adjacency carries it (concept neighbourhoods, material
supports) a free layout is allowed, bounded by §27.8's
determinism requirement.
```

Suggested routes:

```text
thin gray lines
optional
hideable
```

Personal trail:

```text
bright line
chronological
persistent
```

Influence field:

```text
soft halo around affected concepts
strength shown by opacity/size
```

State:

```text
node border or badge
confidence/clarity/exposure visible
Dimensions that move without a decision (exposure §14.1,
depth_reached §14.8, freshness §14.7) and review-gated ones
(§14.6, §14.9) never share one visual value: a no-decision
value is never a point on a continuous scale — silence must not
read as an assertion. Whether it renders as absence or as its
own mark is a design choice, not a canon one.
Freshness joins this block as its §14.7 classes, never as
continuous decay: the picture asserts no more than the data,
and §14.7's invitation reading survives the render (§25.4). Its
severity treatment is §32.2's, and its channel obeys §27.8's
colour-independence requirement, so opacity alone is not the
encoding. Every class is read from the emission, concept and
material alike — the render derives none of its own, so one
picture never mixes two classifiers (#105); what the viewer
derives it derives to refuse, never to draw (§16.5). Aging
against the viewer's own as-of (§14.7) stays out: acceptance
pins freshness to the build's as-of, and changing that is its
own decision.
No route- or field-level aggregate: per-node state only — no
counts, no proportions, and never understanding as measurement
(§4). A course's completion is activity semantics and belongs
to the system that owns the activity.
```

Support:

```text
A supports edge (§9.14) renders joined with its endpoints' own
§14.8 state and the concepts the facet maps to, and never with
a sufficiency verdict (§9.14).
```

Questions:

```text
pulsing or highlighted nodes
pulling nearby concepts
```

Silhouette (body zones, §32):

```text
zone = curated figure region (frontmatter figure_region,
embedded by §20); the mapping holds no state
indicators render onto regions at view time (§31.8):
influence as soft highlight, freshness as fading,
condition per §32.2 — chronic as subtle shading on
focus, never an alarm badge (§25.4)
patterns stay node-link beside the silhouette, joined
by their loads edges (§32.1)
```

Aesthetics (rev 1) — the channel assignments that satisfy the rules above. Each sentence is checkable against a render; none carries a pixel value, because every value is a viewer token (`viewer/viewer.css`) and a token moves without a canon edit. A palette variant is a token-level choice and inherits every rule here.

```text
A1  Two registers, no crossing. A node's interior texture and
    boundary continuity carry monotone dimensions only (§14.1,
    §14.7, §14.8, §32.2–§32.3); a rail of slots beside the node
    carries its review-gated ones only (§14.6). No dimension
    appears in both registers. Edge weight is review-gated too
    and rides its own edge, never the node's rail (A3).
A2  Silence is a drawn slot. A gated dimension with no confirmed
    decision renders as an unstruck slot — never a position,
    step, tint, width, or opacity on the scale that carries
    decided values — and the slot itself is drawn, so the
    absence of a claim is visible. A node kind that admits no
    gated dimension draws no rail, so "no claim recorded" and
    "no claim possible" stay distinct.
A3  Weight is a mark, not a stroke. Edge weight (§14.9) renders
    as a midpoint mark whose extent carries low/medium/high,
    and unassessed renders as an open gap with no mark; stroke
    colour, dash, and width carry edge family only; an edge type
    that admits no weight renders neither mark nor gap, so "no
    claim to make" stays distinct from "none recorded".
A4  Freshness is three boundary continuities. The §14.7 classes
    render as three discrete node-boundary continuities with no
    interpolated state between them, and add no badge, day
    count, ring, streak, or warning (§31.6). A dash on a node
    boundary is always freshness; a dash on an edge stroke is
    always family.
A5  No mark aggregates. The State block's no-aggregate rule
    binds the marks as well as the values: per-node marks never
    combine into a group reading, and no mark carries a rank or
    a score.
A6  Severity recedes. Negative-valence state — stale, disputed,
    restricted, chronic — never renders more prominently than
    the node's own kind mark and may only thin, mute, or shade; it
    never saturates, enlarges, pulses, badges, or takes an alarm
    colour, and chronic renders only while its region is focused
    or selected (§32.2).
A7  Only the trail is bright. Full chroma is reserved for the
    personal trail; every node-kind hue shares one lightness and
    one chroma, so hue names a kind and never ranks one; a
    suggested route never renders brighter, heavier, or more
    continuous than the trail it parallels, and stays hideable.
A8  Colour is never the only channel. Every state distinction is
    legible in greyscale through texture, boundary continuity,
    mark presence, or mark extent (§27.8); every state drawn in
    the field is also present as words in the detail panel and
    as its own column in the list fallback, in one vocabulary.
A9  Motion is two things. The question pull is the only looping
    animation and focus feedback the only transition; under
    reduced motion the pull renders as a static offset ring and
    transitions collapse to zero (§27.8). No state distinction
    is carried by motion, and nothing animates on account of
    freshness, severity, or elapsed time (§31.6).
A10 Position and size are geometry, never state. Node size is
    fixed per kind class and position derives from authored
    order or seeded free layout only; the sole size-bearing
    channel is the influence halo (§9.10), whose radius is the
    primary channel and opacity the secondary.
A11 Detail degrades by omission, never by summary. As density
    rises the renderer drops whole channels in one fixed order —
    decision rails and weight marks together, then labels, then
    interior texture and boundary continuity — and never
    substitutes a cluster, average, count, or heat for a dropped
    channel; a node drawn without a boundary is drawn without
    state; the viewer names the channels it is not drawing; past
    §25.8's fallback threshold the list carries the same
    channels as columns.
A12 Nesting never inherits. A region or material that contains
    others renders only its own key's state and stays silent
    when nothing was recorded or decided for that key, however
    much its children carry (§14.8); no parent mark is derived
    from a child, and a sub-region exists on the figure only
    where curated content authored it (§32).
```

## §16.3 Required UI Behavior

The viewer should let the user answer:

```text
What did the plan suggest?
Where did I actually go?
What concepts have I touched?
What artifacts affected this area?
Which materials are connected to this concept?
Which sections of this material matter?
What questions are pulling me now?
What is nearby but not obligatory?
```

Link contract (#37): a `url` value renders as a link only after the viewer itself re-parses it and the scheme is exactly `https` — the §25.7 schemas admit nothing else, and the viewer does not trust that; anything else renders as inert text. Links carry `rel="noopener noreferrer"` under the no-referrer policy (§16.5); the viewer never fetches a url on its own — navigation is the user's click (§31.7).

## §16.4 Embedding

Views are URL-addressable — mode plus optional focus are the whole address:

```text
viewer/index.html#mode=frontier
viewer/index.html#mode=state&focus=concept:idempotency
viewer/index.html#mode=trail&focus=direction:backend-distributed-systems-python
viewer/index.html#mode=field&field=body
```

```text
mode ∈ {field, material, route, trail, influence, state,
frontier, question} — the §16.1 views by canonical slug, defined
here and only here (a URL contract is never derived from prose
titles); a new §16.1 view adds its slug to this set. focus = any
node id (§10.1).
Geometry is a property of the field, never a mode: the focused
node selects the field, the field selects the geometry (§16.2,
§32) — a silhouette field view is mode=field with a body focus,
not a new slug.
Field resolution (#33): a region-kind focus selects its own
field; any other focus selects the first of its fields (§10.4)
in §10.1 column order, the rest reachable in the UI; fields: []
renders the default field with a visible "field undefined" flag.
With mode=field and no focus, the additive field= param selects
the field by its §10.1 slug; absent, the default is the
first-registered field (knowledge). An unknown field= value
behaves like an unknown focus: visibly flagged, deterministic,
never silently remapped.
The URL is the whole input: no shell handshake, no message
protocol, no shell-specific code in atlas (§33.1); the same URL
renders the same view top-level or inside an iframe.
The scheme is stable: params are only added, never renamed or
repurposed without a Decision Log entry; unknown params are
ignored.
The static viewer stays local: it reads graph/atlas-graph.json
and nothing else — curated projections arrive embedded inside it
(§20, §32), never as a second input; embedding grants the shell
a window, not a channel (§24) — §16.5 states the pair that
enforces it.
```

## §16.5 Input Hardening

The viewer has exactly two inputs — the graph file and the URL fragment (§16.4) — and trusts neither (#37):

```text
Graph file: acceptance is bounded before parsing — a byte cap
on the file and hard node/edge count ceilings, dedicated §25.8
entries via the measured-floor process (#56/#61); a breach is
the same generic rejection. Within bounds, the viewer validates
the whole file against the §25.7 atlas-graph schema and rejects
the file on the first error — a visible generic failure, never
a partial render. Past the schema it recomputes what the
emission claims to have derived: every freshness class, against
the §14.7 boundaries it transcribes and the graph's own as-of —
an emitted class is input, not proof (#97), and one the
derivation does not produce is that same rejection. Those
boundaries are canon, not a channel: they arrive by shipping
the viewer, never in the graph or the fragment (§14.7, #108) —
a graph that supplied its own would be checked against itself,
which is the #97 defect one layer up. It projects the known
fields of known shapes and never iterates unknown input
properties; past the §25.8 fallback threshold it renders the
list fallback — a rendering mode, never the acceptance bound.
Fragment: the raw fragment and each decoded parameter value
carry dedicated byte ceilings — §25.8 entries via the
measured-floor process, never a borrowed grammar constant —
and each known parameter occurs at most once.
Invalid percent-encoding, a duplicate known key, or a ceiling
breach yields the generic visible error and no render; unknown
params stay ignored (§16.4 forward compatibility). A rejected
value is never echoed through HTML — every visible diagnostic
uses text nodes (§10.4).
Window, not a channel — the enforcing pair: the viewer ships
its own CSP — default-src 'none'; script-src 'self'; style-src
'self'; connect-src 'self'; img-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none' — and a no-referrer
referrer policy. A conforming shell serves the viewer from a
dedicated origin in a sandboxed iframe granting render
capabilities only: no top navigation, popups, forms, downloads,
or parent-origin access. The CSP is the viewer's burden; the
sandbox is the shell's (§33.1 keeps shell-specific code out of
atlas, the same split §34 uses for deletion mechanics).
```

---

