## §27. Acceptance Criteria

The MVP is acceptable when:

1. The uploaded learning plan can be represented as a plan node, direction, suggested routes, concepts, materials, probes, and initial state.
2. Suggested routes are visible but clearly optional.
3. A user artifact can create or update a trail segment.
4. State updates are separate from route import.
5. Influence field can show affected concepts.
6. Frontier can show nearby concepts/questions without TODO wording.
7. Graph JSON builds successfully.
8. Viewer can show at least concepts, routes, trail, and state.
9. Boundary checker rejects TODO/done/project-management leakage.
10. The SDD and ADRs clearly preserve the distinction:

```text
suggested route ≠ personal trail ≠ understanding state
```

---

