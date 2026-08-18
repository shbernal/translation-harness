# Changelog

Notable changes, newest first. This project uses [semantic versioning](https://semver.org/).

## Unreleased

> **Two things need action before upgrading.** Every existing review run id
> moves, so finish any open review run first; and both halves of the schema go
> to version 2, so an existing registry must be migrated with
> `migrateRegistry(path, { plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] })`
> before it will open. Both are under Changed. This makes the next release a
> **minor** (0.3.0), not a patch.

### Changed

- **A released row returns to the status it held before it was claimed**, which
  is new contract term 10 and a schema change in both halves. `tryClaim`
  overwrote `status` with `running` and recorded nothing about what it displaced,
  so `unclaim`, `reclaimStale` and `releaseSettledRunClaims` all restored to
  `pending`. A redo pass selects rows that already hold an answer, so a hard kill
  mid-redo turned rows holding accepted translations into pending ones: the next
  ordinary run re-translated them and re-spent the money. `target_json` survived
  throughout, so nothing was lost and nothing anywhere said otherwise. The review
  half did the same to `pass` and `change_proposed` rows, and additionally left
  the run unable to report itself finished, since `counts.pending` was no longer
  zero.

  `items.claimed_from` and `review_items.claimed_from` record the displaced
  status, written by the same single statement that takes the claim, and every
  release path restores `COALESCE(claimed_from, 'pending')`. A column rather than
  an inference on purpose: `review_reasons_json` plus `target_json` plus
  `last_error` *almost* distinguish the five statuses, and a row seeded as
  already-succeeded is a fourth shape that breaks the "almost".

  **Migration required.** `SCHEMA_VERSION` and `REVIEW_SCHEMA_VERSION` both go 1
  to 2, stamped and migrated separately as always, so a registry opens only after
  `migrateRegistry(path)` - add `{ plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] }`
  if the file has a review half. Both steps are additive
  (`ALTER TABLE ... ADD COLUMN claimed_from TEXT`) and neither can refuse: there
  is no existing data a new nullable column can contradict. A row already sitting
  `running` when the migration runs has no recorded prior status and keeps the
  old behaviour, being released to `pending`.

  **For anyone implementing `BatchStore`:** term 10 is checked by
  `batchConformance`, and `BatchStoreHarness` gains two members to make it
  checkable - `settle(rowNumber)` and `stateOf(rowNumber)`. A claim can only be
  shown to remember what it displaced if the suite can put a row into a state
  other than the one every row starts in, and settling a row is lifecycle work
  exactly as creating one is. An existing harness needs those two functions
  added.

- **A review run id is derived from a row's fields in sorted key order.**
  `snapshotMaterial`, `sourceHash` and `targetHash` hashed
  `JSON.stringify(row.source)` directly. A JavaScript object writes its keys
  back in insertion order, so a host that assembled its `source` objects in a
  different sequence derived a *different run id for the same corpus*: `init`
  found nothing to resume, created a second run, and re-reviewed the whole
  corpus at full cost. `hashInput` on the translation side has sorted its keys
  since it was written and says in its own comment that this is what the sorting
  is for, so the two halves of the library disagreed about the same question.

  Both now go through `canonicalFields` in `src/job.ts`, which sorts keys and
  treats absent and null alike. **`hashInput` produces byte-identical output to
  before** - checked against the previous implementation, including a `source`
  carrying its own `identifier` key - so no translation row's `input_hash` moves
  and no translate resume is affected.

  **What to do before upgrading.** Finish any open review run. A host that
  upgrades mid-review will find `init` deriving an id that does not exist in its
  registry, which creates a second run over the same corpus and starts the
  review again. There is no version of this that keeps the old ids and fixes the
  bug: the id *is* the hash. If old runs must stay reachable, record their ids
  first - they remain readable by id, and only newly derived ids move.

  The example review CLI derives `3203ac4fa18f122f86702a85b9d0327a` from a reset
  registry where it derived `f134a8e1b7443d54585c76419bc450dd`, with the
  snapshot hash moving from `89047e2583648d5c` to `f054bd9a20af1642`. The
  `analysisOutput` hash does not move: `recordedEvidence` keys its object from
  the job's declared field list rather than from the host's object, so it never
  had the defect.

### Fixed

- **`reclaimStale` no longer interrupts a run that is still working.** Both
  halves closed dangling attempts for every run matching `status != 'running'
  **OR** `started_at <= cutoff`, and then interrupted any run started before the
  cutoff. So a batch that legitimately ran longer than `ageMinutes` had its
  in-flight attempts stamped `abandoned` and the run itself declared
  `interrupted` while it was working. It self-healed as each attempt committed
  over the stamp, which is why it went unnoticed.

  A run is now interrupted only when it started before the cutoff *and* holds no
  row touched since it - its rows are the evidence, not its age - and the
  attempts statement keys off run status alone. `review_passes` /
  `review_items` get the identical treatment. The rows statement is unchanged:
  `updated_at <= cutoff` was always the real evidence, and this is the same
  reading applied to the run.

  Nothing about the released set changes for a run that really is dead, and
  `reclaimStale(0)` still means "release everything now".

- **`modalForceShiftsFor` counts every match, not the first.** It counted with
  `s.match(re)?.length`, which on a regex *without* `g` returns a match object
  whose `length` is one plus the number of capture groups rather than a count of
  matches. A job passing `/shall/i` got 1 wherever the word occurred at all, and
  a pattern with two groups got 3 for a single hit. Either way the shift report
  was fabricated and nothing raised an error. Both `source` and `target` of each
  level are now normalized to global before counting.

  Its sibling `missingReferences` uses `matchAll`, which throws loudly on the
  same mistake, so one helper was strict and the other silently wrong.
  Normalizing rather than throwing is deliberate: a validator throws inside
  `validateResponse`, and a non-`TransientFailure` throw there ends the run,
  which is far too much to charge for a missing flag.

  **This changes what gets flagged.** A job currently passing non-global
  regexes will start seeing real counts, so rows that were quietly reported as
  matching may newly raise a `modal force differs` review reason.

- **A precomputed answer the contract refuses now fails its row instead of the
  batch.** `job.precomputed` is documented as being held to the identical
  contract a model answer faces, and it was, on the way in: the answer goes
  through `validateResponse` like any other. What did not match was the
  consequence. `validateResponse` throwing inside `settleWithoutProvider` was
  not caught inline, so it reached the fatal path and ended the run, while the
  same refusal of a model answer costs one row. Over a two-row corpus with a
  `precomputed` answering `{}` for a non-blank field, the run threw and row 2 was
  never attempted.

  The row is now failed once, with `attemptNumber` 0 and no `attempts` entry,
  and the batch continues. There is no retry ladder: `precomputed` is a function
  of the source, so attempt two would be refused identically and the wait would
  buy nothing. The `row-settled` event carries `outcome: 'failed'` with
  `precomputed: true`. Anything other than a `TransientFailure` thrown from
  `precomputed` is still fatal, being a bug rather than a refused answer.

  **This changes what a consumer sees.** A run that used to die now completes
  with one failed row, so a host that treated the throw as its signal that a
  precomputed rule was wrong gets a `failed` row and a `row-settled` event
  instead.

- **An empty proposal no longer blanks the field it was proposed for.**
  ([#1](https://github.com/shbernal/translation-harness/issues/1)) Choosing
  `proposal` on a field where the reviewer emitted `""` wrote the empty string
  over the target and warned about nothing. The `custom` branch twenty lines
  below already refused exactly that, with a rationale that applies word for
  word to both, so the two halves of one `switch` disagreed about one value.
  Both now read empty as nothing proposed, keep the value under review, and say
  so in `warnings`.

  `resolveRunOutput` had the same hole and is fixed with it. That is the half
  that matters more: a chained run has no human in the loop and no warnings
  channel, so an emptied field became the next stage's snapshot with nothing
  anywhere recording it.

  Reported against reasoning rather than against an incident - a completed
  79-row run in the reporter's project held 145 `null` proposals, 3 real ones
  and no empty strings, so reviewers do emit `null` as documented. What makes it
  worth fixing is that the failure would be quiet and pre-selected: an exporter
  defaulting a field's dropdown to `proposal` wherever the proposal is non-null
  offers the deletion already chosen, and `""` is non-null.

### Changed

- **A row with nothing to translate now says so.** A row whose translatable
  fields are all blank still goes to `review_required` - that is deliberate, and
  it is the inherited behaviour - but its reason is `no translatable content`
  rather than `suspicious combined length ratio: 0.00`. The ratio was arithmetic
  about an empty string, and it read as a warning about a translation that does
  not exist.

  Which rows are flagged is unchanged, so a resumed run reports different text
  for these rows and not a different set of rows. A host that matches on the
  reason string will need the new one; nothing in the library selects on it, and
  it is provenance rather than state.

### Removed

- **`QuotaExceeded`.** Exported from `index.ts` and never raised by anything in
  `src/`. Its own doc comment said "raised by the pipeline, not by a provider",
  and the pipeline does not raise it: quota handling is entirely
  `TransientFailure('quota')`, a paused batch, and `BatchFailure.quota`. It was
  a support obligation with no producer.

  **Use instead:** a caller that wants to know a batch stopped on quota reads
  `BatchFailure.quota` on the failed row, or listens for the `quota-paused`
  event; a run that stopped this way finishes with status `paused_quota`. A
  caller that wants to classify a provider's own message still has
  `isQuotaError`, which is unchanged.

  The alternative was to keep the class and correct its comment. That is worse:
  it publishes a name a consumer may reasonably start throwing, and then the
  library owes it a meaning it was never given.

## 0.2.1

A framework a termbase plugs into, and a way to read the corpus back.

### Added

- **A termbase framework, and no termbase.** `TermEntry`, `TermMatcher`,
  `selectTerms`, `glossaryBlock` and `termsDigest` in a new `src/glossary.ts`,
  plus `glossaryHook`, which binds an entry list to a translation job by
  returning its `promptExtras` and `promptSalt`. A review job takes the same
  list through its own two fields: `terminology` is `glossaryBlock(entries)` and
  the host input is `termsDigest(entries)`. There is no adapter for that pair,
  because a reviewer is shown the standard whole rather than per row, which
  leaves nothing to derive and two assignments to make.

  There are no term lists here, no folding tables, no determiners and no
  inflection rules. Which words are canonical is a judgement about one language
  pair and one domain; what is published is the mechanism a host's own pack plugs
  into. That is why the matching seam is a predicate, `(text, term) => boolean`,
  rather than a language profile: a regex profile satisfies it and so do a
  stemmer, a lemmatizer and plain substring search, and because the library never
  composes a pattern it never needs to know what a determiner is. The default
  matcher is case-insensitive substring search and is documented as naive.

  `glossaryHook` exists because a pack reaches a translation run twice, as text
  through `promptExtras` and as identity through `promptSalt`, and a host
  filling those from two places can inject one pack while recording another.
  Nothing reports that; what it buys is a resume reusing answers produced under
  rules nobody can still name. Derived from one entry list, the mismatch has
  nowhere to come from.

  `termsDigest` covers both fields of an entry rather than the rendered text
  alone. Adding a form to `match` changes the per-row block on every row that
  form occurs in and changes nothing anyone is shown, so a digest over the
  rendering would call two materially different runs one run.

  **An empty pack reproduces the job that never had one**, byte for byte and
  hash for hash: `promptExtras` answers `''` and `promptSalt` is whatever salt
  was handed in, so `jobPromptHash` does not move. `glossaryBlock([])` is `''`,
  which emits no `TERMINOLOGY` block and hashes as an absent field does. The one
  half a review host has to get right itself is the input key: `termsDigest([])`
  is also `''`, and `{ termbase: '' }` is deliberately not the same as no key,
  so an empty pack has to omit the key rather than write it empty. Adding a
  termbase to a corpus already half translated is safe; rendering one through
  `glossaryBlock` where the host was formatting its own will move review run ids
  if the text differs by a byte.

- **A `glossary` layer**, at the bottom of the stack with no imports at all.
  A pack is not translation knowledge and `review` may not import `contract`, so
  putting the core under `contract` would put it out of reach of the lifecycle
  that binds it by hand. The empty allow-list is also the mechanical half of the
  claim above: a module that holds no language tables has nothing to import.

- **`TranslationStore.items()`**: every row of the corpus, in row-number order,
  whatever its status. `Item` satisfies `ReviewSourceRow` structurally, so opening
  a review run over a registry-backed corpus is now
  `initializeReview(store.review, { corpus: await store.items(), ... })` rather
  than a hand-written query.

  It exists because `initializeReview` takes its corpus as **data** rather than
  reading a store - which is what makes a filtered corpus a different run id
  instead of a run with a hole in it - and that left every host whose corpus does
  live in the registry writing the same fifteen lines of SQL. Two hosts out of two
  had. Neither existing reader would do: `translationsByIdentifier` drops the
  status and the input hash, and `selectCandidates({ redo: true })` excludes
  `running` rows, so a corpus read that way changes shape depending on what
  happens to be executing.

  It returns an array rather than streaming, deliberately: a review run id is a
  hash over every row in row order, so the caller it exists for materializes the
  corpus regardless and an iterator would move that rather than remove it.

- **Store contract term 9**, checked by two new `storeConformance` cases: `items`
  excludes nothing, `running` included, returns rows in row-number order, and
  reports a row with no answer as a `target` of `null` and never `{}`. The last is
  the one that matters - an unanswered row and a row answered with an empty object
  hash differently, so a store that normalizes one to the other silently moves
  every review run id derived from the corpus it returns.

  The number is 9 rather than 7 because terms 7 and 8 are `ReviewStore`'s and the
  contract is numbered in **one sequence across all three store interfaces**, so
  "term 2" means the same thing wherever it appears. Terms are never renumbered
  and never reused; a new one takes the next free number rather than the next
  number on its own interface.

### Changed

- **A custom `TranslationStore` needs `items()`.** One method, and the SQLite
  implementation is `SELECT * FROM items ORDER BY row_number` mapped through the
  same row mapper everything else uses. Nothing else changed shape, and no run id
  moved: the example CLI's derived run id and snapshot hash are byte-identical
  before and after, from an empty registry and from a populated one.

## 0.2.0

A second lifecycle, and the runner that now carries both of them.

**Review** judges an existing rendering instead of producing one. A run is
opened over a snapshot of an accepted corpus, executed as many passes as it
takes, and read back as proposals somebody decides on field by field. It
proposes and never mutates, and its run id is *derived* from every input it was
given rather than generated, so opening a run twice is the same run and a
changed input is provably a different one. See
[docs/review.md](docs/review.md).

**`translation-harness/batch`** is what makes that a second configuration rather
than a second implementation. The pool, the atomic claim, the bounded retry
ladder, the quota pause and the abort path came out of `runTranslation`
unmodified - the v0.1 acceptance gate, a byte comparison of the prompt hash and
eight item columns over two corpora, was re-run against the extracted version -
and review inherits them instead of reimplementing them.

Nothing published in 0.1.0 changed shape.

### Added

- The review contract: `ReviewJob`, `buildReviewPrompt`, `buildReviewSchema`,
  `writeReviewSchema` and `validateReview`, in a new `review` layer. A review job
  **carries** the `TranslationJob` it judges rather than restating it, so its
  fields, its language pair and its `normalize` hook cannot drift from the pass
  that produced the corpus. `showSource: false` is the monolingual pass, which is
  a different job rather than a flag on one. Both optional prompt blocks -
  terminology and consistency evidence - vanish cleanly, so a job that has
  neither composes the prompt it would have composed without them. See
  [docs/review.md](docs/review.md).
- `DEFAULT_SEVERITY_LEVELS` and `DEFAULT_CONFIDENCE_LEVELS`, overridable per job.
  **The graded fields are closed lists and the reason is measured**: left
  unconstrained over 2,125 rows, one model answered with four words for three
  levels (`minor` 413, `major` 25, `medium` 7, `moderate` 2), so anything sorting
  by severity saw one level split across two names. `moderate` grades a defect,
  `medium` grades a belief, and each scale keeps the one that belongs to it. The
  lists reach the model as schema enums and are re-checked in `validateReview`,
  because a provider that does not enforce the schema is a provider and not a
  bug. See [docs/review.md](docs/review.md#the-graded-vocabularies).
- `buildConsistency`, `promptEvidence` and `recordedEvidence`: every source
  string the corpus renders more than one way, per field, attached to the rows it
  affects. The library derives this rather than taking it from the host because
  **its output hash is one of a review run's identity inputs** - two hosts
  analysing one corpus their own two ways would disagree about what run they are
  looking at. Entries are ordered **by codepoint, not by `localeCompare`**, so the
  analysis is a property of the corpus and not of the machine's default locale;
  every corpus available to check orders identically either way, so nothing moved
  to buy that. A row with nothing to report gets `{}`, which is what makes the
  prompt's evidence block vanish rather than appear empty. See
  [docs/review.md](docs/review.md#consistency-evidence).
- `ReviewJob.extraInputs` and `extraInputsDigest`: a host folds its own inputs - a
  termbase digest, a style-guide revision - into a derived run id without the
  library knowing what any of them are. Hashed in sorted key order; **an empty or
  absent bag digests to the empty string**, so a host that sets nothing gets the
  run ids it got before the field existed. A non-string value is refused rather
  than serialized, because `JSON.stringify` drops `undefined` silently and two
  different sets of inputs agreeing on one id is the exact collision the mechanism
  prevents. Same shape, and the same reason, as `promptSalt` on the translate
  side. See [docs/review.md](docs/review.md#host-inputs-and-the-run-id).
- `initializeReview`, `deriveReviewRun`, `resolveRunOutput` and
  `settledByConstruction`: opening a review run. **The run id is derived from
  every input rather than generated** - the profile, the guidance, the response
  schema, the terminology, the consistency analysis, every row of the corpus,
  whether the source is shown, and any base run - so init is idempotent and a
  changed input is provably a different run instead of a polluted one. It takes
  a `ReviewStoreProvider` and not a store, because the id the store would be
  scoped to is the thing init computes, and because the same provider is how it
  reaches a base run when chaining; it closes nothing it opens. The corpus
  arrives as data, and a host cannot filter its way around the accepted-corpus
  rule, because the snapshot hash covers every row it was given. Chaining ships
  with it (`baseRunId`), refusing a base that has not completed or does not
  cover every row. Nothing is written to disk: a run reproduces its own
  consistency analysis from its own snapshot. See
  [docs/review.md](docs/review.md#opening-a-run).
- `runReview`: executing a review run, as a configuration of `runAgentBatch`.
  The pool, the atomic claim, the retry ladder, the quota pause, the abort path
  and the per-attempt evidence are the ones already shipped, so **review
  inherits the resumability guarantees rather than reimplementing them** - the
  in-repo implementation this replaces had no claim at all, so two processes
  over one run would both take every pending row. **A run is a job and a pass is
  one execution of it**: init opens the run, `runReview` opens a pass,
  `runAgentBatch` closes the pass, and the run's status is a statement about its
  rows rather than about a live process. The provider binding is fixed by the
  first pass: an unset option inherits it, and one that contradicts it is
  refused rather than ignored, because a changed binding is the one input that
  cannot show up as a different run id. Nothing on disk is read back - each
  prompt's consistency evidence is rebuilt from the run's own snapshot. See
  [docs/review.md](docs/review.md#running-a-pass).
- `resolveDecisions`: the three-way decision - keep the value under review, take
  the reviewer's proposal, write a custom rewrite - resolved into the text the
  corpus should read. Universal; *where* the choices come from (a workbook
  column, a form, a diff accepted at a terminal) is not, so it takes a plain map
  and knows about none of them. Decisions come in keyed by identifier, because
  that is the only key that survives a round trip through something a human
  sorted, and resolve out keyed by row number, because that is how a run keys
  itself. Nothing is retyped: a proposal was normalized when `validateReview`
  accepted it, and a rewrite somebody typed is written as typed. The degenerate
  cases warn rather than refuse and all fall back to the value under review; a
  field name the run does not have is reported once rather than once per row.
  It asks a row for the four fields it reads (`ReviewDecisionRow`, which a
  `ReviewItem` satisfies) rather than for a whole snapshot row, because the
  caller resolving a hand-validated workbook is reading the value under review
  and the proposal out of its columns - what the person was actually looking at
  - and has no snapshot hashes to hand over.
  See [docs/review.md](docs/review.md#the-three-way-decision).
- `ReviewStore`, and `sqliteStore(path).review(runId)`: the durable half of a
  linguistic review run, on the same connection as the corpus it reviews.
  Calling `.review(...)` is how a host opts in - the tables are created there and
  never by opening a registry, so a file belonging to someone who only translates
  has no review half. It is a `BatchStore`, so the pool, the atomic claim and the
  retry ladder are the ones already shipped rather than a second copy of them,
  and `batchConformance` runs against it unchanged. Two contract terms are its
  own: `createRun` is all-or-nothing and refuses to overwrite (7), and nothing in
  this half writes to `items` (8). A store is scoped to one review run, because a
  review row belongs to a run and a row number only means something once the run
  is fixed. See [docs/architecture.md](docs/architecture.md#the-review-half).
- `registerReviewMockProvider` and `invokeReviewMock`: the offline reviewer,
  under `review-mock`. Same argument as `registerMockProvider`, now that there
  is a second loop to run for free - and a different default name, because the
  ordinary case is having both. It judges stray whitespace and nothing else, and
  grades with whatever vocabularies the schema on disk allows rather than with
  the defaults.
- `examples/review/cli.ts`, a small CLI over the review lifecycle: `translate`,
  `init`, `review`, `status`, `decide`, `resolve`, plus `--base` for a chained
  run and `--mono` for the monolingual one. **An example, not an interface** -
  no binary is shipped and none of the flags are API. It exists because the two
  properties worth knowing about a review run are only convincing at a prompt:
  `init` twice reports the same derived id and `created: false`, while `--mono`
  or `--profile` reports a different id over the same corpus; and
  `review --limit 3` leaves the run `running` for the next pass to finish. It
  keeps nothing on disk about which run is current, because a derived id means
  it does not have to.
- `translation-harness/batch`: the runner, extracted from `runTranslation` and now
  domain-free. `runAgentBatch` is the pool, the atomic claim, the bounded retry
  ladder, the quota pause, the abort path, the per-attempt evidence and the final
  sweep; what a row means arrives as four callbacks. `BatchStore` is what it needs
  from a registry, `batchConformance` is the executable form of that contract, and
  `test/layering.test.ts` fails the build if anything under `src/batch/` imports
  `job`, `contract` or `store`. See [docs/batch.md](docs/batch.md).
- `BatchStore`, and `TranslationStore extends BatchStore<Item>`. Five of the six
  store contract terms turn out not to be about translation, so they moved down
  with the runner and are published as `BatchStore`'s own prose; term 6
  (`initialize` refusing a shrinking corpus) stays. The numbering did not shift.
- `MigrationPlan`, `MigrationStep`, `SchemaStamp`, `USER_VERSION_STAMP` and
  `REGISTRY_MIGRATIONS`: a migration ladder is data, and where its version is
  kept is part of it. A file has exactly one `PRAGMA user_version`, so anything
  added later that a host can decline to adopt has to be stamped elsewhere, and
  `migrateRegistry` migrates only the plans it is given - by default just the
  translation registry.
- `migrateRegistry(path)`, `registryNeedsMigration(path)` and
  `pendingMigrations(path)`: an explicit, host-invoked migration path for an
  existing registry. Opening a file stamped with an unrecognised schema version
  still refuses; this is the other half of that refusal, which until now every
  host had to write for itself. It takes a **path, not a store**, because the
  thing that fails is the open. Nothing migrates automatically. Refusals run
  before any copy or write, the write-ahead log is folded in before the backup is
  taken, and each step applies in its own transaction and stamps its own version.
  The one shipped step brings a pre-0.1.0 registry to version 1. See
  [docs/architecture.md](docs/architecture.md#migration).
- `REVIEW_MIGRATIONS`, `REVIEW_SCHEMA_VERSION`, `REVIEW_STAMP`,
  `applyReviewSchema` and `tableStamp(component)`: the review half carries its
  own version, in a `schema_versions` row rather than in `PRAGMA user_version`,
  which a file has only one of. Pass
  `{ plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] }` to migrate both; the
  default is still the registry alone, so a host who never reviews is never
  migrated for review. `tableStamp` is the general form, so a third half is a row
  and not another mechanism.
- `TranslationStore.releaseSettledRunClaims()`: release rows still claimed by a
  run that has already ended, without waiting out `reclaimStale`'s cutoff. A
  cutoff exists to distinguish a dead process from a slow one; a run recorded as
  anything other than `running` has already answered that, because `finishRun`
  is called after every worker has returned. Under repeated kills the previous
  behaviour let the stranded set grow faster than it drained. Rows claimed with
  no `run_id` predate the column and stay with `reclaimStale`.

  This adds a method to the store interface. An existing implementation of
  `TranslationStore` will need it; `storeConformance` has a case for it.

### Changed

- `runTranslation` is now a configuration of `runAgentBatch`. Its exported name,
  signature, summary, events and on-disk evidence are unchanged, and the v0.1
  acceptance gate - a byte comparison of the prompt hash and eight item columns
  over two corpora - was re-run against it.
- `storeConformance` runs the whole of `batchConformance` before its own cases, so
  the generic terms are demonstrated by the store under test rather than asserted.
  The case list is therefore different, and one case was renamed
  (`recordInternalError marks the rows it is given failed, and no others`) because
  releasing the row is now checked generically and only where it lands is the
  translation store's business.
- `RunEvent` is one union across lifecycles, generic in the outcome labels a
  caller's `commit` may return. The type exported at the package root is
  `RunEvent<Outcome>` and is identical to what 0.1.0 published, so a consumer
  switching on `event.outcome` keeps whatever exhaustiveness it had.
- The error raised when the store refuses to open a registry now names
  `migrateRegistry` and `registryNeedsMigration`, since the library ships them.
- `migrateRegistry` runs every step with foreign keys **off** and checks the file
  once at the end with `PRAGMA foreign_key_check`, throwing if a reference is
  broken. A step that has to change a table's declaration rather than add to it
  must rebuild that table, and dropping a table others reference cannot be done
  with the constraints live. This is what `REVIEW_MIGRATIONS`' one step needs, and
  it is the sequence SQLite's own rebuild procedure prescribes.
- `TranslationStore` implementations are unaffected: nothing was removed and
  nothing changed shape. `RunRecord`, `RunStatus`, `AttemptStart`,
  `StartedAttempt` and `AttemptPaths` now live in the batch layer and are
  re-exported from the root, where they have always been.

### Notes for this release

- **A registry belonging to a host that never reviews is never migrated for
  review.** The review tables are created by the first `.review(runId)` call and
  by nothing else, and `migrateRegistry` walks only the plans it is handed,
  which by default is the translation registry alone. Adopting review on an
  existing file is a deliberate act, in that order: migrate the registry, then
  open a review store.
- **A custom `TranslationStore` needs one new method**,
  `releaseSettledRunClaims`. The shipped store has it and `storeConformance` has
  a case for it, which now runs the whole of `batchConformance` first.
- **Examples are not published.** `examples/` is outside the `files` list, so
  `examples/review/cli.ts` is there for someone reading the repository. It is
  not a binary and it will not be one.
- Node >= 24 and the Node 24 typings are still required, for the reasons under
  the first release below.

## 0.1.0

The first release. `0.x` means the API can still move; anything that changes
will be listed here with the reason.

### Added

- `runTranslation`: a resumable batch runner over non-interactive coding-agent
  CLIs. Per-row transactions, a worker pool, atomic claiming across processes,
  quota pausing the batch, bounded exponential backoff, and per-attempt evidence
  retained on disk.
- `TranslationJob`: a job as data. A language pair, field specs, a prompt
  template, validators, and hooks for normalization, per-row prompt extras and
  a prompt-hash salt.
- The generated model contract: `buildPrompt`, `buildResponseSchema`,
  `validateResponse`. The prompt and the schema come from one field list, so
  they cannot drift.
- `TranslationStore`, an asynchronous interface, with `sqliteStore` as the one
  shipped implementation and `storeConformance` exported so anyone else can
  implement it correctly.
- `translation-harness/providers`: the domain-free subprocess layer. Codex and
  Claude invokers, an open provider registry, model profiles, the Windows
  launcher shim, process-tree kill, timeouts and a 32 MiB output cap.
- `registerMockProvider`: run the whole loop offline, free and deterministically.
- Guardrails: structural problems raise and retry, content concerns downgrade a
  row to review with reasons attached. `missingReferences` and
  `modalForceShiftsFor` as helpers for a caller's own validators.

### Notes for the first release

- **Node >= 24 is required to run and to compile.** The shipped store uses
  `node:sqlite`, and its types reach the published declarations.
- **The generic length-ratio bounds (0.45 to 2.25) are measured, not guessed.**
  40 ordered language pairs across English, French, Spanish, Italian and German,
  in two registers, send between 0% and 5.6% of human-translated rows to review,
  and in that corpus the flagged rows are dominated by translations that dropped
  a section their source had. Pairs the fixtures do not contain are unmeasured
  rather than blessed. See
  [docs/guardrails.md](docs/guardrails.md#the-length-ratio-and-what-its-default-actually-means).
- **`ProviderOptions.cwd` must be a directory Codex trusts**, in practice a git
  repository, because this package does not pass `--skip-git-repo-check`. Point
  it at your project root. Anything else fails every row of a pass on row one.
- Rows claimed by a run already recorded `interrupted` still wait out
  `reclaimStale`'s full cutoff. Addressed after this release by
  `releaseSettledRunClaims`, above; see
  [docs/architecture.md](docs/architecture.md#releasing-stale-claims-without-waiting-on-a-clock).
