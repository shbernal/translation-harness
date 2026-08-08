# Review

A review pass judges an existing rendering instead of producing one. It is the
second lifecycle over the same runner, the same store contract and the same
provider layer, and it exists because the interesting question about a
translated corpus is rarely "did every row come back" - it is "which rows are
wrong, and what should they say instead".

This page owns the **review contract** - what a review job is, what the reviewer
is asked, and what a well-formed answer looks like - **opening a run**: the
snapshot, the derived run id, and chaining - and **running one**. The durable
half, meaning the tables, the version stamp and the migration, is in
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

## Opening a run

```ts
const result = await initializeReview(store.review, {
  job: reviewJob,
  corpus: rows,                 // every row, as `ReviewSourceRow`
  profile: 'sonnet-5',
  provider: 'claude',
  model: 'claude-sonnet-5',
});
result.runId;    // 32 hex characters, derived
result.created;  // false on the second call with the same inputs
```

The first argument is not a store, it is **the function that opens one**.
`sqliteStore(path).review` is exactly that function. Init cannot be handed a
store because the run id the store would be scoped to is the thing init
computes, and the same provider is how init reaches a *base* run when chaining.

**No store opened by init is closed by init.** The shipped provider hands back
stores over one shared connection, so closing the base run's store would close
the caller's registry underneath them.

The corpus arrives as data, the same choice `TranslationStore.initialize` makes
with `SourceRecord`. `Item` from the translate store satisfies `ReviewSourceRow`
structurally, so a host reading its own registry hands the rows straight over.

### The run id is derived, not generated

```
sha(profile | promptHash | schemaHash | terminologyHash |
    analysisInputHash | analysisOutputHash | snapshotHash |
    mono|bi | baseRunId) + extraInputsDigest
```

truncated to 32 hex characters. Two properties come out of that, and everything
else on this page is in service of them:

- **Init is idempotent.** The second call on unchanged inputs finds the run and
  reports `created: false`. Nothing is rebuilt and nothing is re-reviewed.
- **A changed input is a different run, never a polluted one.** There is no
  state in which a run's answers were produced under rules the run does not
  record.

Three things are deliberately *not* inputs, and each is checkable:

| Not an input | Why |
|---|---|
| the order the caller iterated the corpus | rows are sorted by row number before anything is hashed |
| the provider and the model | a binding can legitimately arrive later (`bindProvider`); an input that can arrive after the id was computed cannot be one of its inputs |
| `allowPartial` | a row with no answer already snapshots differently from the same row once it has one |

The **profile** is an input, because it is chosen when the run is opened and it
names the configuration the run means.

`deriveReviewRun` is init with the writing taken out: pure, no store, no clock,
no filesystem. Use it to answer "what id would these inputs produce" before
opening anything.

### The accepted-corpus rule

`initializeReview` refuses unless every supplied row is `succeeded`. Reviewing a
half-translated corpus produces proposals about text nobody has accepted, and
there is no later moment at which that becomes visible, so the refusal is a
contract term rather than a convenience. `allowPartial` overrides it and is
recorded on the run, which makes a partial run visibly partial forever.

A host cannot get around it by filtering, and not because filtering is
forbidden: **the snapshot hash covers every row init was given**, so a corpus
with rows held back derives a different id. It is a different run, not a run
with a hole in it.

### The snapshot is immutable, and the interface is how that is enforced

`ReviewStore` has no method that rewrites a snapshotted source or target. That
is not an omission: `target_snapshot_hash`, `evidence_hash` and the whole-corpus
`snapshot` hash are all taken over those values, and the run id is taken over
those hashes. Rewriting the text without recomputing the id leaves a run whose
id no longer identifies what was reviewed - and nothing anywhere says so.

The pressure to do it is real and looks reasonable. A corpus normalized after
the fact leaves every review workbook rendering the old forms, so the obvious
fix is to backfill the snapshot too. The library's answer is that a corrected
corpus is a **new run**: re-initialize, get a different id because the rows
differ, and keep the old run as the record of what was actually reviewed. If you
reach for the `DatabaseSync` escape hatch to do it the other way, you are
choosing to make the run id a lie about that run.

### Nothing is written to disk

Init returns the consistency analysis rather than writing it anywhere. A host
that wants the bytes has `analysis.text`, and nothing in the library needs them,
because a run reproduces its own analysis from its own snapshot:
`buildConsistency(job, await store.snapshot())` is the same object, hash
included.

## Chaining: reviewing what the last stage produced

`baseRunId` takes a prior **completed** run's resolved output as this run's
target, so stage 2 reviews stage 1's corrections rather than the live corpus.
The source stays the corpus source; only the target moves.

```ts
const stage2 = await initializeReview(store.review, {
  job: reviewJob,
  corpus: rows,
  baseRunId: stage1.runId,
});
```

