# Changelog

Notable changes, newest first. This project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- `TranslationStore.releaseSettledRunClaims()`: release rows still claimed by a
  run that has already ended, without waiting out `reclaimStale`'s cutoff. A
  cutoff exists to distinguish a dead process from a slow one; a run recorded as
  anything other than `running` has already answered that, because `finishRun`
  is called after every worker has returned. Under repeated kills the previous
  behaviour let the stranded set grow faster than it drained. Rows claimed with
  no `run_id` predate the column and stay with `reclaimStale`.

  This adds a method to the store interface. An existing implementation of
  `TranslationStore` will need it; `storeConformance` has a case for it.

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
  `reclaimStale`'s full cutoff. See
  [docs/architecture.md](docs/architecture.md#known-limitation-stale-claims-from-interrupted-runs).
