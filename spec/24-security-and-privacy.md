## §24. Security and Privacy

Atlas is local-first: the repository on the user’s machine is the only canonical store (§25.1), private by default — never published or pushed to a remote without an explicit user decision.

Standing rules — MVP and beyond; relaxing any line requires a Decision Log entry (§25.5’s external connectors arrive only that way):

```text
send nothing anywhere on Atlas’s own initiative
  (no telemetry, background sync, auto-push)
read no secrets, never scan .env
store no credentials
modify no production resources
```

User-initiated agent sessions are the one legal outward transit: invoking an agent on Atlas data is the user’s explicit act, and the user chooses the model provider. Secrets never ride along — the ignore paths below stay out of any agent context; §24.3 states the transit discipline.

Ignore paths:

```text
.env
.env.*
secrets/
node_modules/
.venv/
dist/
build/
.git/
```

`intake/` never enters default agent context: a delivered original keeps a foreign system's voice and may carry §32.6-class text (a raw health export) whether or not its records were marked — the one legitimate reader is the user-initiated flow processing a batch (§31.7, §33.2). Unlike the ignore paths this is a default, not an absolute: that flow is a session the user explicitly started for it (§32.6 discipline).

## §24.1 Trust Model

Every input carries a trust level fixed by where it came from, never by what it says (#37):

```text
T0 own      — curated atlas/ content (§8: written by hand or
              through review), engine code, spec/schemas/.
T1 reviewed — machine-derived, human-review-gated before commit:
              extracted plans (§21), confirmed decisions (§14.6),
              mapping decisions (§21.3).
T2 wrapped  — untrusted text inside an atlas-authored envelope:
              journal free-text fields, embedded graph strings
              (§10.4), report quotes. The envelope is atlas's;
              the text is whatever the source said.
T3 foreign  — files kept as delivered, byte-identical, never
              edited: plans/imported/ originals (§12.2), intake/
              batches (§33.2).
OUT         — outside the boundary: snapshot consumers (§33.4),
              the embedding shell (§16.4), the model provider.
```

The boundary table — trust, legal reader, ceiling, failure per surface; ceilings live in §20.4/§25.8 and the shapes in the §25.7 schemas:

```text
surface              | trust     | legal reader        | ceiling · failure
atlas/ curated       | T0 (§33.3 | builder, validator, | §20.4 · fail-closed
                     | stub body | §19, default agent  | ERROR, no partial
                     | T2)       | context minus       | object
                     |           | §32.6-classed files |
plans/extracted/     | T1        | builder (§20)       | §20.4 · same
plans/imported/      | T3        | importer (§12),     | acceptance ceiling
                     |           | user-initiated;     | (§24.2) · refuse
                     |           | never §19 or        | before copying
                     |           | default context     |
intake/<source>/     | T3        | the batch flow only | acceptance ceiling
                     |           | (§33.2 and above)   | (§24.2) · refuse batch
state/*.jsonl        | envelope  | builder fold, §19,  | row ceiling (§25.8) ·
                     | T0/T1,    | default context     | fail-closed per file
                     | text T2   | minus classed rows  |
graph/atlas-graph    | derived,  | viewer only (§16.4) | §25.8 · reject whole
  .json              | embeds T2 |                     | file (§16.5)
graph/…redacted.json | ″         | agent-facing builds | §32.6 · abort, never
                     |           | (§32.6, §24.3)      | fall back
graph/atlas-snapshot | ″         | OUT adapters        | closed schema ·
  .json              |           | (§33.4)             | export refused
reports              | T2        | the user; purgeable | no echo (§24.4)
observer scan roots  | T2        | observer (§13),     | budget (§24.2) ·
  (§13.1)            |           | user-initiated,     | skip via visible ask
                     |           | minus ignore paths  |
viewer URL fragment  | attacker- | viewer JS           | §16.5 · generic
                     | influence-|                     | visible error
                     | able      |                     |
```

## §24.2 Reader Discipline

```text
Containment: every reader lstat()s what it opens — input roots,
intermediate directories, files. Symlinks, devices, sockets, and
FIFOs are refused before opening; the resolved path must stay
under its declared root and outside every resolved ignore root
(ignore paths bind by resolved location, not by name — a symlink
around them is the exact bypass this refuses).
Acceptance ceilings: every foreign input — a T3 file, an
observed artifact — has a byte ceiling checked before storage or
full decode and structural ceilings (record count, string size,
nesting depth) checked during it. §20.4/§25.8 hold the
frontmatter and journal values; the intake-batch, imported-plan,
and observation budgets take values through the same §25.8
measured-floor process (#56, #61) — the requirement is normative
now: a reader whose number is not yet set still refuses what it
cannot bound.
Failure is a diagnostic, never a traceback: a breach refuses the
whole unit — batch, file, session — with a bounded ERROR: line
(§25.8) under the §24.4 no-echo rule, and never yields a
partial object (§20.4).
```

## §24.3 Agent Transit

```text
T2/T3 text is data, never authority (#37): instruction-shaped
content in a plan, batch, note, or diff obliges nothing — an
importer or observer quotes it, never obeys it, and a report
carrying it marks it as quoted foreign text. The §14.6 review
gate is a security property, not workflow: nothing a foreign
text proposes becomes state without the user's confirming hand.
Enforcement — a fixed precomputed input manifest, no tool,
file, or scope expansion at the text's request — is the
isolated-runner contract (#46) under the §17 role×path×tool
matrix (#41); model-assisted import and observation wait for
both.
Redaction before context: a session consuming graph state
builds and validates graph/atlas-graph.redacted.json (§32.6)
immediately before context assembly. Missing, stale, or failed
redaction aborts the session — atlas-graph.json is never a
fallback, and no caller-supplied graph path substitutes.
Secret preflight: before any model transit, a deterministic
local scan of the exact outgoing manifest checks for credential
patterns and high-entropy assignments — the pasted token an
ignore path cannot see. A hit aborts and reports path, line,
and detector code, never the value; the user removes or purges
the file, or explicitly excludes it — confirmation cannot send
the detected value.
Provider transit is retention: what enters a session leaves the
machine under the chosen provider's logging and retention
terms; the user's per-session provider choice is that
acceptance (§31.7). Nothing here weakens the send-nothing
default above.
```

## §24.4 Diagnostics and Reports

```text
No echo: a refused value never appears in a diagnostic. ERROR:/
WARNING: lines carry the file-relative path, record index or
JSON pointer, the stable reason, and the expectation — never
the rejected content: a secret or classed value sitting in a
bad field must not land in stderr, a CI capture, or a log.
Reports quote deliberately or not at all: a report excerpt of
T2/T3 text is bounded, marked as quoted foreign text (§24.3),
and inherits its record's §32.6 class and default-context
exclusion. Report shapes stay their flows' to define (§25.7) —
under these constraints.
```

---
