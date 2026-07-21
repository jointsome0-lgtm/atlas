import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import validate_atlas


ROOT = Path(__file__).resolve().parents[1]

# Instance trees are materialized into temp directories instead of being
# committed: .gitignore deliberately blocks instance-shaped paths (atlas/,
# state/, graph/, intake/, *.jsonl) anywhere in the public git layer.

VALID_CONCEPT = """---
id: concept:example
type: concept
title: Example
updated: 2026-07-16
aliases: []
related_concepts: []
concept_edges: []
---

Synthetic schema fixture authored by Vera Example.
"""

VALID_PLAN_EXTRACT = """id: plan:example
title: Example plan
directions: []
concepts: []
materials: []
material_parts: []
suggested_routes: []
probes: []
notes: []
"""

VALID_ARTIFACT_ROW = (
    '{"id":"artifact:2026-07-16-001","type":"note","path":"notes/example.md",'
    '"observed_at":"2026-07-16","summary":"Synthetic schema fixture.",'
    '"touches":["concept:example"],"supports_state_updates":[],'
    '"evidence_strength":"noticed"}\n'
)

VALID_EMPTY_GRAPH = """{
  "format": "atlas-graph",
  "version": 1,
  "nodes": [],
  "edges": [],
  "trails": [],
  "state": {},
  "influence": {},
  "frontier": [],
  "projections": {}
}
"""

VALID_INTAKE_BATCH = """{
  "format": "atlas-intake",
  "version": 1,
  "source": "watch-sync",
  "batch": "2026-07-16-001",
  "records": [
    {"kind": "question", "date": "2026-07-16", "text": "synthetic Vera Example question?"}
  ]
}
"""

FULL_WITHHELD = (
    '"withheld": {"nodes": 1, "edges": 0, "trails": 0, "state": 0,'
    ' "influence": 0, "frontier": 0, "projections": 0}'
)

VALID_REDACTED_GRAPH = VALID_EMPTY_GRAPH.replace(
    '"nodes": [],', FULL_WITHHELD + ',\n  "nodes": [],'
)

GRAPH_WITH_NODE = VALID_EMPTY_GRAPH.replace(
    '"nodes": [],',
    '"nodes": [{"id": "concept:example", "type": "%s", "title": "Example",'
    ' "fields": ["knowledge"], "aliases": []}],',
)

GRAPH_WITH_EDGE = VALID_EMPTY_GRAPH.replace(
    '"edges": [],',
    '"edges": [{"source": "concept:a", "target": "concept:b", "type": "loads",'
    ' "provenance": ["pattern:p"], "weight": "unassessed"}],',
)

VALID_MATERIAL = """---
id: material:example-docs
type: material
title: Example Docs (Vera Example)
kind: docs
url: ""
status: active
overall_concepts:
  - concept:example
parts:
  - id: part:example-docs/intro
    title: Intro
    formerly:
      - part:example-docs/old-intro
---
"""

_LEVELS = ["unknown", "low", "medium", "high"]
_SHARED_SCALES = {
    "confidence": _LEVELS,
    "clarity": ["vague", "rough", "stable", "disputed"],
    "coverage": ["none", "partial", "broad"],
    "freshness": ["fresh", "aging", "stale"],
}

VALID_SNAPSHOT = json.dumps({
    "format": "atlas-snapshot",
    "version": 1,
    "generated_at": "2026-07-16T00:00:00Z",
    "withheld": {"state": 0, "materials": 0, "trail": 0, "questions": 0, "evidence_refs": 0},
    "scales": {
        "concept": {"exposure": ["unseen", "touched", "read", "summarized", "applied", "taught"], **_SHARED_SCALES},
        "material": {"depth_reached": ["skim", "read", "summarized", "applied", "taught"]},
        "pattern": {"exposure": ["unseen", "touched", "studied", "tried", "drilled", "reviewed"], **_SHARED_SCALES},
        "zone": {"contact": ["unseen", "touched", "loaded", "probed"], "strength": _LEVELS,
                 "endurance": _LEVELS, "mobility": _LEVELS,
                 "condition": ["unknown", "fine", "irritated", "recovering", "restricted", "chronic"],
                 "freshness": ["fresh", "aging", "stale"]},
    },
    "evidence_refs": {"artifact:2026-07-16-001": {"kind": "artifact", "date": "2026-07-16"}},
    "state": {"concept:example": {"exposure": "applied", "evidence": ["artifact:2026-07-16-001"],
              "decisions": [{"dimension": "confidence", "date": "2026-07-16",
                             "evidence": ["artifact:2026-07-16-001"]}]}},
    "materials": {},
    "trail": [],
    "questions": [],
}, indent=2) + "\n"

VALID_ROUTE = """---
id: suggested-route:example-default
type: suggested_route
title: Example route (Vera Example)
status: available
steps:
  - concept:example
material_roles:
  - step: concept:example
    primary_materials:
      - material:example-docs
---
"""

VALID_INSTANCE = {
    "atlas/concepts/example.md": VALID_CONCEPT,
    "atlas/suggested-routes/example-default.md": VALID_ROUTE,
    "graph/atlas-snapshot.json": VALID_SNAPSHOT,
    "atlas/materials/example-docs.md": VALID_MATERIAL,
    "state/receipts.jsonl": (
        '{"intake":"watch-sync/2026-07-16-001#0","marker":"opened","date":"2026-07-16"}\n'
        '{"intake":"watch-sync/2026-07-16-001#0","marker":"processed","date":"2026-07-16"}\n'
    ),
    "plans/extracted/example.yaml": VALID_PLAN_EXTRACT,
    "state/artifacts.jsonl": VALID_ARTIFACT_ROW,
    "state/decisions.jsonl": (
        '{"date":"2026-07-16","target":"supports:part:b/y->part:a/x",'
        '"dimension":"weight","to":"high",'
        '"evidence":["artifact:2026-07-16-001"],'
        '"proposed_by":"user","decision":"confirmed"}\n'
    ),
    "intake/watch-sync/2026-07-16-002.json": VALID_INTAKE_BATCH.replace(
        "\n", "\r\n"
    ).replace('"2026-07-16-001"', '"2026-07-16-002"'),
    "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
        '"title": "Example", "fields": ["knowledge"], "aliases": []}],',
        '"title": "Example", "fields": ["knowledge"], "aliases": []},'
        ' {"id": "concept:other", "type": "concept", "title": "Other",'
        ' "fields": ["knowledge"], "aliases": []}],',
    ).replace(
        '"edges": [],',
        '"edges": [{"source": "concept:example", "target": "concept:other",'
        ' "type": "related_to", "provenance": ["concept:example"],'
        ' "weight": "low"}],',
    ),
    "graph/atlas-graph.redacted.json": VALID_REDACTED_GRAPH,
    "intake/watch-sync/2026-07-16-001.json": VALID_INTAKE_BATCH,
}

