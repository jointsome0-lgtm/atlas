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

## §16.2 Visual Semantics

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
mode = a §16.1 view name (kebab-case); focus = any node id (§10.1).
The URL is the whole input: no shell handshake, no message
protocol, no shell-specific code in atlas (§33.1); the same URL
renders the same view top-level or inside an iframe.
The scheme is stable: params are only added, never renamed or
repurposed without a Decision Log entry; unknown params are
ignored.
The static viewer stays local: it reads graph/atlas-graph.json
and nothing else; embedding grants the shell a window, not a
channel (§24).
```

---

