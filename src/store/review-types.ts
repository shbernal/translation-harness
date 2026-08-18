// The review half of the registry, as a seam.
//
// `ReviewStore extends BatchStore<ReviewItem>` for the same reason
// `TranslationStore` does: the pool that claims a row, retries it and records
// its attempts is one piece of code, so the two lifecycles differ only in what a
// settled row means. Terms 1 to 5 and 10 are inherited rather than restated, and
// `batchConformance` proves them against this store too.
//
// One structural difference from the translate half is worth reading before the
// method list, because every signature here follows from it: **a review store is
// scoped to one review run.** `sqliteStore(path).review(runId)` binds the run,
// and every method below is about that run's rows. In the translate half `items`
// outlive runs, so a row number identifies a row; in the review half a row
// belongs to exactly one run, so a row number identifies a row only once the run
// is fixed. Binding it at construction is what lets `rowNumber` stay the corpus
// row number - the number a human reading a workbook or a diff will recognise -
// instead of becoming a surrogate key nobody can look up.
//
// The second difference is that a review run is a *job*, not an invocation. It
// is created once, with a derived id and a snapshot, and then executed as many
// times as it takes. So the run the batch layer opens and closes is not this
// one: it is a **pass**, one per invocation, and `startRun` / `finishRun` /
// `tryClaim`'s `runId` all mean a pass. That is what keeps
// `releaseSettledRunClaims` meaningful here - a crashed pass ends, and its rows
// come back without waiting on a clock, exactly as they do for translate.

import type { BatchStore, ClaimedRow } from '../batch/types.ts';
import type { Fields } from '../job.ts';

export const REVIEW_OUTCOMES = ['pending', 'running', 'pass', 'change_proposed', 'failed'] as const;
/** Where a row stands in a review run. `running` means claimed by a live pass. */
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** How a reviewed row settled once it had an answer. */
export type ReviewVerdict = 'pass' | 'change_proposed';

/**
 * A review run's own status, which is not a `RunStatus`.
 *
 * `initialized` has no translate equivalent: a run exists, with its snapshot and
 * its derived id, before anything has executed. `paused_quota` is absent for the
 * mirror-image reason - a quota pause ends a *pass*, and the job it was working
 * on is still open.
 */
export type ReviewRunStatus = 'initialized' | 'running' | 'completed' | 'failed' | 'interrupted';

/** One row of a review run: a frozen source and target, and what a reviewer said about them. */
export interface ReviewItem extends ClaimedRow {
  /**
   * The corpus row number this was snapshotted from, and this row's key within
   * the run. Deliberately not a foreign key into `items`: a review run is a
   * snapshot, and a corpus that legitimately loses a row must not take a
   * finished review run with it.
   */
  rowNumber: number;
  identifier: string;
  /** The corpus row's input hash at snapshot time, for spotting drift after the fact. */
  inputHash: string;
  sourceHash: string;
  targetHash: string;
  /** Hash of the consistency evidence this row was reviewed against. */
  evidenceHash: string;
  source: Fields;
  /** The value under review: the accepted corpus target, or a chained run's resolved output. */
  target: Fields;
  outcome: ReviewOutcome;
  severity: string | null;
  confidence: string | null;
  /** Per-field proposed rewrites, `null` per field where the reviewer proposes nothing. */
  proposals: Fields | null;
  issues: string[] | null;
  attemptCount: number;
  lastError: string | null;
  updatedAt: string;
}

/** A row ready to be written into a fresh review run. */
export interface ReviewItemRecord {
  rowNumber: number;
  identifier: string;
  inputHash: string;
  sourceHash: string;
  targetHash: string;
  evidenceHash: string;
  source: Readonly<Fields>;
  target: Readonly<Fields>;
  /**
   * Seed the row `pass` with no proposal, because the caller can already answer
   * it. This is `job.precomputed` one level up: a value the target fixes rather
   * than translates has nothing to judge, and judging one fixed string once per
   * row is as many chances to word it differently as there are rows.
   */
  settled?: boolean;
}

/**
 * What a review run is made of, beyond its rows.
 *
 * `inputs` is a bag rather than a column per hash on purpose. Which inputs a run
 * id is derived from belongs to the review contract, not to the store, and a
 * host folds its own in (a termbase digest, a house style guide) without the
 * library knowing what they are. A column each would freeze that list into the
 * schema and make every new input a migration.
 */
