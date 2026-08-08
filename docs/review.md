# Review

A review pass judges an existing rendering instead of producing one. It is the
second lifecycle over the same runner, the same store contract and the same
provider layer, and it exists because the interesting question about a
translated corpus is rarely "did every row come back" - it is "which rows are
wrong, and what should they say instead".

This page owns the **review contract**: what a review job is, what the reviewer
is asked, and what a well-formed answer looks like. The durable half - the
tables, the version stamp and the migration - is in
[architecture.md](architecture.md#the-review-half).

## The one property everything else protects

**The reviewer proposes; it never mutates.** Nothing in the review half writes
to the translation corpus. A proposal is a value stored beside the current one,
and adopting it is a separate, human, auditable step. Every design decision
below is downstream of that: the verdict is a claim rather than an action, a
proposal is nullable so that "keep what is there" is expressible, and the
graded fields exist so a human can triage a thousand proposals without reading
all of them.

## A review job

```ts
const reviewJob: ReviewJob = {
  id: 'glossary-review',
  translation: glossaryJob,      // the pass whose output is under review
  promptTemplate: reviewGuidance,
  showSource: true,
};
```

It **carries** the `TranslationJob` rather than restating it. A review whose
idea of the fields or the language pair differs from the pass that produced them
is reviewing a corpus that does not exist, and carrying the job makes that
impossible rather than unlikely. From it come the fields, both languages, and
`normalize`.

Five optional pieces:

| Field | What it does |
|---|---|
| `reviewFields` | Narrows what is judged. Defaults to the job's translatable fields. |
| `terminology` | Standing reference text, rendered as the prompt's `TERMINOLOGY` block. |
| `extraInputs` | Host inputs the run id must depend on. See [below](#host-inputs-and-the-run-id). |
| `severityLevels` | Overrides the severity scale. |
| `confidenceLevels` | Overrides the confidence scale. |

`reviewFields` narrower than translatable is a real case rather than an
oversight: a corpus whose long prose field deserves a reviewer's attention and
whose short label field does not costs less to review and produces fewer
proposals nobody asked for.

`terminology` is **text**, not a structure. What a term entry looks like is a
judgement about one language pair and one domain, and a library that parsed one
would be making that judgement for every host.

## `showSource`, and why the monolingual pass is a different job

`showSource: false` withholds the source: the row snapshot carries only the
current target value, and the framing asks for a coherence judgement rather than
a fidelity one. It reads like a flag and it is really two jobs, because the two
need different guidance to be worth running - and because a review run's id is
derived from its inputs, so the distinction has to be visible to whatever hashes
them.

Consistency evidence still reaches a monolingual prompt. It is keyed by source
value internally, but only the *target* renderings are printed, so a coherence
pass still learns that the corpus says this two ways without being shown the
thing the pass is meant to hide.

## The prompt

`buildReviewPrompt(job, identifier, source, target, evidence?)` composes:

```
<promptTemplate, right-trimmed>

Review these fields translated from English into French: name, description.

TERMINOLOGY:
<terminology, trimmed>

CONSISTENCY EVIDENCE (other target renderings of the same source in this corpus):
{"name":["...","..."]}

Reply with EXACTLY ONE JSON object matching the review output schema and nothing else.

ROW SNAPSHOT:
{"identifier":"AC-1","fields":{"name":{"source":"...","current":"..."}}}
```

Two properties are worth relying on.

**Both optional blocks vanish cleanly.** A job with no terminology and a row
with no evidence produce a prompt byte-identical to one composed by a caller
that has neither. That is the same guarantee `promptExtras` gives on the
translate side, and it is what makes adding a termbase to a corpus mid-review a
visible change (a different run id) rather than a silent one.

**The snapshot is last, after `ROW_SNAPSHOT_MARKER`.** A parser - the offline
provider, a capture harness, a debugging one-liner - can find the payload
without knowing anything about the guidance above it.

Evidence is emitted in the job's field order, not in the order the caller
happened to build the object, so the prompt bytes do not depend on that.

## Consistency evidence

`buildConsistency(job, rows)` finds every source string the corpus renders more
than one way, per field. It is the only reference material in a review run that
the library derives rather than receives, and the reason it is not left to the
host is that **its output hash is one of the run id's inputs**: two hosts
analysing one corpus their own two ways would disagree about what run they are
looking at, which is the thing a derived run id exists to prevent.

It knows nothing about words, morphology or segmentation. It knows that the same
source string came back as two different target strings somewhere in the same
corpus, which is a fact about the corpus rather than a judgement about either
rendering. Deciding which rendering is right is the reviewer's job, and that is
why the evidence is shown to the model instead of being resolved before it.

Three rules decide what counts:

- A row with **no source value** for a field contributes nothing to that field.
- A row with a source value and **no target value** contributes the empty string
  as a rendering. A field present in some rows and absent in others is exactly
  the kind of inconsistency worth showing a reviewer, and dropping it would hide
  it.
- A source rendered **one** way produces no entry at all. Every analysed field
  still gets a key, so the serialization has the same shape whether or not
  anything was found.

Two views are taken off one analysis:

| | Shape | Who reads it |
|---|---|---|
| `promptEvidence(analysis, source)` | `{ field: renderings }` | the model |
| `recordedEvidence(analysis, source)` | `{ field: { source, renderings } }` | the run's stored snapshot |

The stored form carries the source string the renderings are about. The prompt
does not need it - the row's own snapshot already shows the source next to the
current rendering - but a stored row is read back long after the corpus has
moved, and evidence that does not say what it is evidence about is a list of
strings.

**A row with nothing to report gets `{}`, and that is load bearing.** `{}` is
what makes the evidence block vanish from the prompt entirely rather than appear
empty, which is the producing end of the guarantee [the prompt
section](#the-prompt) states.

### Ordering is by codepoint, deliberately

`analysis.text` is the exact bytes written to the run directory, and
`analysis.hash` is over those bytes, newline included. Entries within a field are
ordered **by codepoint**, not by `localeCompare`.

This is not a style preference. `localeCompare` with no locale argument reads the
runtime's default locale, so one corpus analysed on two machines can serialize in
two orders and hash to two different run ids - a derived identity turned into an
accident of where it was computed. A collator pinned to one locale fixes the
machine but not the decade, because collation data moves with ICU. Codepoint
order is the only comparison that is the same everywhere and stays the same, and
nothing reads this file for its ordering: it is an input to a hash, and what a
human reads is built from the per-row views above.

## Host inputs and the run id

A review run id is derived from every input, which is what makes init idempotent
and makes "the guidance changed" impossible to confuse with "this is a different
corpus". A host with an input of its own - the digest of a termbase, the revision
of a style guide, the version of some upstream analysis - has to be able to reach
that derivation, or its runs collide: two materially different reviews resolving
to one id, the second recognised as the first and never executed.

```ts
const job: ReviewJob = { ...base, extraInputs: { termbase: sha(termbaseText) } };
extraInputsDigest(job);   // sha256 over the bag, in sorted key order
```

Values are opaque strings, hashed and never interpreted. Put a digest here, not a
document.

**An empty or absent bag digests to the empty string**, and that is a contract
term rather than an implementation detail: the derivation appends the digest to
its input rather than joining it in with the rest, so a job that sets nothing
produces exactly the run id it would have produced before `extraInputs` existed.
`promptSalt` earns the same guarantee the same way, and for the same reason - a
mechanism a host can decline to use must cost nothing to the hosts declining it.

A non-string value is **refused** rather than serialized. `JSON.stringify` drops
an `undefined` value silently, which would make `{ termbase: undefined }` digest
identically to `{}` - the one collision this whole mechanism exists to prevent.
For the same reason `{ termbase: '' }` is not the same as no key at all: a host
that declares an input and has nothing in it this time has still declared it.

## The graded vocabularies

**Severity and confidence are closed lists, and the reason is measured.**

A run over 2,125 German rows left `severity` unconstrained. The model answered
with **four words for three levels**: `minor` 413, `major` 25, `medium` 7,
`moderate` 2. Anything sorting or filtering by severity therefore saw one level
split across two names - silently, and in the direction that hides defects,
because the smaller spelling is the one nobody writes a filter for.

The middle rung is the one that collided, and each scale keeps the word that
belongs to it:

| Scale | Levels |
|---|---|
| `DEFAULT_SEVERITY_LEVELS` | `minor`, `moderate`, `major` |
| `DEFAULT_CONFIDENCE_LEVELS` | `low`, `medium`, `high` |

**`moderate` grades a defect; `medium` grades a belief.** Both lists are
overridable per job. What is not optional is that they are lists: a graded field
a model may fill freely is a graded field with no grades in it.

They reach the model twice - as an enum in the schema, and as a refusal in
`validateReview` - because a provider that does not enforce the schema is a
provider, not a bug.

## The schema

`buildReviewSchema(job)` generates the output contract from the same field list
the prompt is built from, so the two cannot drift.

- `verdict` is closed to `pass | change_proposed`: it is what everything
  downstream branches on.
- `severity` and `confidence` admit `null` as well as their levels. A reviewer
  that found nothing has no severity to report, and requiring one would make
  every `pass` row carry a grade nobody assigned.
- Every proposal is nullable. `null` is how the reviewer says "keep what is
  there", and it is what stops a `pass` row from re-emitting text it is not
  changing.

**The hash is taken over the compact serialization, not over the bytes written
to disk.** `writeReviewSchema` indents the file for a human reading an attempt
directory; the identity a review run is derived from must not move because of an
indent. This differs from `buildResponseSchema`, which hashes its indented text,
and the difference is deliberate rather than an oversight: run ids already
published were derived this way.

## Validation

`validateReview(job, identifier, value)` checks the answer and returns it
normalized. **Every rejection is structural** and raises `TransientFailure`,
which costs the row another attempt.

That is the whole difference from `validateResponse`, which has a second
category: a translation can be well-formed and still worth a human's attention,
so it can be downgraded to review. A review *is* that attention. There is
nothing to downgrade one to, so either the reviewer answered the contract or it
did not.

One deliberate leniency: a **missing** proposal key is `null` rather than an
error. Absent and `null` both mean "keep what is there", and the schema already
requires the key, so a model that omits it has said the same thing twice.

### Normalization happens here

A proposal goes through the translation job's `normalize` hook, at the one line
where it is accepted - the same rule, and the same reason, as
[the translate side](contract.md).

It is not a nicety. A proposal becomes a corpus value the moment a human takes
it, so a clean corpus reviewed by a model that writes a straight apostrophe
comes back inconsistent. Normalizing in `validateResponse` alone does not cover
that path. It runs on a `pass` verdict too, because a verdict and a proposal are
separate claims and both are stored.

The per-attempt `response.json` still holds the raw reviewer output, so the
audit trail is unaffected by any of this.
