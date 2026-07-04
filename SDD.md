# System Design Document: Atlas

**Version:** 0.3
**Status:** Draft
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
- §6 Core Ontology — glossary: Field, Concept, Material(Part), Encounter, Artifact, Probe, Question, Route, Trail, Influence, State, Frontier
- §7 High-Level Architecture — plan-import and artifact-observation pipelines
- §8 Repository Layout — placement principles + normative skeleton
- §9 Data Model — schemas: Concept, Material, MaterialPart, SuggestedRoute, Direction, Artifact, Encounter, Question, Trail, InfluenceField, Probe, Evidence, StateDecision
- §10 Graph Model — node types, edge types, edge metadata
- §11 Primary and Supporting Materials — contextual roles per route/question/trail
- §12 Plan Import Flow — inputs, import steps, example
- §13 Artifact Observation Flow — inputs, observation steps, example
- §14 State Update Rules — scales; evidence→exposure transitions; review-gated dimensions; freshness decay; material state
- §15 Frontier Computation — inputs, output format, allowed/forbidden wording
- §16 Viewer Design — modes, visual semantics, required UI behavior
- §17 Agent Architecture — four core roles and agent rules
- §18 Codex Role — checkpoints and challenge questions
- §19 Boundary Checker — forbidden terms, scanned paths
- §20 Graph Builder — build steps, stdlib-only MVP
- §21 Importer Design — hybrid deterministic + agent import
- §23 Progression Model — movement loop, no completion
- §24 Security and Privacy — local-first, ignore paths
- §25 Non-Functional Requirements — versionable, auditable, low pressure; domain-parameterized core (§25.5)
- §26 MVP Scope — must have / can skip
- §27 Acceptance Criteria — 10 MVP checks
- §28 Risks and Mitigations — drift risks and countermeasures
- §29 Implementation Phases — Phase 0–5
- §30 Final Design Statement — three layers that must never collapse
- §31 Key Invariants — eight hard rules; approved 2026-07-04
- Decision Log — dated one-line decisions with rejected alternatives

---