export interface ReviewRunRecord {
  runId: string;
  /** The provider binding, fixed when the run is created and refused a change later. */
  provider: string | null;
  model: string | null;
  profile: string | null;
  reasoningEffort: string | null;
  /** Whatever the caller wants recorded about how the run was configured. */
  options: Readonly<Record<string, unknown>>;
  /** The hashes the run id was derived from, by name. */
  inputs: Readonly<Record<string, string>>;
  /** The completed run whose resolved output this run reviews, if it chains. */
  baseRunId: string | null;
}

/** A review run as stored: what it was created with, plus where it has got to. */
export interface StoredReviewRun extends ReviewRunRecord {
  status: ReviewRunStatus;
  createdAt: string;
  finishedAt: string | null;
}

export interface ReviewCandidateFilter {
  limit?: number | null;
  identifiers?: readonly string[] | null;
  /** Include rows a previous pass gave up on. */
  retryFailed?: boolean;
  /**
   * Re-review rows that already hold a verdict. The reason to do that is a
   * changed prompt or a changed schema - but both of those change the run id, so
   * this is rarer here than its translate counterpart and exists mainly for a
   * host re-running a row whose answer was visibly wrong.
   */
  redo?: boolean;
}

export interface ReviewCommitArgs {
  attemptId: number;
  duration: number;
  exitCode: number;
  rowNumber: number;
  verdict: ReviewVerdict;
  severity: string | null;
  confidence: string | null;
  proposals: Readonly<Fields>;
  issues: readonly string[];
  attemptNumber: number;
}

export interface ReviewFailArgs {
  rowNumber: number;
  lastError: string;
  attemptCount: number;
}

/**
 * The durable half of a resumable review run, scoped to one run.
 *
 * ## What an implementation must guarantee
 *
 * **Terms 1 to 5 and 10 are `BatchStore`'s**, stated once on that interface and
 * checked by `batchConformance`, which this store passes unchanged. Two more are this
 * interface's own, and both exist because a review run is a fixed object:
 *
 * 7. **`createRun` writes the run and all of its rows in one transaction, and
 *    refuses to overwrite a run that exists.** Init is idempotent by derivation -
 *    the same inputs produce the same run id - so a second call must return the
 *    first run rather than rebuild it. A partial run is worse than no run: it
 *    reports `created: false` on the next call and then reviews a corpus with a
 *    hole in it.
 *
 * 8. **Nothing here may write to the translate half.** The reviewer proposes; a
 *    human adopts. A store that let a verdict reach `items` would turn an
 *    auditable proposal into a silent edit, which is the one property the whole
 *    lifecycle is built to have.
 *
 * The numbering continues the translate half's rather than restarting, because
 * five of the terms that apply to it are shared with this one and two numbering
 * schemes over one contract is how "term 2" stops meaning anything. The cost is
 * that a later term lands out of order - `TranslationStore`'s `items` is term 9,
 * added after these two - and that is the right cost to pay.
 */
export interface ReviewStore extends BatchStore<ReviewItem> {
  /** The run this store is scoped to. */
  readonly reviewRunId: string;

  /**
   * Create the run and its rows, or report that it already existed (term 7).
   * Returns whether it was created, which is init's `created` flag.
   */
  createRun(run: ReviewRunRecord, items: readonly ReviewItemRecord[]): Promise<boolean>;

  /** The run as stored, or `null` if it has not been created. */
  run(): Promise<StoredReviewRun | null>;

  /**
   * Bind the provider to a run that was created without one.
   *
   * Separate from `createRun` because the binding may legitimately arrive later:
   * a run can be initialized long before anyone chooses which model reviews it.
   * Once set it is not changed here - refusing the switch is the caller's rule
   * and it needs the old value to say what it is refusing.
   */
  bindProvider(binding: {
    provider: string;
    model: string | null;
    reasoningEffort: string | null;
  }): Promise<void>;

  /** Record where the run has got to. Passes come and go; this is the job's own status. */
  setRunStatus(status: ReviewRunStatus): Promise<void>;

  counts(): Promise<Record<ReviewOutcome, number>>;

  selectCandidates(filter: ReviewCandidateFilter): Promise<ReviewItem[]>;

  /**
   * Every row of the run, in row order, whatever its outcome.
   *
   * The unit the decision model and every exporter work from: a review run is a
   * fixed object, so reading it back is reading the whole of it. Chaining reads
   * the base run this way too, through a store scoped to that run.
   */
  snapshot(): Promise<ReviewItem[]>;

  commitVerdict(args: ReviewCommitArgs): Promise<void>;

  markItemFailed(args: ReviewFailArgs): Promise<void>;
}
