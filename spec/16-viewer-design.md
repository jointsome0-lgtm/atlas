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
a partial render. It projects the known fields of known shapes
and never iterates unknown input properties; past the §25.8
fallback threshold it renders the list fallback — a rendering
mode, never the acceptance bound.
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

