## §34. Deletion and Id Lifecycle

Instance-side deletion semantics and the life of a stable id: the two
deletion tiers, what a purge removes (closure), what survives and why,
and how ids are renamed, merged, and retired. This section owns the
data-model half; the git/backup mechanics (copies manifest, delivery
registry, revocation runbook) live on the composing shell's deletion
page.

## §34.1 Two Tiers

```text
logical deletion — the everyday default for every record and file,
    journal rows included: the user edits or deletes freely (§5.2 —
    actor-scoped; automation never), history retains the content in
    the owner's private copies, derived consumers tolerate the
    vanished id (§20, §33.4); no external guarantee is claimed.
purge — content leaves current state, history (filter-repo-style
    content redaction), and every registered copy (the revocation
    runbook). The one carve-out from §8/§25.6 no-truncating-
    compaction, granted by standing Decision Log entry (2026-07-14),
    never silently.
```

Purge triggers by sensitivity, never by path or data kind:

```text
class-default   — a record carrying a §32.6 sensitivity class is
                  purged when deleted; logical deletion of a classed
                  record is the explicit exception.
owner-declared  — anything the owner decides must be unrecoverable,
                  class or no class: accidental captures —
                  credentials, third-party data, text in the wrong
                  file.
```

Urgency: accidental entry → immediate; planned retirement of a
legitimately-lived record → the owner's schedule; several redactions
may batch into one rewrite (one §34.3 note) — a rewrite invalidates
every copy and is expensive.

## §34.2 Purge Closure

The rewrite set is computed, never guessed — provenance closure, the
same travel rule the §33.4 default exclusion uses:

```text
in the set: the record's originals (intake/<source>/ lines,
    plans/imported/<class>/, curated files) plus every journal row
    derived from it — found mechanically via provenance
    (intake:<source>/<batch>#<n>), source/probe links, and evidence
    refs — whose only §9.12 basis it is: a trail segment with
    via: [it] alone, a question extracted from it, a decision citing
    only it. Plus every generated file whose only provenance is the
    record: the SuggestedRoute and candidate stubs a classed input
    created (§33.3) — they carry its class until the user re-authors
    them. In current state and in historical blobs.
survives whole, refs dangling (§20 warns and skips): any row with
    other live bases — a segment or decision citing the record among
    others, a decision targeting a purged node on live evidence. Row
    content is never edited: an automation-rewritten via or evidence
    list would claim the user recorded it that way — falsified
    memory (§31.2, §25.3). Rows are removed whole or kept whole.
    The row's persisted §32.6 class (§33.2) survives with it — a
    named residual, never described as only a dangling id: "classed
    provenance existed at this row" remains readable instance-side,
    while the class itself keeps the row inside the §33.4 default
    exclusion, so the bit never leaves by default. The deletion
    page's residual inventory names this class.
survives deliberately: receipts (§33.2, every lane's) — provenance
    without content, keeping purge idempotent against a stale batch
    redelivery or re-import — and the per-event purge note (§34.3).
```

The closure is reviewed before the rewrite runs: the runbook presents
the computed set and the owner adjusts it by declaration — extending:
a surviving row whose free text (a segment's `reason`, a question's
text) paraphrases the purged content, or a class-carrying survivor
whose retained association is itself telling (pulled in whole, never
edited); rescuing: a question that outgrew its purged source, or a
since-curated candidate stub (§33.3), is re-authored as the user's
own instead of dying with the source.

Derived outputs are in no rewrite set (§25.6, §31.8); the mandatory
post-purge step is a rebuild.

No new tolerance mechanism: no tombstone kind, no acknowledged-
dangles registry — dangling refs stay dangling, §20 tolerates them
(grouped in the build report apart from curated-link errors), the
purge note explains them to a later reader. Revisit trigger: dangle
noise actually hurting on a live instance.

## §34.3 Purge Notes

`state/purges.jsonl` (§8) — one append-only row per purge event,
content-free by construction:

```json
{"date": "2026-07-14", "classes": ["medical"], "gen": 1}
{"date": "2026-09-02", "gen": 2}
```

