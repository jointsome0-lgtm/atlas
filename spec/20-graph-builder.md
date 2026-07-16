## §20. Graph Builder

`scripts/build_atlas_graph.py` should:

```text
1. Read concept, pattern, and zone frontmatter (§32.1).
2. Read material frontmatter.
3. Expand MaterialPart nodes.
4. Read direction files.
5. Read suggested routes.
6. Read trail segments.
7. Read probes.
8. Read questions, artifacts, encounters, and decisions from state/ (JSONL journals);
   build the retired→living id map from formerly: frontmatter and resolve
   journal and curated refs through it (§34.4).
9. Fold current understanding, material, question, and body state from the journals (§14.5–§14.8, §9.8, §9.13; body mappings §32.2–§32.3): exposure and zone contact = monotone max over mapped evidence; confidence/clarity/coverage and the gated body dimensions (§32.2) = last confirmed decision, else the scale's no-knowledge value (§14.6 — condition `unknown`, never an implicit `fine`); question status = last confirmed decision, else open; depth_reached/last_seen from encounters. Ordering and the as-of bound: §20.1.
10. Compute the influence field and the frontier from artifacts, encounters, questions, and trail segments (§9.10 baseline, §15.4).
11. Validate references — §34.4 included: a retired id that is living,
    or present in two formerly lists, is an error.
12. Emit graph/atlas-graph.json per the §10.4 node contract (`fields` membership, per-kind payload), embedding the silhouette projection collected from zone frontmatter (`figure_region`, §32) under `projections` (§10) — the viewer's single input stays single (§16.4). The emission carries the §32.6 sensitivity class by provenance union: every entry the union marks — a node payload with persisted `sensitivity` (§10.4), a derived value resting on a classed row, an influence source, a frontier item citing classed evidence, a trail segment with classed `via` — is emitted with `sensitivity: <class>`.
```

The default emission is complete — a local file that, containing classed entries, sits under the §32.6 default agent-context exclusion like the journals it derives from. `--redact` emits the agent-facing variant `graph/atlas-graph.redacted.json` beside the full graph, never instead of it: everything the §32.6 union marks is omitted whole at its own granularity — a value with its decisions and evidence refs, an item, a source, a node payload — never rewritten, and a top-level `withheld` key maps each top-level §10 key to its omission count: counts only, never ids (§32.6). The full graph never carries `withheld` — nothing was.

Step 11 classifies a broken reference by the ref's origin, never the target's kind: a ref in a retained journal row — whatever it targets: a trail segment, artifact, encounter, question, or a curated node (zone, material, concept, pattern) — is skipped with a warning, never a build failure — deletion is the owner’s right (§5.2), and §34.2 promises exactly such survivors; a ref authored in a living curated file is an error — curation converges (§34.4), journals never have to. The report groups dangling journal refs apart from curated-link errors; purge notes explain purge-era dangles (§34.2–§34.3).

## §20.1 Fold Ordering and As-Of

The fold is totally ordered and anchored (#34):

```text
Order: (activity date, then journal position). A journal's
rotated per-year files (§8) concatenate lexicographically; the
concatenation is the journal, and position counts through it.
Backfill is ordinary (§33.2): an earlier-dated record never
beats a later-dated one, whenever it was appended; a same-day
tie on the same target and dimension resolves by journal
position. No ordering across journals exists or is needed —
every order-sensitive reduction has exactly one ordering
stream ("last confirmed decision" reads decisions.jsonl
alone); a fold joining several journals (§14.5 exposure over
artifacts and encounters) is monotone max, order-free. A
global merge-sort must not be invented.
Duplicates: a byte-identical row repeated within a journal —
the rotation concatenation included — folds once, with a
WARNING in the build report (the crash-double-append story;
§33.2 receipts stay the intake lane's stronger guarantee).
As-of: the builder takes --as-of <date>; default = the max
activity date across the dated inputs — journal rows and
trail segments alike (segments are dated curated files and
feed step 10; an input universe that ignored them would leak
future influence and heads into a dated graph). As-of is
anchor and upper bound over that whole universe: steps 9–10
read records and segments with date ≤ as-of only — anything
dated later is skipped and counted in the build report, never
silently. A decision inside the cut citing evidence outside
it applies with a step-11 dangling-ref warning — exactly what
the build on that date showed. At the default the filter is a
no-op; an explicit earlier as-of is §25.3's "state at date X",
executable.
Freshness derives against as-of (§14.7), never the wall clock;
the emitted graph carries generated_at = as-of at UTC midnight
(2026-07-15T00:00:00Z — the §10/§33.4 shape). Empty inputs
still build: with no dated record and no flag, generated_at
and the freshness fields are absent, not invented.
Determinism: same inputs + same as-of ⇒ byte-identical output.
```

## §20.2 Write Discipline

```text
Every graph/ emission writes a temp file inside graph/ and
atomically renames it into place — a crash never leaves a torn
atlas-graph.json (§16.4 reads exactly one file).
The builder is a writer like any other: it takes the instance
lock and a second concurrent run refuses with exit 1 (§25.6).
```

No external dependencies for MVP.

Allowed standard library:

```text
json
pathlib
datetime
re
```

If YAML is needed, either:

```text
use simple frontmatter parser manually
or vendor a tiny parser
or require PyYAML later
```

MVP should prefer minimal dependencies.

---

