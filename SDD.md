# System Design Document: Atlas

**Version:** 0.6
**Status:** Partial freeze — knowledge vertical active; Body Atlas implementation frozen
**Project:** Atlas — graph-first personal knowledge-state system
**Primary goal:** Extract proposed learning routes from plans, but preserve and visualize the user’s real personal trail, knowledge state, and influence field over time.

---

## § Index

Section numbers are stable: issues and the Decision Log cite them as `§7` / `§7.2`. Never renumber. New sections take the next free number or a sub-number; update this index when sections change. Retired numbers are never reused: §22 (2026-07-04, merged into §12.3).

Layout: this file is the map. Each top-level § lives in `spec/NN-slug.md` (file name starts with the § number); the Decision Log lives in `DECISION-LOG.md`. Point reads: open the § file. Full pass: read `spec/` files in index order.

- §1 Executive Summary — six layers (FieldGraph → Frontier); never a TODO system
- §2 Problem Statement — suggested route vs the user's real learning trail
- §3 Goals — product goals; cognitive goals (no guilt)
- §4 Non-Goals — forbidden framings and states (todo/done/deadline…)
- §5 Core Principles — routes optional; trail sacred; understanding not imported; materials ≠ concepts; primary/supporting contextual
- §6 Core Ontology — glossary: Field, Concept, Zone, Pattern, Material(Part), Encounter, Artifact, Probe, Question, Route, Trail, Influence, State, Frontier; canonical kind list
- §7 High-Level Architecture — plan-import and artifact-observation pipelines
- §8 Repository Layout — placement principles + normative skeleton
- §9 Data Model — schemas: Concept, Material, MaterialPart, SuggestedRoute, Direction, Artifact, Encounter, Question, Trail, InfluenceField, Probe, Evidence, StateDecision, SupportRelation, Plan (§9.15); influence baseline v1 (§9.10)
- §10 Graph Model — node types, edge endpoint/ownership matrix (§10.2), edge metadata; per-kind node contract and field membership (§10.4)
- §11 Primary and Supporting Materials — contextual roles per route/question/trail: route authored, question/trail derived (§11.1–§11.3); standing support boundary (§11.4)
- §12 Plan Import Flow — inputs, import steps, example; re-run semantics (§12.4)
- §13 Artifact Observation Flow — inputs, observation steps, example
- §14 State Update Rules — scales; evidence→exposure transitions; review-gated dimensions; freshness decay; material state; edge weight (§14.9)
- §15 Frontier Computation — inputs, output format, allowed/forbidden wording; deterministic baseline v1 (§15.4)
- §16 Viewer Design — modes, per-geometry visual semantics (node-link, silhouette), required UI behavior, embedding (§16.4)
- §17 Agent Architecture — four core roles and agent rules
- §18 Codex Role — checkpoints and challenge questions
- §19 Boundary Checker — forbidden terms, scanned paths
- §20 Graph Builder — build steps, stdlib-only MVP; fold ordering + as-of (§20.1), write discipline (§20.2), edge emission discipline (§20.3), frontmatter grammar (§20.4)
- §21 Importer Design — hybrid deterministic + agent import; dry-run/commit, mapping decisions (§21.3)
- §23 Progression Model — movement loop, no completion
- §24 Security and Privacy — local-first, ignore paths
- §25 Non-Functional Requirements — versionable, auditable, low pressure; domain-parameterized core (§25.5); durable (§25.6); persisted formats and schemas (§25.7); executable floors (§25.8)
- §26 MVP Scope — must have / can skip; manual observation floor
- §27 Acceptance Criteria — 11 Given/When/Then checks over named golden fixtures
- §28 Risks and Mitigations — drift risks and countermeasures
- §29 Implementation Phases — guard/contract trunk + parallel verticals + integration proof; partial-freeze posture and Body Atlas gate
- §30 Final Design Statement — three layers that must never collapse
- §31 Key Invariants — eight hard rules; approved 2026-07-04
- §32 Body Atlas — second domain instantiation: zones+patterns field, body scales, capture spectrum, honest frontier (§15.3), medical layer
- §33 External Exchange — blind peers, adapters outside: activity/plan intake (evidence-only), state snapshot export (state-as-evidence), embeddable viewer (§16.4)
- §34 Deletion and Id Lifecycle — two tiers (logical/purge), provenance closure, purge notes, `formerly` redirects, split-as-curation, id hygiene
- Decision Log — dated one-line decisions with rejected alternatives

---