`classes` lists the §32.6 classes involved, omitted for a purely
owner-declared purge. `gen` is a monotone per-instance counter —
content-free by construction, it names the operation: two same-day
purges stay distinguishable, and the composing shell's completion
marks (the manifest and delivery-registry ack columns on its
deletion page) cite it, so an interrupted revocation walk resumes
against exactly this purge. Nothing else — no ids, no counts, no
reasons: the note must survive every future rewrite untouched. Like
receipts it is provenance, not evidence: §9.12 is untouched,
the §20 fold never reads it. Roles: explains that era's dangling
refs to a later reader; anchors export invalidation — every
registered delivery either carries this `gen` as its supersession
ack or is walked (the delivery registry lives on the composing
shell's deletion page). Per-event notes never enter this engine's
Decision Log: purge metadata stays instance-side — the standing
carve-out entry records the operation, never the events.

What survives still correlates, and the correlation is named, not
denied: a dangling date-serial id (type/date/ordinal), this note's
date and classes, and the §20 build report's grouped dangles
together bound "a classed record existed that day, at least N of
them". By design — none of the three is exported, so the surface is
instance-side only; the deletion page's residual inventory carries
it (§34.6).

## §34.4 Rename and Merge: `formerly`

A curated node's id changes by retiring the old id into the
survivor's `formerly:` list — rename and merge are one operation
(identity continuation, n→1); which one it was is the git story:

```yaml
id: concept:k8s
title: Kubernetes
formerly:
  - concept:kubernetes    # merged duplicate
  - concept:k8s-basics    # union: was on kubernetes's own list
aliases:
  - кубернетес            # search strings (§9.1), never ids
```

```text
formerly holds ids; aliases holds search vocabulary — never mixed.
The old file is removed (git mv / rm); absorbing a node with its
    own formerly list takes the union — every retired id lives in
    exactly one living list.
Journals are never rewritten for a rename: a row keeps the id the
    user recorded then (§25.3); the builder resolves.
Builder (§20): builds the retired→living map before folding;
    resolves journal refs (touches, via, pulls, evidence, targets)
    and curated refs through it; evidence unions onto the survivor —
    the §14.5 monotone fold is unchanged, decision streams merge by
    date.
Validation: a retired id that is also living, or present in two
    formerly lists, is a build error — a 1→n redirect is
    unrepresentable. Stale curated refs resolve but are listed in
    the build report: curation converges, journals never have to.
Purge overrides retirement: an owner-declared purge of a retired
    id removes it from the survivor's formerly list as part of the
    rewrite set — its surviving journal refs are already in the
    extended set (§34.6), so post-purge there is nothing left to
    resolve. Reuse protection for a purged id falls back to the
    §34.6 discipline clause: no list of purged ids exists anywhere,
    by construction — keeping one, hashed or not, would keep the
    content.
Scope: curated nodes only. Journal record ids (artifact:,
    encounter:, question:, trail-segment:) get no redirect
    machinery — hand-editing the row is the owner's mechanism
    (§5.2), refs dangle per §20.
```

## §34.5 Split Is Curation

There is no 1→n redirect — deliberately (§5.3). A split is ordinary
curation:

```text
create the finer nodes — they start unseen (§5.3);
the coarse node lives on as the umbrella, its evidence honestly its
    own, linked by ordinary edges (extends, related_to);
if the coarse name was simply wrong (one id covered two things),
    merge it into the successor that genuinely continues its
    identity (§34.4), or delete it (logical deletion, refs dangle);
re-attributing old evidence to a finer node is the owner's own
    hand-edit or new evidence — never an automatic flow.
```

## §34.6 Id Hygiene and Retirement

Refs to purged records deliberately survive (§34.2), so the id is
what remains — it says nothing beyond type, date, and ordinal
(what remains still correlates: §34.3 names the surface):

```text
§32.6-classed records and classed curated files take
    non-descriptive date-serial ids at creation —
    <type>:<YYYY-MM-DD>-<NNN>, the §9.9 trail-segment pattern
    (artifact:2026-07-14-003, material:2026-07-14-m1). The title
    stays in the file body: content, purged with it.
Unclassed records keep descriptive ids — readability is the
    default. An owner-declared purge of a telling id extends the
    rewrite set to its surviving refs (the runbook greps history
    for purged ids); expecting deletion, take date-serial
    voluntarily.
Sensitive adapters take neutral source/batch slugs (source: feed-1;
    batch: date-serial, §33.2): provenance refs and receipts survive
    purge by design — a telling slug would put the class in every
    one of them. An adapter-contract convention: the composing shell
    enforces it, atlas cannot — source is opaque (§33.2).
A retired id — renamed, merged, deleted, or purged — is never
    reused: a new node under an old id silently inherits the old
    id's surviving refs — fabricated history. Machine-checked where
    possible (§34.4 validation); discipline elsewhere — a purged id
    entirely so: purge overrides retirement (§34.4), the id leaves
    formerly with the rewrite, so no machine-readable trace of it
    remains to check against.
```

---