`resolveRunOutput(snapshot)` is what "the output of run 1" means, and it ships
because two callers need it and must agree: a chained run snapshots it, and an
exporter renders it. A `change_proposed` row contributes its non-null proposals,
field by field; every other row resolves to its snapshot unchanged. Nothing is
read from the live corpus, which is what lets a run resolve to the same thing in
a year.

Two refusals, both about the same thing:

- **A base that has not completed** has rows nobody answered, so chaining would
  freeze a half-finished opinion into the next stage and never mention it again.
- **A base that does not cover a row** would leave that row reviewing the live
  corpus while its neighbours review stage 1, which is a corpus that never
  existed at any single moment.

## Rows the job answers itself

`settledByConstruction` is `job.precomputed` one level up: a row whose value is
fixed rather than translated has nothing for a reviewer to judge, and asking one
to judge a fixed string once per row is as many chances to word it differently
as there are rows. Such rows are snapshotted like every other row - the run
still covers the whole corpus - and seeded `pass` with no proposal, so they cost
no model call.

Any drift makes it a normal row again. A corpus value that no longer matches the
answer the job would give is exactly the case a reviewer should see.

## Running a pass

```ts
const review = store.review(result.runId);
const summary = await runReview(review, reviewJob, await review.selectCandidates({}), {
  cwd: projectRoot,
  provider: 'claude',
  model: 'claude-sonnet-5',
  timeoutSeconds: 300,
  workDir,
  maxAttempts: 3,
  delaySeconds: 0,
  concurrency: 4,
  onEvent: (event) => log(event),
});
summary; // { pass, change_proposed, failed }
```

`runReview` is a configuration of `runAgentBatch`, exactly as `runTranslation`
is. The pool, the atomic claim, the bounded retry ladder, the quota pause, the
abort path, the per-attempt evidence and the final sweep are the ones already
shipped, so **review inherits them rather than reimplementing them**. What is
review's own is which prompt a row gets, what a valid verdict is, and what
recording one means.

Which rows to attempt is the caller's, as it is for translation:
`selectCandidates({})` is everything still pending, `{ retryFailed: true }`
picks up what a previous pass gave up on, `{ identifiers, limit }` is a pilot.

### A run is a job; a pass is one execution of it

This is the one structural thing to carry away, because every other behaviour
below follows from it.

| | opens it | closes it |
|---|---|---|
| the run (`review_runs`) | `initializeReview` | `runReview`, when nothing is left pending |
| the pass (`review_passes`) | `runReview` | `runAgentBatch` |

A run is created once, with a derived id and a frozen snapshot, and executed as
many times as it takes. So the run the batch layer opens and closes is *not* the
review run: `startRun`, `finishRun` and `tryClaim`'s run id all mean a pass. That
is what keeps `releaseSettledRunClaims` meaningful here - a crashed pass ends,
and the rows it was holding come back without waiting on a clock. Were the claim
recorded against the run, it could never fire, because the run stays open across
exactly the crash that stranded the rows.

The run's status is therefore a statement about its rows, not about a live
process:

- **`completed`** - no row is still pending or running. Note what this does not
  say: a row that exhausted its attempts is `failed`, and a run can complete
  with failed rows in it. A failed row is a recorded answer a human can see and
  retry; a run that one stubborn row could block forever would be a worse
  contract than one that says what happened.
- **`interrupted`** - the pass was aborted and rows remain.
- **`running`** - rows remain and nobody stopped anything: a quota pause, a
  limit, a filtered selection. It means work is left, not that something is
  executing.
- **`failed`** - a pass died of something that was not a bad answer.