INVALID_INSTANCES = {
    "bad-graph": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace('"version": 1', '"version": 2'),
    },
    "bad-journal": {
        "state/artifacts.jsonl": VALID_ARTIFACT_ROW.replace('"noticed"', '"mastered"'),
    },
    "unknown-curated": {
        "atlas/concepts/bad.md": "---\nid: concept:bad\ntype: concept\ntitle: Bad\nstray: rejected\n---\n",
    },
    "bad-id-trailing-newline": {
        "atlas/concepts/bad.md": (
            "---\nid: \"concept:bad\\n\"\ntype: concept\ntitle: Bad (Vera Example)\n"
            "aliases: []\n---\n"
        ),
    },
    "bad-graph-node-kind": {
        "graph/atlas-graph.json": GRAPH_WITH_NODE % "material",
    },
    "bad-graph-edge-endpoints": {
        "graph/atlas-graph.json": GRAPH_WITH_EDGE,
    },
    "bad-graph-withheld-on-full": {
        "graph/atlas-graph.json": VALID_REDACTED_GRAPH,
    },
    "bad-graph-redacted-without-withheld": {
        "graph/atlas-graph.redacted.json": VALID_EMPTY_GRAPH,
    },
    # §32.6/§24.3: the agent-facing variant must not retain any classed
    # entry — a schema-valid redacted graph with a surviving sensitivity
    # marking must fail the gate, never be certified for agent context.
    "bad-redacted-surviving-sensitivity": {
        "graph/atlas-graph.redacted.json": VALID_REDACTED_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:example", "type": "concept",'
            ' "title": "Example (Vera Example)", "fields": ["knowledge"],'
            ' "aliases": [], "sensitivity": "medical"}],'
        ),
    },
    "bad-decision-weight-endpoints": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"loads:concept:a->concept:b",'
            '"dimension":"weight","to":"high",'
            '"evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-decision-weight-on-derived-edge": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"has_part:material:a->part:a/b",'
            '"dimension":"weight","to":"high",'
            '"evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-decision-status-target": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"concept:example","dimension":"status",'
            '"to":"open","evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-pattern-loads-target": {
        "atlas/patterns/bad.md": (
            "---\nid: pattern:bad\ntype: pattern\ntitle: Bad (Vera Example)\n"
            "concept_edges:\n  - to: concept:example\n    role: loads\n---\n"
        ),
    },
    "bad-route-role-overlap": {
        "atlas/suggested-routes/bad.md": VALID_ROUTE.replace(
            "id: suggested-route:example-default",
            "id: suggested-route:bad",
        ).replace(
            "    primary_materials:\n      - material:example-docs\n",
            "    primary_materials:\n      - material:example-docs\n"
            "    supporting_materials:\n      - material:example-docs\n",
        ),
    },
    "bad-material-foreign-part-id": {
        "atlas/materials/bad.md": VALID_MATERIAL.replace(
            "id: material:example-docs",
            "id: material:bad-docs",
        ).replace(
            "part:example-docs/old-intro",
            "part:bad-docs/old-intro",
        ),
    },
    "bad-route-material-role-step": {
        "atlas/suggested-routes/bad.md": VALID_ROUTE.replace(
            "id: suggested-route:example-default",
            "id: suggested-route:bad",
        ).replace("- step: concept:example", "- step: concept:absent"),
    },
    "bad-snapshot-evidence-key-shape": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "evidence_refs": {"artifact:bad/key":
                              {"kind": "artifact", "date": "2026-07-16"}},
            "state": {},
        }) + "\n",
    },
    "bad-graph-trail-from-shape": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "trail-segment:2026-07-16-002",'
            ' "type": "trail_segment", "title": "", "fields": [],'
            ' "date": "2026-07-16", "direction": "direction:d",'
            ' "from": "concept:bad/key", "to": "concept:a",'
            ' "via": ["artifact:a"], "reason": "r",'
            ' "resulting_questions": []}],',
        ),
    },
    "bad-graph-trail-shape": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "trail-segment:2026-07-16-001",'
            ' "type": "trail_segment", "title": "", "fields": [],'
            ' "date": "2026-07-16", "direction": "direction:d",'
            ' "to": "material:m", "via": ["question:q"], "reason": "r",'
            ' "resulting_questions": []}],',
        ),
    },
    "bad-graph-role-step-not-in-route": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1},'
            ' {"source": "material:m", "target": "suggested-route:r",'
            ' "type": "primary_for", "provenance": ["suggested-route:r"],'
            ' "step": "concept:b"}],',
        ),
    },
    "bad-snapshot-state-type": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": [1],
        }) + "\n",
    },
    "bad-graph-part-parent": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "part:a/x", "type": "material_part",'
            ' "title": "X", "fields": [], "material": "material:b"}],',
        ),
    },
    "bad-graph-region-field": {
        "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
            '"fields": ["knowledge"], "aliases": []}],',
            '"fields": ["body"], "aliases": []}],',
        ).replace(
            '"fields": ["knowledge"], "aliases": []},',
            '"fields": ["body"], "aliases": []},',
        ),
    },
    "bad-graph-dangling-context": {
        "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
            '"edges": [],',
            '"edges": [{"source": "concept:example", "target": "concept:other",'
            ' "type": "suggested_next", "provenance": ["concept:example"],'
            ' "context": "suggested-route:missing"}],',
        ),
    },
    "bad-graph-duplicate-node-id": {
        "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
            '"aliases": []}],',
            '"aliases": []}, {"id": "concept:example", "type": "concept",'
            ' "title": "Twin", "fields": ["knowledge"], "aliases": []}],',
        ),
    },
    "bad-graph-dangling-provenance": {
        "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
            '"edges": [],',
            '"edges": [{"source": "concept:example", "target": "concept:example",'
            ' "type": "related_to", "provenance": ["concept:missing"],'
            ' "weight": "low"}],',
        ),
    },
    "bad-snapshot-state-key": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:bad/key": {
                "evidence": ["artifact:2026-07-16-001"], "decisions": [],
            }},
        }) + "\n",
    },
    "bad-snapshot-concept-depth-reached": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {
                "depth_reached": "read",
                "evidence": ["artifact:2026-07-16-001"], "decisions": [],
            }},
        }) + "\n",
    },
    "bad-snapshot-evidence-kind-mismatch": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "evidence_refs": {"artifact:2026-07-16-001":
                              {"kind": "question", "date": "2026-07-16"}},
        }) + "\n",
    },
    "bad-snapshot-materials-key": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "materials": {"concept:example": {
                "depth_reached": "skim", "last_seen": "2026-07-16",
                "evidence": [],
            }},
        }) + "\n",
    },
    "bad-snapshot-trail-shape": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "trail": [{"id": "trail-segment:2026-07-16-001",
                       "date": "2026-07-16", "to": "material:m",
                       "via": ["concept:x"]}],
        }) + "\n",
    },
    "bad-snapshot-question-pulls": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "questions": [{"id": "question:example", "text": "Vera Example?",
                           "status": "open", "pulls": ["material:m"],
                           "source": ["artifact:2026-07-16-001"]}],
        }) + "\n",
    },
    "bad-snapshot-status-decision": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {
                "evidence": ["artifact:2026-07-16-001"],
                "decisions": [{"dimension": "status", "date": "2026-07-16",
                               "evidence": ["artifact:2026-07-16-001"]}],
            }},
        }) + "\n",
    },
    "bad-snapshot-decision-dimension": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {
                "evidence": ["artifact:2026-07-16-001"],
                "decisions": [{"dimension": "condition", "date": "2026-07-16",
                               "evidence": ["artifact:2026-07-16-001"]}],
            }},
        }) + "\n",
    },
    "bad-graph-dangling-endpoint": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "concept:b",'
            ' "type": "related_to", "provenance": ["concept:a"],'
            ' "weight": "low"}],',
        ),
    },
    "bad-snapshot-kind-dimensions": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {
                "condition": "chronic",
                "evidence": ["artifact:2026-07-16-001"],
                "decisions": [],
            }},
        }) + "\n",
    },
    "bad-snapshot-dangling-evidence": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {
                "exposure": "applied",
                "evidence": ["artifact:missing"],
                "decisions": [],
            }},
        }) + "\n",
    },
    "bad-graph-weight-on-derived-edge": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "part:m/a",'
            ' "type": "has_part", "provenance": ["material:m"],'
            ' "weight": "high"}],',
        ),
    },
    "bad-graph-suggested-next-context": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "concept:b",'
            ' "type": "suggested_next", "provenance": ["suggested-route:r"],'
            ' "context": "concept:a"}],',
        ),
    },
    "bad-receipt-intake-key": {
        "state/receipts.jsonl": (
            '{"intake":"-bad/also--bad#1","marker":"opened","date":"2026-07-16"}\n'
        ),
    },
    "bad-intake-path-mismatch": {
        "intake/right/file.json": VALID_INTAKE_BATCH.replace(
            '"watch-sync"', '"wrong"'
        ),
    },
    "bad-intake": {
        "intake/watch-sync/2026-07-16-002.json": VALID_INTAKE_BATCH.replace(
            '"atlas-intake"', '"wrong"'
        ),
    },
    "bad-route-step-shape": {
        "atlas/suggested-routes/bad.md": VALID_ROUTE.replace(
            "id: suggested-route:example-default",
            "id: suggested-route:bad",
        ).replace(
            "steps:\n  - concept:example\n",
            "steps:\n  - id: concept:example\n",
        ),
    },
    "bad-graph-node-id-type": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": [], "type": "concept", "title": "Bad",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ),
    },
    "bad-graph-projection-key": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"projections": {}',
            '"projections": {"concept:a": "left shoulder"}',
        ),
    },
    "bad-route-role-material-shape": {
        "atlas/suggested-routes/bad.md": VALID_ROUTE.replace(
            "id: suggested-route:example-default",
            "id: suggested-route:bad",
        ).replace(
            "    primary_materials:\n      - material:example-docs\n",
            "    primary_materials:\n      - id: material:example-docs\n",
        ),
    },
    "bad-graph-withheld-partial": {
        "graph/atlas-graph.redacted.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],', '"withheld": {"nodes": 1},\n  "nodes": [],'
        ),
    },
    "bad-graph-withheld-foreign-key": {
        "graph/atlas-graph.redacted.json": VALID_REDACTED_GRAPH.replace(
            '"projections": 0}', '"projections": 0, "note": 1}'
        ),
    },
    "bad-graph-nodes-type": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],', '"nodes": 1,'
        ),
    },
    "bad-graph-duplicate-step-order": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1},'
            ' {"source": "concept:b", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1}],',
        ),
    },
    "bad-graph-wall-clock-generated-at": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"version": 1,',
            '"version": 1,\n  "generated_at": "2026-07-16T12:34:56Z",',
        ),
    },
    "bad-graph-artifact-fields": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "artifact:a", "type": "artifact", "title": "A",'
            ' "fields": [], "kind": "note", "path": "p",'
            ' "observed_at": "2026-07-16", "summary": "s",'
            ' "evidence_strength": "weak"},'
            ' {"id": "concept:c", "type": "concept", "title": "C",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "artifact:a", "target": "concept:c",'
            ' "type": "influences", "provenance": ["artifact:a"]}],',
        ),
    },
    "bad-graph-role-overlap": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": ["knowledge"], "kind": "docs", "url": "",'
            ' "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1},'
            ' {"source": "material:m", "target": "suggested-route:r",'
            ' "type": "primary_for", "provenance": ["suggested-route:r"],'
            ' "step": "concept:a", "weight": "unassessed"},'
            ' {"source": "material:m", "target": "suggested-route:r",'
            ' "type": "supporting_for", "provenance": ["suggested-route:r"],'
            ' "step": "concept:a", "weight": "unassessed"}],',
        ),
    },
    "bad-graph-encounter-without-visited": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "encounter:e", "type": "encounter", "title": "E",'
            ' "fields": [], "date": "2026-07-16", "target": "material:m",'
            ' "depth": "skim", "mode": "background"}],',
        ),
    },
    "bad-graph-formerly-cross-kind": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active",'
            ' "formerly": ["part:old/x"]}],',
        ),
    },
    "bad-graph-container-edge-meta": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"edges": [],',
            '"edges": [{"source": [], "target": {}, "type": "suggested_next",'
            ' "provenance": ["suggested-route:r"], "context": []},'
            ' {"source": [], "target": [], "type": "visited",'
            ' "provenance": ["encounter:e"]}],',
        ),
    },
    "bad-curated-two-survivor-formerly": {
        "atlas/concepts/example.md": VALID_CONCEPT.replace(
            "aliases: []",
            "aliases: []\nformerly:\n  - concept:old",
        ),
        "atlas/concepts/other.md": VALID_CONCEPT.replace(
            "concept:example", "concept:other",
        ).replace(
            "aliases: []",
            "aliases: []\nformerly:\n  - concept:old",
        ),
    },
    "bad-curated-living-formerly": {
        "atlas/concepts/example.md": VALID_CONCEPT.replace(
            "aliases: []",
            "aliases: []\nformerly:\n  - concept:other",
        ),
        "atlas/concepts/other.md": VALID_CONCEPT.replace(
            "concept:example", "concept:other",
        ),
    },
    "bad-curated-duplicate-id": {
        "atlas/concepts/example.md": VALID_CONCEPT,
        "atlas/concepts/twin.md": VALID_CONCEPT.replace(
            "title: Example", "title: Twin"),
    },
    "bad-graph-off-type-discriminant": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": ["knowledge"], "kind": "docs", "url": "",'
            ' "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"]},'
            ' {"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"],'
            ' "order": 2}],',
        ),
    },
    "bad-graph-forged-question-role": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "artifact:x", "type": "artifact", "title": "X",'
            ' "fields": [], "kind": "note", "path": "p",'
            ' "observed_at": "2026-07-16", "summary": "s",'
            ' "evidence_strength": "noticed"},'
            ' {"id": "question:q", "type": "question", "title": "Q",'
            ' "fields": [], "text": "Vera Example?",'
            ' "created_at": "2026-07-16",'
            ' "source": {"artifact": "artifact:x"}}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "question:q",'
            ' "type": "primary_for", "provenance": ["question:q"]}],',
        ),
    },
    "bad-graph-unordered-edges": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": ["knowledge"], "kind": "docs", "url": "",'
            ' "status": "active"},'
            ' {"id": "part:m/x", "type": "material_part", "title": "X",'
            ' "fields": [], "material": "material:m"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"]},'
            ' {"source": "material:m", "target": "part:m/x",'
            ' "type": "has_part", "provenance": ["material:m"]}],',
        ),
    },
    "bad-graph-unsorted-related-to": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:b", "target": "concept:a",'
            ' "type": "related_to", "provenance": ["concept:b"],'
            ' "weight": "unassessed"}],',
        ),
    },
    "bad-graph-duplicate-edge-identity": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": ["knowledge"], "kind": "docs", "url": "",'
            ' "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"],'
            ' "weight": "unassessed"},'
            ' {"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"],'
            ' "weight": "unassessed"}],',
        ),
    },
    "bad-concept-formerly-pattern": {
        "atlas/concepts/bad.md": (
            "---\nid: concept:bad\ntype: concept\n"
            "title: Bad (Vera Example)\nformerly:\n  - pattern:old\n---\n"
        ),
    },
    "bad-graph-segment-without-moved-to": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "direction:d", "type": "direction", "title": "D",'
            ' "fields": ["knowledge"], "attractor": "a", "status": "active"},'
            ' {"id": "trail-segment:2026-07-16-001", "type": "trail_segment",'
            ' "title": "", "fields": ["knowledge"], "date": "2026-07-16",'
            ' "direction": "direction:d", "from": "concept:a",'
            ' "to": "concept:b", "via": [], "reason": "r"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]},'
            ' {"source": "concept:b", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]}],',
        ),
    },
    "bad-graph-unbacked-moved-to": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:c", "type": "concept", "title": "C",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:d", "type": "concept", "title": "D",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "direction:d", "type": "direction", "title": "D",'
            ' "fields": ["knowledge"], "attractor": "a", "status": "active"},'
            ' {"id": "trail-segment:2026-07-16-001", "type": "trail_segment",'
            ' "title": "", "fields": ["knowledge"], "date": "2026-07-16",'
            ' "direction": "direction:d", "from": "concept:a",'
            ' "to": "concept:b", "via": [], "reason": "r"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]},'
            ' {"source": "concept:b", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]},'
            ' {"source": "concept:a", "target": "concept:b",'
            ' "type": "moved_to",'
            ' "provenance": ["trail-segment:2026-07-16-001"]},'
            ' {"source": "concept:c", "target": "concept:d",'
            ' "type": "moved_to",'
            ' "provenance": ["trail-segment:2026-07-16-001"]}],',
        ),
    },
    "bad-graph-moved-to-wrong-segment": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:c", "type": "concept", "title": "C",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:d", "type": "concept", "title": "D",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "direction:d", "type": "direction", "title": "D",'
            ' "fields": ["knowledge"], "attractor": "a", "status": "active"},'
            ' {"id": "trail-segment:2026-07-16-001", "type": "trail_segment",'
            ' "title": "", "fields": ["knowledge"], "date": "2026-07-16",'
            ' "direction": "direction:d", "from": "concept:a",'
            ' "to": "concept:b", "via": [], "reason": "r"},'
            ' {"id": "trail-segment:2026-07-16-002", "type": "trail_segment",'
            ' "title": "", "fields": ["knowledge"], "date": "2026-07-16",'
            ' "direction": "direction:d", "from": "concept:c",'
            ' "to": "concept:d", "via": [], "reason": "r"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]},'
            ' {"source": "concept:b", "target": "direction:d",'
            ' "type": "part_of_direction", "provenance": ["direction:d"]},'
            ' {"source": "concept:a", "target": "concept:b",'
            ' "type": "moved_to",'
            ' "provenance": ["trail-segment:2026-07-16-002"]},'
            ' {"source": "concept:c", "target": "concept:d",'
            ' "type": "moved_to",'
            ' "provenance": ["trail-segment:2026-07-16-002"]}],',
        ),
    },
    "bad-graph-artifact-via-without-produced": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "artifact:x", "type": "artifact", "title": "X",'
            ' "fields": [], "kind": "note", "path": "p",'
            ' "observed_at": "2026-07-16", "summary": "s",'
            ' "evidence_strength": "weak"},'
            ' {"id": "direction:d", "type": "direction", "title": "D",'
            ' "fields": [], "attractor": "a", "status": "active"},'
            ' {"id": "trail-segment:2026-07-16-001", "type": "trail_segment",'
            ' "title": "", "fields": [], "date": "2026-07-16",'
            ' "direction": "direction:d", "to": "concept:absent",'
            ' "via": ["artifact:x"], "reason": "r"}],',
        ),
    },
    "bad-graph-gapped-step-orders": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1},'
            ' {"source": "concept:b", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 3}],',
        ),
    },
    "bad-graph-part-without-has-part": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "part:m/a", "type": "material_part", "title": "A",'
            ' "fields": [], "material": "material:m"}],',
        ),
    },
    "bad-graph-container-types": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": [], "title": "A",'
            ' "fields": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "concept:a",'
            ' "type": [], "provenance": ["concept:a"]}],',
        ),
    },
    "bad-graph-fields-mismatch": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:m", "target": "concept:a",'
            ' "type": "overall_concept", "provenance": ["material:m"],'
            ' "weight": "unassessed"}],',
        ),
    },
    "bad-graph-missing-suggested-next": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 1},'
            ' {"source": "concept:b", "target": "suggested-route:r",'
            ' "type": "step_of_route", "provenance": ["suggested-route:r"],'
            ' "order": 2}],',
        ),
    },
    "bad-graph-suggested-next-not-consecutive": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "concept:b", "type": "concept", "title": "B",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "suggested-route:r", "type": "suggested_route",'
            ' "title": "R", "fields": ["knowledge"], "status": "available"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "concept:a", "target": "concept:b",'
            ' "type": "suggested_next", "provenance": ["suggested-route:r"],'
            ' "context": "suggested-route:r"}],',
        ),
    },
    "bad-graph-concept-with-status": {
        "graph/atlas-graph.json": (GRAPH_WITH_NODE % "concept").replace(
            '"aliases": []}],',
            '"aliases": [], "status": "active"}],',
        ),
    },
    "bad-graph-supports-foreign-provenance": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:a", "type": "material", "title": "A",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "material:b", "type": "material", "title": "B",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"}],',
        ).replace(
            '"edges": [],',
            '"edges": [{"source": "material:a", "target": "material:b",'
            ' "type": "supports", "provenance": ["material:a"],'
            ' "weight": "unassessed"}],',
        ),
    },
    "bad-graph-question-source-shape": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "question:q", "type": "question", "title": "Q",'
            ' "fields": ["knowledge"], "text": "Vera Example?",'
            ' "created_at": "2026-07-16", "source": "material:m"}],',
        ),
    },
    "bad-graph-encounter-target": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "encounter:e", "type": "encounter", "title": "E",'
            ' "fields": [], "date": "2026-07-16", "target": "concept:c",'
            ' "depth": "skim", "mode": "reading", "context": "solo"}],',
        ),
    },
    "bad-graph-encounter-context": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "encounter:e", "type": "encounter", "title": "E",'
            ' "fields": [], "date": "2026-07-16", "target": "material:m",'
            ' "depth": "skim", "mode": "reading", "context": "solo"}],',
        ),
    },
    "bad-graph-encounter-mode": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "encounter:e", "type": "encounter", "title": "E",'
            ' "fields": [], "date": "2026-07-16", "target": "material:m",'
            ' "depth": "skim", "mode": "solo"}],',
        ),
    },
    "bad-snapshot-wall-clock-generated-at": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "generated_at": "2026-07-16T12:34:56Z",
        }) + "\n",
    },
    "bad-graph-zone-without-projection": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "zone:shoulder", "type": "zone",'
            ' "title": "Shoulder", "fields": ["body"], "notes": ""}],',
        ),
    },
    "bad-snapshot-closed-question": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "questions": [{"id": "question:q", "text": "Vera Example?",
                           "status": "resolved", "pulls": [],
                           "source": ["artifact:2026-07-16-001"]}],
        }) + "\n",
    },
    "bad-snapshot-evidence-type": {
        "graph/atlas-snapshot.json": json.dumps({
            **json.loads(VALID_SNAPSHOT),
            "state": {"concept:example": {"evidence": 1, "decisions": 1}},
        }) + "\n",
    },
}


