## §7. High-Level Architecture

```text
                   ┌────────────────────┐
                   │ Learning Plan Input │
                   └─────────┬──────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Plan Importer   │
                    └───────┬─────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐    ┌────────────────┐    ┌────────────────┐
│ Concepts     │    │ Materials      │    │ SuggestedRoutes │
└──────┬───────┘    └───────┬────────┘    └───────┬────────┘
       │                    │                     │
       └────────────┬───────┴─────────────┬───────┘
                    ▼                     ▼
             ┌──────────────┐      ┌───────────────┐
             │ FieldGraph   │      │ MaterialGraph │
             └──────┬───────┘      └───────┬───────┘
                    │                      │
                    ▼                      ▼
              ┌─────────────────────────────────┐
              │ Graph Builder                   │
              └───────────────┬─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ atlas-graph.json │
                     └────────┬────────┘
                              │
                              ▼
                         ┌────────┐
                         │ Viewer │
                         └────────┘


User artifacts / notes / code / tests
                │
                ▼
       ┌───────────────────┐
       │ Artifact Observer │
       └─────────┬─────────┘
                 ▼
       ┌───────────────────┐
       │ State Updater     │
       └───────┬───────────┘
               ▼
   ┌─────────────────────────────┐
   │ StateGraph + PersonalTrail  │
   └────────────┬────────────────┘
                ▼
        ┌───────────────┐
        │ InfluenceField │
        └───────┬───────┘
                ▼
          ┌──────────┐
          │ Frontier │
          └──────────┘
```

The importer also extracts directions, probes, and the plan node (§12); the observer also records encounters and questions (§13). Evidence records live under `state/` (§8).

External peers touch this picture only at the §33 boundary: intake batches feed the importer and observer, the state snapshot is emitted beside `atlas-graph.json`, and the viewer embeds by URL (§16.4).

---

