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
// The review contract: what a review job is, what the reviewer is asked, and
// what a well-formed answer looks like. The graded vocabularies are closed
// lists, and the reason is measured rather than stylistic - see
// [docs/review.md](docs/review.md#the-graded-vocabularies).
export {
  confidenceLevelsFor,
  DEFAULT_CONFIDENCE_LEVELS,
  DEFAULT_SEVERITY_LEVELS,
  normalizerFor,
  type ReviewJob,
  type ReviewRow,
  reviewedFields,
  severityLevelsFor,
} from './review/job.ts';
export {
  buildReviewPrompt,
  ROW_SNAPSHOT_MARKER,
  type RowEvidence,
} from './review/prompt.ts';
export {
  buildReviewSchema,
  type ReviewResponseSchema,
  writeReviewSchema,
} from './review/schema.ts';
export { type ReviewedResponse, validateReview } from './review/validate.ts';
// The registry: the interface, the one implementation, and the suite that makes
// the interface implementable.
export {
  type ConformanceCase,
  type StoreFactory,
  sampleRecords,
  storeConformance,
} from './store/conformance.ts';
// Migration: explicit, host-invoked, and taking a path because the thing that
// fails is the open.
export {
  type MigrateOptions,
  type MigrationPlan,
  type MigrationResult,
  type MigrationStep,
  type MigrationStepInfo,
  migrateRegistry,
  pendingMigrations,
  REGISTRY_MIGRATIONS,
  registryNeedsMigration,
  type SchemaStamp,
  tableStamp,
  USER_VERSION_STAMP,
} from './store/migrate.ts';
// The review half of the registry: its schema, its own version stamp, and the
// migration plan that carries it. Opt in by calling `sqliteStore(...).review(id)`;
// a host that never does has no review tables and is never migrated for them.
export {
  applyReviewSchema,
  REVIEW_MIGRATIONS,
  REVIEW_SCHEMA_VERSION,
  REVIEW_STAMP,
  type ReviewStoreOptions,
  reviewStore,
} from './store/review.ts';
export type {
  ReviewCandidateFilter,
  ReviewCommitArgs,
  ReviewFailArgs,
  ReviewItem,
  ReviewItemRecord,
  ReviewOutcome,
  ReviewRunRecord,
  ReviewRunStatus,
  ReviewStore,
  ReviewVerdict,
  StoredReviewRun,
} from './store/review-types.ts';
export { REVIEW_OUTCOMES } from './store/review-types.ts';
export {
  applySchema,
  PRECOMPUTED_MODEL_LABEL,
  parseFields,
  SCHEMA_VERSION,
  type SqliteStore,
  type SqliteStoreOptions,
  sqliteStore,
  tx,
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
