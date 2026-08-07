// The public surface.
//
// Anything exported here is a support obligation, so the bias is toward
// omitting and adding later. Two things are exported that a smaller surface
// would have kept private, and both have a reason:
//
// - `storeConformance`, because `TranslationStore` is an interface, and an
//   interface without a conformance suite cannot be implemented correctly by
//   anyone outside this repository.
// - `registerMockProvider`, because being able to run the whole loop offline
//   and free is the difference between a library you can try and one you can
//   only read about.
//
// The provider layer is deliberately **not** re-exported from here. It lives at
// `translation-harness/providers`, and a subpath export whose contents also
// appear at the root is a subpath export that means nothing.

// The offline provider. Opt in by name; it is never registered for you.
export { invokeMock, MOCK_PROVIDER_NAME, registerMockProvider } from './contract/mock.ts';
// The model contract: the prompt, the schema, and the two hashes that give a
// row and a run their identity.
export {
  buildPrompt,
  hashInput,
  jobPromptHash,
  promptExtrasFor,
  promptHash,
  SOURCE_ROW_MARKER,
} from './contract/prompt.ts';
export {
  buildResponseSchema,
  type ResponseSchema,
  writeResponseSchema,
} from './contract/schema.ts';
// The quality gate, and the two helpers a caller's own validators can build on.
export {
  genericReviewReasons,
  type ModalLevel,
  missingReferences,
  modalForceShiftsFor,
  type ValidatedResponse,
  validateResponse,
} from './contract/validate.ts';
// Failures. `TransientFailure` is what a custom provider raises; the categories
// are what the runner decides on.
export { type FailureCategory, isQuotaError, QuotaExceeded, TransientFailure } from './errors.ts';
// What a job is: the types a caller fills in.
export {
  DEFAULT_THRESHOLDS,
  type FieldSpec,
  type Fields,
  type FieldValue,
  type GuardrailThresholds,
  type SourceRecord,
  type TranslationJob,
  thresholdsFor,
  translatableFields,
  type ValidationContext,
  type Validator,
} from './job.ts';
// The runner.
export { type RunEvent, type RunOptions, type RunSummary, runTranslation } from './pipeline/run.ts';
// Model profiles. Re-exported from the root although they live in the provider
// layer, because binding a run to an exact model is a decision the caller makes
// about the run, not about the subprocess.
export {
  DEFAULT_PROFILES,
  type ModelProfile,
  resolveProfile,
} from './provider/profiles.ts';
export type { ProviderName, ProviderOptions } from './provider/types.ts';
// The registry: the interface, the one implementation, and the suite that makes
// the interface implementable.
export {
  type ConformanceCase,
  type StoreFactory,
  sampleRecords,
  storeConformance,
} from './store/conformance.ts';
export {
  applySchema,
  PRECOMPUTED_MODEL_LABEL,
  SCHEMA_VERSION,
  type SqliteStore,
  type SqliteStoreOptions,
  sqliteStore,
  utcnow,
} from './store/sqlite.ts';
export type {
  AttemptPaths,
  AttemptStart,
  CandidateFilter,
  CommitArgs,
  FailArgs,
  Item,
  Outcome,
  PrecomputedCommitArgs,
  RunRecord,
  RunStatus,
  StartedAttempt,
  Status,
  StoreRecord,
  SyncResult,
  TranslationStore,
} from './store/types.ts';
export { STATUSES } from './store/types.ts';
