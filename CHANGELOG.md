# Changelog

Notable changes, newest first. This project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

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
- `REVIEW_MIGRATIONS`, `REVIEW_SCHEMA_VERSION`, `REVIEW_STAMP`,
  `applyReviewSchema` and `tableStamp(component)`: the review half carries its
  own version, in a `schema_versions` row rather than in `PRAGMA user_version`,
  which a file has only one of. Pass
  `{ plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] }` to migrate both; the
  default is still the registry alone, so a host who never reviews is never
  migrated for review. `tableStamp` is the general form, so a third half is a row
  and not another mechanism.
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
- `MigrationPlan`, `MigrationStep`, `SchemaStamp`, `USER_VERSION_STAMP` and
  `REGISTRY_MIGRATIONS`: a migration ladder is data, and where its version is
  kept is part of it. A file has exactly one `PRAGMA user_version`, so anything
  added later that a host can decline to adopt has to be stamped elsewhere, and
  `migrateRegistry` migrates only the plans it is given - by default just the
  translation registry.
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