def materialize(tree: dict[str, str], root: Path) -> None:
    for relative, content in tree.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


class SchemaValidatorTests(unittest.TestCase):
    def run_cli(self, *args):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = validate_atlas.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_registry_is_exact_and_supported(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        self.assertEqual(validate_atlas.SCHEMA_NAMES, set(schemas))

    def test_runner_contract_envelopes_are_closed(self):
        # §17.7/#46: the four transient role boundaries accept their minimal
        # envelopes, while model-authored sensitivity or write authority has
        # no structural channel.
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        for name in (
                "runner-plan-importer-input",
                "runner-plan-importer-output",
                "runner-artifact-observer-input",
                "runner-artifact-observer-output"):
            stack = [schemas[name]]
            while stack:
                value = stack.pop()
                if isinstance(value, dict):
                    if value.get("type") == "object":
                        self.assertIs(value.get("additionalProperties"), False,
                                      name)
                    stack.extend(value.values())
                elif isinstance(value, list):
                    stack.extend(value)
        instances = {
            "runner-plan-importer-input": {
                "format": "runner-plan-importer-input",
                "version": 1,
                "run_id": "run:2026-07-21-001",
                "source": {"kind": "plan", "fragments": [
                    {"ref": "source:0", "kind": "heading",
                     "text": "Vera Example plan"},
                ]},
                "nodes": [],
            },
            "runner-plan-importer-output": {
                "format": "runner-plan-importer-output",
                "version": 1,
                "candidates": [],
                "relations": [],
                "routes": [],
                "mapping_questions": [],
                "self_claims": [],
                "warnings": [],
            },
            "runner-artifact-observer-input": {
                "format": "runner-artifact-observer-input",
                "version": 1,
                "run_id": "run:2026-07-21-001",
                "units": [{
                    "ref": "source:0",
                    "kind": "file",
                    "media_type": "text/plain",
                    "label": "Vera Example note",
                    "text": "Vera Example studied one invented topic.",
                }],
                "nodes": [],
                "edges": [],
                "journal_context": [],
            },
            "runner-artifact-observer-output": {
                "format": "runner-artifact-observer-output",
                "version": 1,
                "artifacts": [],
                "encounters": [],
                "questions": [],
                "trail_segments": [],
                "state_proposals": [],
                "warnings": [],
            },
        }
        for name, instance in instances.items():
            with self.subTest(name=name):
                validator = validate_atlas.SchemaValidator(schemas[name])
                self.assertEqual([], validator.validate(instance))
                for forbidden in ("sensitivity", "write_path", "decision"):
                    attacked = {**instance, forbidden: "model-asserted"}
                    self.assertTrue(validator.validate(attacked), forbidden)

    def test_runner_observer_separates_evidence_from_recognition(self):
        # §9.12/§17.7: non-evidence memory can support recognition but its
        # namespace cannot be emitted as support for a state proposal.
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        observer_input = {
            "format": "runner-artifact-observer-input",
            "version": 1,
            "run_id": "run:2026-07-21-001",
            "units": [{
                "ref": "source:0",
                "kind": "file",
                "media_type": "text/plain",
                "label": "Vera Example note",
                "text": "Vera Example studied one invented topic.",
            }],
            "nodes": [],
            "edges": [],
            "journal_context": [
                {"ref": "evidence:0", "kind": "artifact",
                 "summary": "Invented Vera Example evidence."},
                {"ref": "recognition:0", "kind": "decision",
                 "summary": "Invented Vera Example recognition."},
            ],
        }
        input_validator = validate_atlas.SchemaValidator(
            schemas["runner-artifact-observer-input"])
        self.assertEqual([], input_validator.validate(observer_input))

        observer_output = {
            "format": "runner-artifact-observer-output",
            "version": 1,
            "artifacts": [],
            "encounters": [],
            "questions": [],
            "trail_segments": [],
            "state_proposals": [{
                "ref": "proposal:0",
                "target_ref": "node:0",
                "dimension": "confidence",
                "proposed_value": "low",
                "evidence_refs": ["evidence:0"],
            }],
            "warnings": [],
        }
        output_validator = validate_atlas.SchemaValidator(
            schemas["runner-artifact-observer-output"])
        self.assertEqual([], output_validator.validate(observer_output))
        observer_output["state_proposals"][0]["evidence_refs"] = [
            "recognition:0"
        ]
        self.assertTrue(output_validator.validate(observer_output))

    def test_runner_v1_schemas_reject_body_only_values(self):
        # §17.7/#45: the active v1 schemas have no Body Atlas graph, edge,
        # evidence-strength, or review-dimension channel.
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        cases = {
            "importer-zone": (
                "runner-plan-importer-input",
                {
                    "format": "runner-plan-importer-input",
                    "version": 1,
                    "run_id": "run:2026-07-21-001",
                    "source": {"kind": "plan", "fragments": [{
                        "ref": "source:0", "kind": "text",
                        "text": "Invented Vera Example plan.",
                    }]},
                    "nodes": [{
                        "ref": "node:0", "id": "zone:example",
                        "kind": "zone", "label": "Example",
                        "aliases": [],
                    }],
                },
            ),
            "importer-loads": (
                "runner-plan-importer-output",
                {
                    "format": "runner-plan-importer-output",
                    "version": 1,
                    "candidates": [],
                    "relations": [{
                        "source_ref": "node:0", "target_ref": "node:1",
                        "role": "loads", "source_refs": ["source:0"],
                    }],
                    "routes": [], "mapping_questions": [],
                    "self_claims": [], "warnings": [],
                },
            ),
            "observer-zone": (
                "runner-artifact-observer-input",
                {
                    "format": "runner-artifact-observer-input",
                    "version": 1,
                    "run_id": "run:2026-07-21-001",
                    "units": [{
                        "ref": "source:0", "kind": "file",
                        "media_type": "text/plain", "label": "Example",
                        "text": "Invented Vera Example observation.",
                    }],
                    "nodes": [{
                        "ref": "node:0", "id": "zone:example",
                        "kind": "zone", "label": "Example",
                    }],
                    "edges": [], "journal_context": [],
                },
            ),
            "observer-performed": (
                "runner-artifact-observer-output",
                {
                    "format": "runner-artifact-observer-output",
                    "version": 1,
                    "artifacts": [{
                        "ref": "proposal:0", "source_ref": "source:0",
                        "artifact_type": "note", "summary": "Example",
                        "touches": [], "supports_state_updates": [],
                        "evidence_strength": "performed",
                    }],
                    "encounters": [], "questions": [],
                    "trail_segments": [], "state_proposals": [],
                    "warnings": [],
                },
            ),
            "observer-condition": (
                "runner-artifact-observer-output",
                {
                    "format": "runner-artifact-observer-output",
                    "version": 1,
                    "artifacts": [], "encounters": [], "questions": [],
                    "trail_segments": [],
                    "state_proposals": [{
                        "ref": "proposal:0", "target_ref": "node:0",
                        "dimension": "condition", "proposed_value": "chronic",
                        "evidence_refs": ["evidence:0"],
                    }],
                    "warnings": [],
                },
            ),
        }
        for name, (schema_name, instance) in cases.items():
            with self.subTest(name=name):
                validator = validate_atlas.SchemaValidator(schemas[schema_name])
                self.assertTrue(validator.validate(instance))

    def test_unsupported_schema_keyword_fails_closed(self):
        with self.assertRaises(validate_atlas.SchemaSubsetError):
            validate_atlas.SchemaValidator({"type": "string", "format": "date"})

    def test_subset_diagnostics_never_echo_rejected_values(self):
        # §24.4: schema-side expectations may be named, but refused values
        # never enter a boundary diagnostic.
        cases = (
            ("SECRET_ENUM_VERA", {"enum": ["allowed"]},
             "allowed choices ['allowed']"),
            ("SECRET_PATTERN_VERA", {"type": "string",
                                     "pattern": "^allowed$"},
             "pattern '^allowed$'"),
            (-987654321, {"type": "integer", "minimum": 0},
             "below minimum 0"),
        )
        for rejected, schema, expectation in cases:
            with self.subTest(rejected=type(rejected).__name__):
                errors = validate_atlas.SchemaValidator(schema).validate(
                    rejected)
                self.assertEqual(1, len(errors))
                self.assertIn(expectation, errors[0])
                self.assertNotIn(str(rejected), errors[0])

    def test_oversize_journal_row_reports_ceiling_without_echo(self):
        # §25.8/§24.4: a 64 KiB row is rejected at the ceiling; its content
        # is neither retained for decoding nor copied into the diagnostic.
        secret = "SECRET_OVERSIZE_VERA"
        oversize = json.loads(VALID_ARTIFACT_ROW)
        oversize["summary"] = secret + "x" * 65536
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                "state/artifacts.jsonl": (json.dumps(oversize) + "\n"
                                          + VALID_ARTIFACT_ROW),
            }, Path(directory))
            code, _, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("state/artifacts.jsonl:1: journal row exceeds "
                      "16384 bytes", stderr)
        self.assertNotIn(secret, stderr)

    def test_multichunk_jsonl_row_round_trips_unchanged(self):
        # SEC-14: a normal row crossing the reader's chunk boundary keeps
        # the same line number and JSON value as the former whole-file read.
        row = json.loads(VALID_ARTIFACT_ROW)
        row["summary"] = "Synthetic Vera Example " + "x" * 10000
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifacts.jsonl"
            path.write_text(json.dumps(row) + "\n", encoding="utf-8")
            rows = list(validate_atlas._read_jsonl(path))
        self.assertEqual([(1, row)], rows)

    def test_valid_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            materialize(VALID_INSTANCE, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("2 intake batches", stdout)
        self.assertIn("0 errors", stdout)
        self.assertEqual("", stderr)

    VALID_RUN_MANIFEST = json.dumps({
        "format": "run-manifest",
        "version": 2,
        "run_id": "run:2026-07-21-001",
        "role": "plan-importer",
        "model": {"provider": "example", "id": "model-1",
                  "parameters": [{"name": "temperature", "value": "0.2"}]},
        "engine_revision": "0" * 40,
        "runner_version": "0.1.0",
        "runner_protocol": {
            "version": 1,
            "commit": "be83303bfbe3a1523c72ebaa3f0baa03389c5832",
        },
        "prompt_bundle": {
            "components": [
                {"id": "plan-importer-core", "version": "1",
                 "sha256": "a" * 64},
                {"id": "runner-plan-importer-input", "version": "1",
                 "sha256": "c" * 64},
                {"id": "runner-plan-importer-output", "version": "1",
                 "sha256": "d" * 64},
            ],
            "sha256": "b" * 64},
        "inputs": {
            "included": [{"path": "plans/imported/example.md", "bytes": 123}],
            "unavailable": [{"path": "atlas/concepts/example.md",
                             "reason": "excluded"}]},
        "budget": {"model_calls": 1, "timeout_seconds": 600,
                   "input_bytes": 123, "input_entries": 1},
        "timings": {"started_at": "2026-07-21T10:00:00Z",
                    "ended_at": "2026-07-21T10:05:00Z"},
        "outcome": "processed",
        "outputs": ["report:plan:example"],
        "warnings": [],
        "decisions": [],
    })

    def test_valid_run_manifest_passes_the_boundary(self):
        # §17.6/§17.7/§25.7: a runner-emitted v2 manifest validates against
        # the closed shape and semantic bindings like any emitted file.
        instance = {
            **VALID_INSTANCE,
            "runs/2026-07-21-001.json": self.VALID_RUN_MANIFEST,
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("0 errors", stdout)

    def test_legacy_run_manifest_v1_remains_readable(self):
        # §25.7/#41: adding the required #46 pin is a version bump, not a
        # retroactive invalidation or a false claim about historical runs.
        manifest = json.loads(self.VALID_RUN_MANIFEST)
        manifest["version"] = 1
        manifest.pop("runner_protocol")
        manifest["prompt_bundle"]["components"] = [
            manifest["prompt_bundle"]["components"][0]
        ]
        instance = {
            **VALID_INSTANCE,
            "runs/2026-07-21-001.json": json.dumps(manifest),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("0 errors", stdout)

        manifest["runner_protocol"] = {
            "version": 1,
            "commit": "be83303bfbe3a1523c72ebaa3f0baa03389c5832",
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, _, _ = self.run_cli("validate", directory)
        self.assertEqual(1, code)

    def test_run_manifest_id_must_match_its_file_name(self):
        # §17.6: run_id is the file's date-serial — a disagreeing pair
        # would let one manifest impersonate another run's audit line.
        instance = {
            **VALID_INSTANCE,
            "runs/2026-07-21-002.json": self.VALID_RUN_MANIFEST,
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("does not match the file name (§17.6)", stderr)
        # §24.4: the mismatched value itself is never echoed.
        self.assertNotIn("run:2026-07-21-001", stderr)

    def test_run_manifest_rejects_free_text_and_unknown_keys(self):
        # §24.1/§24.4: no quoted text — a prose warning and an unknown
        # key both fail closed.
        manifest = json.loads(self.VALID_RUN_MANIFEST)
        manifest["warnings"] = ["secret was seen in file X"]
        manifest["transcript"] = "rendered prompt text"
        instance = {
            **VALID_INSTANCE,
            "runs/2026-07-21-001.json": json.dumps(manifest),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("$.warnings[0]", stderr)
        self.assertNotIn("secret was seen", stderr)
        # §25.7: the unknown key is refused, and its name and value stay
        # out of the diagnostic (§24.4) — the closed key set is shown.
        self.assertIn("closed key set", stderr)
        self.assertNotIn("transcript", stderr)
        self.assertNotIn("rendered prompt text", stderr)

    def test_run_manifest_requires_exact_runner_protocol_pin(self):
        # §17.7: v2 requires the pin, and version plus defining commit are
        # one fail-closed value.
        manifest = json.loads(self.VALID_RUN_MANIFEST)
        manifest["runner_protocol"]["commit"] = "f" * 40
        instance = {
            **VALID_INSTANCE,
            "runs/2026-07-21-001.json": json.dumps(manifest),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("$.runner_protocol.commit", stderr)

        manifest.pop("runner_protocol")
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, _, _ = self.run_cli("validate", directory)
        self.assertEqual(1, code)

    def test_run_manifest_requires_selected_runner_schema_pair(self):
        # §17.7: id presence, uniqueness, version, and role pairing are
        # semantic manifest checks, not claims left to the generic shape.
        cases = {}
        missing = json.loads(self.VALID_RUN_MANIFEST)
        missing["prompt_bundle"]["components"] = [
            component for component in missing["prompt_bundle"]["components"]
            if component["id"] != "runner-plan-importer-output"
        ]
        cases["missing"] = (
            missing, "runner-plan-importer-output' exactly once")

        duplicate = json.loads(self.VALID_RUN_MANIFEST)
        duplicate["prompt_bundle"]["components"].append({
            **duplicate["prompt_bundle"]["components"][1]
        })
        cases["duplicate"] = (
            duplicate, "runner-plan-importer-input' exactly once")

        wrong_version = json.loads(self.VALID_RUN_MANIFEST)
        wrong_version["prompt_bundle"]["components"][1]["version"] = "2"
        cases["version"] = (wrong_version, "must declare version '1'")

        wrong_role_pair = json.loads(self.VALID_RUN_MANIFEST)
        wrong_role_pair["prompt_bundle"]["components"].append({
            "id": "runner-artifact-observer-input",
            "version": "1",
            "sha256": "e" * 64,
        })
        cases["role-pair"] = (
            wrong_role_pair, "outside the selected role's closed pair")

        for name, (manifest, expected) in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                materialize({
                    **VALID_INSTANCE,
                    "runs/2026-07-21-001.json": json.dumps(manifest),
                }, Path(directory))
                code, _, stderr = self.run_cli("validate", directory)
            self.assertEqual(1, code)
            self.assertIn(expected, stderr)

    def test_unsupported_runner_role_is_preflight_only(self):
        # §17.7: governance roles without a closed pair may leave only an
        # aborted, output- and decision-free audit line; they never use a
        # generic payload.
        manifest = json.loads(self.VALID_RUN_MANIFEST)
        manifest["role"] = "field-cartographer"
        manifest["prompt_bundle"]["components"] = [
            manifest["prompt_bundle"]["components"][0]
        ]
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, _, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("must close as aborted at preflight (§17.7)", stderr)

        manifest["outcome"] = "aborted"
        manifest["outputs"] = []
        manifest["warnings"] = ["unsupported-role"]
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("0 errors", stdout)

        manifest["decisions"] = ["decision:example"]
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, _, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("preflight must record no decisions (§17.7)", stderr)

    def test_aborted_runner_manifest_has_no_outputs_and_a_warning_code(self):
        # §17.7: cancellation, timeout, malformed output, and preflight
        # failures all close through one no-output, coded shape.
        manifest = json.loads(self.VALID_RUN_MANIFEST)
        manifest["outcome"] = "aborted"
        manifest["warnings"] = []
        with tempfile.TemporaryDirectory() as directory:
            materialize({
                **VALID_INSTANCE,
                "runs/2026-07-21-001.json": json.dumps(manifest),
            }, Path(directory))
            code, _, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertIn("must record no outputs (§17.7)", stderr)
        self.assertIn("must record a stable warning code (§17.7)", stderr)

    def test_stale_route_step_resolves_through_formerly(self):
        # §34.4: steps already use the survivor while material_roles[].step
        # still names the retired id — the ref resolves through the map
        # with a warning, never a membership error (the builder accepts
        # exactly this curation).
        instance = {
            **VALID_INSTANCE,
            "atlas/concepts/example.md": VALID_CONCEPT.replace(
                "aliases: []",
                "aliases: []\nformerly:\n  - concept:old-example",
            ),
            "atlas/suggested-routes/example-default.md": VALID_ROUTE.replace(
                "  - step: concept:example",
                "  - step: concept:old-example",
            ),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("stale curated ref concept:old-example resolved "
                      "to concept:example (§34.4)", stdout + stderr)

    def test_classed_material_passes_the_boundary(self):
        # §32.6/§33.3: a classed curated material is boundary-legal —
        # the schema admits the sensitivity class the builder's
        # via-tainting reads from.
        instance = {
            **VALID_INSTANCE,
            "atlas/materials/example-docs.md": VALID_MATERIAL.replace(
                "status: active", "status: active\nsensitivity: medical"),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(instance, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)

    def test_optional_row_fields_stay_optional_in_the_graph(self):
        # §10.4 embeds the row fields: a background encounter has no
        # context (§9.7) and a landing segment has no resulting_questions
        # (§9.9) — the graph boundary must accept both.
        graph = VALID_EMPTY_GRAPH.replace(
            '"nodes": [],',
            '"nodes": [{"id": "material:m", "type": "material", "title": "M",'
            ' "fields": [], "kind": "docs", "url": "", "status": "active"},'
            ' {"id": "direction:d", "type": "direction", "title": "D",'
            ' "fields": [], "attractor": "a", "status": "active"},'
            ' {"id": "concept:a", "type": "concept", "title": "A",'
            ' "fields": ["knowledge"], "aliases": []},'
            ' {"id": "encounter:e", "type": "encounter", "title": "E",'
            ' "fields": [], "date": "2026-07-16", "target": "material:m",'
            ' "depth": "skim", "mode": "background"},'
            ' {"id": "trail-segment:2026-07-16-001", "type": "trail_segment",'
            ' "title": "", "fields": ["knowledge"], "date": "2026-07-16",'
            ' "direction": "direction:d", "to": "concept:a",'
            ' "via": ["material:m"], "reason": "r"}],',
        )
        graph = graph.replace(
            '"edges": [],',
            '"edges": [{"source": "trail-segment:2026-07-16-001",'
            ' "target": "material:m", "type": "via",'
            ' "provenance": ["trail-segment:2026-07-16-001"]},'
            ' {"source": "encounter:e", "target": "material:m",'
            ' "type": "visited", "provenance": ["encounter:e"]}],',
        )
        with tempfile.TemporaryDirectory() as directory:
            materialize({"graph/atlas-graph.json": graph}, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)

    def test_demo_instance(self):
        root = ROOT / "fixtures" / "demo-instance"
        code, stdout, stderr = self.run_cli("validate", str(root))
        self.assertEqual(0, code, stderr)
        self.assertIn("11 frontmatter documents", stdout)

    def test_each_negative_instance_emits_error(self):
        for name, tree in sorted(INVALID_INSTANCES.items()):
            with self.subTest(case=name):
                with tempfile.TemporaryDirectory() as directory:
                    materialize(tree, Path(directory))
                    code, stdout, stderr = self.run_cli("validate", directory)
                self.assertEqual(1, code)
                self.assertIn("ERROR:", stderr)
                self.assertIn("errors", stdout)
                self.assertTrue(
                    all(line.startswith("ERROR:") for line in stderr.splitlines())
                )

    def test_unknown_property_diagnostic_does_not_echo_the_key(self):
        # §24.4: a rejected key name is rejected content — the diagnostic
        # shows the closed key set (the expectation), never the stray key.
        with tempfile.TemporaryDirectory() as directory:
            materialize(INVALID_INSTANCES["unknown-curated"],
                        Path(directory))
            code, _, stderr = self.run_cli("validate", directory)
        self.assertEqual(1, code)
        self.assertNotIn("stray", stderr)
        self.assertIn("closed key set", stderr)

    def test_intake_schema_positive_and_negative_documents(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        directory = ROOT / "fixtures" / "schema" / "documents"
        valid = validate_atlas._read_json(directory / "atlas-intake.valid.json")
        invalid = validate_atlas._read_json(directory / "atlas-intake.invalid.json")
        validator = validate_atlas.SchemaValidator(schemas["atlas-intake"])
        self.assertEqual([], validator.validate(valid))
        self.assertTrue(validator.validate(invalid))

    def test_invalid_intake_record_in_valid_envelope_warns_never_errors(self):
        # §33.2/#56: a schema-invalid record is the flow's per-record
        # refusal, recorded in the batch report, while the delivery stays
        # preserved as the audit original — the validator surfaces it as a
        # warning, never as permanent instance invalidity.
        tree = {
            "intake/watch-sync/2026-07-16-001.json": VALID_INTAKE_BATCH.replace(
                '"text": "synthetic Vera Example question?"',
                '"text": "synthetic Vera Example question?", "stray": "x"',
            ),
        }
        with tempfile.TemporaryDirectory() as directory:
            materialize(tree, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("WARNING:", stderr)
        self.assertNotIn("ERROR:", stderr)
        self.assertNotIn("stray", stderr)
        self.assertIn("1 warnings", stdout)

    def test_check_constants(self):
        code, stdout, stderr = self.run_cli("check-constants")
        self.assertEqual(0, code, stderr)
        self.assertEqual("checked constants: 0 errors\n", stdout)

    def test_usage_exit_code_and_diagnostic(self):
        code, stdout, stderr = self.run_cli()
        self.assertEqual(2, code)
        self.assertEqual("", stdout)
        self.assertTrue(stderr.startswith("ERROR: usage:"))


if __name__ == "__main__":
    unittest.main()