Only the first is chainable, which is [chaining's](#chaining-reviewing-what-the-last-stage-produced)
first refusal seen from the other side.

### The binding is fixed by the first pass

A run records one provider, one model and one reasoning effort. Unlike a changed
prompt or a changed corpus, a changed binding **cannot** show up as a different
run id - a binding may legitimately arrive after the id was computed, which is
why it is not one of the id's inputs - so this is the only place it can be
caught, and `runReview` catches it:

- an option left unset **inherits** the binding, so resuming takes `--provider`
  and nothing else;
- an option set to something the run is not bound to is **refused**, rather than
  ignored in favour of the stored value. Silently running the model on record
  while the caller believes they chose another is the failure this exists to
  prevent, wearing a friendlier face.

### Nothing on disk is an input

The schema and the per-attempt evidence go under `<workDir>/review/<runId>/`,
and a pass reads none of it back. The consistency evidence each prompt carries is
rebuilt from the run's own snapshot, which reproduces the analysis the run id was
derived from, hash included. Delete the run directory and the next pass composes
the same prompts.

### Trying it without a model

```ts
registerReviewMockProvider();   // registers as 'review-mock'
```

The offline reviewer runs the whole loop for free and in milliseconds, the way
`registerMockProvider` does for translation. It registers under a name of its
own, because the ordinary case is having both: the corpus a review reads is the
one a translation pass wrote.

What it judges is deliberately mechanical - **stray whitespace, and nothing
else**. A mock that guessed at meaning would produce proposals a reader might
half believe. It grades with whatever vocabularies the schema on disk allows
rather than with the defaults, which is both what a provider honouring the
schema would do and the only way its answers pass `validateReview` for a job
that overrode them.

## The three-way decision

A review run only ever proposes. Somebody then goes through it and decides, per
field, one of exactly three things: **keep** the value that was reviewed, take
the reviewer's **proposal**, or write a **custom** rewrite. That is universal,
and so is turning those choices into the text the corpus should read.

```ts
const { resolved, counts, warnings } = resolveDecisions(
  await review.snapshot(),
  new Map([['AC-1', { name: { kind: 'proposal' }, description: { kind: 'keep' } }]]),
);
resolved; // Map<rowNumber, Fields> - every row of the run
counts;   // { keep: 1, proposal: 1, custom: 0 }
```

What is **not** universal is where the choices come from: a workbook column, a
web form, a diff somebody accepted at a terminal. Nothing here knows about any
of them, which is why `resolveDecisions` takes a plain map and not a file.

`keep` is named for what it does rather than for where the value came from. It
keeps the value under review, which is the accepted corpus target for an
ordinary run and the base run's resolved output for a chained one; those are the
same thing only when the run does not chain.

**Decisions come in keyed by identifier and resolve out keyed by row number.**
That asymmetry is deliberate. A decision comes from outside the run, where the
identifier is the only key that survives the round trip - a spreadsheet carries
an identifier column, somebody sorts and filters it, and nobody is looking at a
row number. The value that comes back is in the run's own terms, so it is keyed
the way the run keys itself, exactly as `resolveRunOutput` is.

Every row of the run is resolved, decided or not, because a review run is a
fixed object covering a whole corpus. A caller who wants only the rows somebody
touched has the decision map to filter by.

### What it needs of a row

Four fields - `rowNumber`, `identifier`, `target`, `proposals` - declared as
`ReviewDecisionRow`, which a `ReviewItem` satisfies. So the snippet above is the
ordinary way in and nothing extra is asked of it.

The reason it is not simply `ReviewItem` is the other caller. A hand-validated
workbook carries the value under review and the proposal in its own columns, and
those columns, not the run as it stands today, are what the person was reading
when they chose. Resolving from the workbook is therefore the honest thing to
do, and a host doing it has no snapshot hashes to hand over and should not be
invited to invent them.

### Nothing is retyped

The proposals in the snapshot were normalized when `validateReview` accepted
them, so they arrive already in the target language's typography. A rewrite a
person typed is written exactly as typed: a library that silently retypes
somebody's quotation marks is editing a decision it was asked to record. That is
also why this needs no `ReviewJob`.

### The degenerate cases warn rather than refuse

Each one is a cell somebody filled in wrong, and the other ten thousand cells
are still worth publishing. All of them fall back to the value under review,
which is the choice that changes nothing:

| what happened | what it does |
|---|---|
| `proposal` chosen, the reviewer proposed nothing there | keeps, warns |
| `custom` chosen, no rewrite supplied | keeps, warns |
| a decision this library does not recognize | keeps, warns |
| a field name the run does not have | ignores, warns **once** rather than once per row |
| an identifier the run does not have | ignores, warns |

An **empty** rewrite counts as no rewrite. Reading it as "blank this field"
would let a slip delete text with no trace; blanking a field is worth typing a
space for.

`counts` tallies what was *chosen*, so a choice that could not be honoured still
counts under it. The tally answers "what did the human do"; the warnings say
what came of it.

The one thing it refuses is a snapshot with two rows under one identifier, since
a decision names a row by identifier and there would be no answer to which of
them it meant. `deriveReviewRun` already rejects such a corpus, so this only
fires on a snapshot somebody assembled by hand.

### Its sibling, and where they disagree

`resolveRunOutput` answers the same question - what does this run say the corpus
should read - by asking the *run* rather than a person, which is what
[chaining](#chaining-reviewing-what-the-last-stage-produced) needs, because
there is no human in that loop.

They differ in one visible place. A `pass` row can carry a proposal: the store
keeps a verdict and a proposal as separate claims, and `validateReview`
normalizes a proposal even on a `pass`. `resolveRunOutput` ignores it, having
nobody to ask. `resolveDecisions` honours it if somebody asks for it, because a
person reading the verdict and the proposal side by side may well prefer the
proposal.

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
