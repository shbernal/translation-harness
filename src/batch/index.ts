// The `translation-harness/batch` surface: a resumable per-row agent batch with
// atomic claiming, bounded retries, a quota pause and an abort path, and nothing
// in it that knows what a translation is.
//
// It is a subpath export for the same reason `providers` is: the layer is
// genuinely domain-free, and `test/layering.test.ts` fails the build on any
// import from here into the translation layers above, which is what turns that
// sentence into a promise. `runTranslation` is one configuration of
// `runAgentBatch` and holds all of the translation knowledge itself.
//
// A few types appear both here and at the package root - `RunRecord`,
// `RunStatus`, `AttemptStart`, `StartedAttempt`, `AttemptPaths`. They were
// published at the root in 0.1.0, before this layer existed, and they belong to
// it now; removing them from the root to tidy the duplication would break the
// consumers that already import them for nothing.

export {
  type BatchStoreFactory,
  type BatchStoreHarness,
  batchConformance,
  type ConformanceCase,
} from './conformance.ts';
export {
  type AgentBatchOptions,
  type AttemptContext,
  type BatchFailure,
  type BatchSummary,
  type RunEvent,
  runAgentBatch,
} from './run.ts';
export type {
  AttemptPaths,
  AttemptStart,
  BatchStore,
  ClaimedRow,
  RunRecord,
  RunStatus,
  StartedAttempt,
} from './types.ts';
