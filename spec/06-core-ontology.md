## §6. Core Ontology

```text
Field          = a domain's region space: knowledge, the body (§25.5)
Direction      = stable vector of movement
Concept        = region of the knowledge field
Zone           = anatomical/functional region of the body field (§32.1)
Pattern        = movement skill; concept-kind node of the body field (§32.1)
Material       = canonical source
MaterialPart   = section/aspect of a material
Encounter      = contact with a material or material part
Artifact       = user-created trace: code, note, test, diagram, explanation
Probe          = practice check that can reveal state: understanding, capacity (§32.2)
Question       = explicit uncertainty or pull
Evidence       = recorded trace that can justify a state update
SuggestedRoute = route proposed by a plan
PersonalTrail  = actual movement through the field
TrailSegment   = one movement step in the personal trail
InfluenceField = area affected by user artifacts
State          = current state on the field's scales (§14.1–§14.4; §32.2–§32.3)
Frontier       = nearby territory naturally suggested by current state
```

This glossary is the canonical kind list. A domain design pass (§25.5) that adds kinds extends it, the §10.1/§10.2 registries, the §10.1 field column, and the §10.4 node contract in the same commit — an unregistered kind leaves §20 step 11 and §19 nothing to validate against.

## §6.1 Avoid-Synonyms and Flagged Ambiguities

A glossary term erodes through near-synonyms. A kind carries an avoid-line only where drift has actually been observed — in this repository or its direct ancestors (#96) — as exact tokens, each banned **only as a stand-in for the kind** in spec text and curated prose: a token's other technical senses stay legal, and known nearby collisions are named on the line; never an exhaustive thesaurus. §19 does not scan these lines, and any per-token scan integration is separate opt-in work (#96).

```text
Material   — avoid: resource, reference, reading — as stand-ins
             for "material". ("source" is not banned: see the
             flagged ambiguity below. reference as §17.7's
             structural word and reading as §32's activity word
             are other senses, untouched.)
Encounter  — avoid: pass, session, study — as stand-ins for
             "encounter". (Agent sessions (§17.4), §32.3's
             `studied` exposure value, and §32's study/session
             as activity words are other senses, untouched.)
```

Flagged ambiguities — words that once meant several things; the term and its resolution live here as a pointer, the argument lives in the Decision Log (a copy is a future fork):

```text
source — in the ancestor lineage meant Material, record origin,
         and edge endpoint at once. Resolved (Decision Log
         2026-07-27, #96): §6/§9.2 keep "a Material is a source"
         as definition prose, while the structural senses stay
         keys — an edge's source (§10.3), source_plan (§9.4),
         the §33.2 source namespace slug. No third sense joins;
         "source" as a loose synonym for a specific Material in
         curated prose is the drift to avoid.
```

---

