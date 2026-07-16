## §7. High-Level Architecture

```text
Learning Plan Input                User artifacts / notes / code / tests
        │                                          │
        ▼                                          ▼
┌───────────────┐                      ┌───────────────────┐
│ Plan Importer │                      │ Artifact Observer │
└───────┬───────┘                      └─────────┬─────────┘
        │ writes curated files                   │ appends journal records
        ▼                                        ▼ and trail segments
atlas/ — concepts, materials         state/ journals — artifacts,
(+parts), directions,                encounters, questions, decisions
suggested routes, probes             + trail segments (atlas/trails/)
        │                                        │
        └──────────────────┬─────────────────────┘
                           ▼
                   ┌───────────────┐
                   │ Graph Builder │  reads everything; folds state
                   └───────┬───────┘  (§14, §9.8, §9.13); computes
                           │          influence (§9.10) and frontier (§15)
                           ▼
                 ┌──────────────────┐
                 │ atlas-graph.json │  FieldGraph · MaterialGraph ·
                 └────────┬─────────┘  StateGraph · PersonalTrail ·
                          │            InfluenceField · Frontier
                          ▼
                      ┌────────┐
                      │ Viewer │
                      └────────┘
```

External peers touch this picture only at the §33 boundary: intake batches feed the importer and observer, the state snapshot is emitted beside `atlas-graph.json`, and the viewer embeds by URL (§16.4).

---

