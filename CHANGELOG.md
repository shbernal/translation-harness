# Changelog

Notable changes, newest first. This project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

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
