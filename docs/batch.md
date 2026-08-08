---
read_when: changing src/batch/**, or driving an agent CLI over rows that are not translations
---

# The batch layer

`translation-harness/batch` is the part of this package that has never heard of
translation. It is the resumable per-row agent batch: an atomic claim, a worker
pool, a bounded retry ladder, a quota pause, an abort path, attempt evidence on
disk, and a final sweep that leaves no row claimed. `runTranslation` is this
function plus four callbacks.

```ts
import { runAgentBatch } from 'translation-harness/batch';
```

Why it is exported at all: the pool is the part of a batch that is genuinely hard
to get right, and the private codebase this package came out of proved the point
by writing it twice - the second copy silently lacked the atomic claim, so two
processes on one run would both take every row. A layer that is worth having once
is worth having exactly once.

## What you supply

```ts
const summary = await runAgentBatch<MyRow, 'accepted' | 'flagged'>({
  store,                       // a BatchStore
  runId,                       // you opened the run; the runner will close it
  rows: [12, 13, 14],          // row numbers, in the order to attempt them
  schemaPath,                  // the JSON Schema every answer must satisfy
  attemptDir,                  // where per-attempt evidence goes
  provider: 'codex',           // ProviderOptions, flattened into the same bag
  timeoutSeconds: 300,
  cwd: process.cwd(),
  maxAttempts: 3,
  delaySeconds: 2,
  concurrency: 4,

  buildPrompt: (row) => `...`,
  commit: async (row, result, attempt) => 'accepted',
  fail: async (row, failure) => { /* record it */ },
  settleWithoutProvider: async (row) => null,   // optional
  onEvent: (event) => { /* progress */ },       // optional
  signal: controller.signal,                    // optional
});
// -> { settled: { accepted: 2, flagged: 1 }, failed: 0 }
```

Four of those deserve their reasons written down.

**The caller opens the run, the runner closes it.** What a run was configured
with is provenance the caller owns, and a lifecycle whose run ids are *derived*
from their inputs rather than generated opens its run long before anything
executes. Why a run stopped, on the other hand, is knowledge only the pool has,
so `finishRun` is the runner's call: `completed`, `interrupted`, `paused_quota`,
or `failed`.

**`rows` is row numbers, not rows.** The runner claims each one and works from
whatever the store hands back, because between selecting a candidate and claiming
it the row may have moved. A richer candidate object would only be a staler copy
of the thing the claim already returns.

**`commit` returns a label and the summary counts labels.** The runner has no
opinion about what outcomes exist. `BatchSummary.settled` is a plain
`Record<string, number>` holding only the labels some row actually settled as, so
a caller that wants zeros for its full label set fills them in itself, as
`runTranslation` does for `succeeded` and `review_required`.

**Throwing `TransientFailure` from `commit` is how an answer is refused.** It
fails the attempt and the row is retried, through the same ladder a provider
timeout goes through, so validation needs no second concept. Anything else thrown
from a callback is treated as a bug: the pool drains, the rows *this run owned*
are recorded failed through `recordInternalError`, and the error is rethrown.

`settleWithoutProvider` is the escape for a row the caller can answer itself. It
commits the row and returns its label, or returns `null` to send the row to the
agent after all. A row it answers skips the inter-row delay, because that delay
paces a provider conversation and there was none. In a translation pass it is
`TranslationJob.precomputed`; the event field it produces is named `precomputed`
for the same reason.

## The store

`BatchStore` is what the pool needs and nothing more: `tryClaim`, `unclaim`,
`reclaimStale`, `releaseSettledRunClaims`, `startRun`, `finishRun`,
`startAttempt`, `setAttemptPaths`, `failAttempt`, `recordInternalError`, `close`.
It is generic in the row type it claims, so `TranslationStore extends
BatchStore<Item>` and the runner hands your own row shape to your own callbacks.

Terms 1 to 5 of the [contract](architecture.md#the-six-contract-terms) are this
interface's, and `batchConformance` checks them:

```ts
for (const { name, run } of batchConformance(async (rowCount) => {
  const store = myStore();
  await seedSomehow(store, rowCount);
  return { store, rows: [...], claimed: async () => countClaimed(store) };
})) test(name, run);
```

The factory hands back a harness rather than a store because **`BatchStore` has
no way to create a row and no way to count a claim**, and that is deliberate:
both are lifecycle knowledge. Widening the base interface so that its own test
suite could set itself up would have made the base interface a lie, so the suite
asks the host for exactly those two capabilities instead. This package's own tests
run the suite against `sqliteStore` and against a store made of `Map`s, which is
the only way to find out whether a conformance suite tests the interface or tests
one implementation.

## What is not here

No `initialize`, no `selectCandidates`, no notion of a corpus, a source, a target
or a language. Deciding which rows to attempt is the caller's, and so is what a
settled row looks like. The layering test (`test/layering.test.ts`) fails the
build if anything under `src/batch/` imports `job`, `contract` or `store`, which
is what makes the paragraph above a promise rather than an intention.

A handful of types appear both here and at the package root: `RunRecord`,
`RunStatus`, `AttemptStart`, `StartedAttempt`, `AttemptPaths`. They were published
at the root in 0.1.0, before this layer existed, and they belong to it now.
Removing them from the root to tidy the duplication would break consumers for
nothing.
