# Changelog

Notable changes, newest first. This project uses [semantic versioning](https://semver.org/).

## Unreleased

The first release. Nothing is published yet, and the API is not stable until
`0.1.0` is tagged.

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
- The generic length-ratio bounds (0.45 to 2.25) were calibrated on one language
  pair over one corpus of long-form technical prose. Every other pair is
  unmeasured. Override `job.thresholds` rather than living with the noise.
- Rows claimed by a run already recorded `interrupted` still wait out
  `reclaimStale`'s full cutoff. See
  [docs/architecture.md](docs/architecture.md#known-limitation-stale-claims-from-interrupted-runs).
