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

## §16.4 Embedding

Views are URL-addressable — mode plus optional focus are the whole address:

```text
viewer/index.html#mode=frontier
viewer/index.html#mode=state&focus=concept:idempotency
viewer/index.html#mode=trail&focus=direction:backend-distributed-systems-python
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
The URL is the whole input: no shell handshake, no message
protocol, no shell-specific code in atlas (§33.1); the same URL
renders the same view top-level or inside an iframe.
The scheme is stable: params are only added, never renamed or
repurposed without a Decision Log entry; unknown params are
ignored.
The static viewer stays local: it reads graph/atlas-graph.json
and nothing else — curated projections arrive embedded inside it
(§20, §32), never as a second input; embedding grants the shell
a window, not a channel (§24).
```

---

