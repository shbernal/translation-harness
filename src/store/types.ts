// The durable registry, as a seam.
//
// The runner performs exactly these operations and nothing else, which is why
// the interface is this shape rather than a generic data-access layer: it is
// the set of things a resumable batch actually needs, one method per operation.
//
// It is asynchronous even though the implementation that ships is synchronous.
// A synchronous interface is the honest shape of `node:sqlite` and is cheaper to
// write, but it can only ever be implemented by a synchronous store: no
// Postgres, no network-backed registry, no SQLite behind a worker thread. Those
// are the consumers the seam exists for, so a synchronous interface would buy a
// refactor and deliver nothing, and it is the direction that cannot be widened
// later without a breaking change.

import type { TransientFailure } from '../errors.ts';
import type { Fields } from '../job.ts';

export const STATUSES = ['pending', 'running', 'succeeded', 'review_required', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

/** How a row settled once it had an answer. */
export type Outcome = 'succeeded' | 'review_required';

export type RunStatus = 'running' | 'completed' | 'failed' | 'paused_quota' | 'interrupted';

/** One row of the registry, as the runner sees it. */
export interface Item {
  rowNumber: number;
  identifier: string;
  /** The source fields, already parsed. */
  source: Fields;
  inputHash: string;
  status: Status;
  /** The accepted translation, or `null` while the row has no answer. */
  target: Fields | null;
  warnings: string[] | null;
  reviewReasons: string[] | null;
  /** Identity of the prompt that produced the answer. */
  promptHash: string | null;
  model: string | null;
  attemptCount: number;
  lastError: string | null;
  updatedAt: string;
}

export interface SyncResult {
  inserted: number;
  reset: number;
}

export interface CandidateFilter {
  limit?: number | null;
  identifiers?: readonly string[] | null;
  retryFailed?: boolean;
  includeReview?: boolean;
  /**
   * Re-run rows that already hold an answer, `succeeded` included. The reason to
   * do that is a changed prompt or a new validator, which applies however the
   * row landed the first time, so this widens to every settled status rather
   * than naming one. Guard it behind an explicit identifier list in any
   * interface you build on top: without that, a stray flag retranslates the
   * whole corpus.
   */
  redo?: boolean;
}

export interface RunRecord {
  runId: string;
  /** What actually produced the rows, for provenance. */
  model: string;
  /** Whatever the caller wants recorded about how the run was configured. */
  options: Readonly<Record<string, unknown>>;
}

export interface AttemptStart {
  runId: string;
  rowNumber: number;
}

export interface StartedAttempt {
  attemptId: number;
  /** The row's attempt number across all runs, allocated by the store. */
  attemptNumber: number;
}

/** Absolute paths to the evidence one attempt left behind. */
export interface AttemptPaths {
  responsePath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface CommitArgs {
  attemptId: number;
  duration: number;
  outcome: Outcome;
  exitCode: number;
  rowNumber: number;
  translations: Fields;
  warnings: readonly string[];
  reviewReasons: readonly string[];
  promptHash: string;
  modelLabel: string;
  attemptNumber: number;
}

export interface PrecomputedCommitArgs {
  rowNumber: number;
  outcome: Outcome;
  translations: Fields;
  warnings: readonly string[];
  reviewReasons: readonly string[];
  promptHash: string;
}

export interface FailArgs {
  rowNumber: number;
  lastError: string;
  promptHash: string;
  modelLabel: string;
  attemptCount: number;
}

/** A row ready to be written into a fresh registry. */
export interface StoreRecord {
  rowNumber: number;
  identifier: string;
  source: Readonly<Fields>;
  target?: Readonly<Fields>;
  seedSucceeded: boolean;
  inputHash: string;
}

/**
 * The durable registry behind a resumable run.
 *
 * ## What an implementation must guarantee
 *
 * These are not documentation of the SQLite implementation, they are the terms
 * the runner is written against. `storeConformance` in `conformance.ts` checks
 * every one of them, and running it is how you find out whether your store is
 * actually a store.
 *
 * 1. **Every method is its own transaction.** The runner never needs atomicity
 *    spanning two calls, so no method may leave a partial write visible and
 *    none may require a surrounding transaction.
 *
 * 2. **`tryClaim` is atomic against other *processes*,** not merely against
 *    other workers in this one. It returns a given row to at most one caller,
 *    ever. Everything else rests on this, and it is the one term a lazy
 *    implementation breaks invisibly: the symptom is two workers translating
 *    the same row and the second silently overwriting the first.
 *
 * 3. **Store failures are not translation failures.** A rejected store call is
 *    a fatal run error. Never raise `TransientFailure` from a store method: the
 *    runner would retry the row, and a row does not become translatable because
 *    you tried it again after the disk filled up.
 *
 * 4. **`recordInternalError` may itself fail,** since the store is very often
 *    what broke. The runner swallows its rejection so it cannot mask the
 *    original error, which means an implementation must not rely on it having
 *    succeeded.
 *
 * 5. **Paths handed to the store are absolute.** How they are recorded is the
 *    store's business; `sqliteStore` takes a `pathBase` and relativizes against
 *    it. A consumer reading paths back gets whatever form that store chose.
 *
 * 6. **`initialize` refuses to run when the registry holds a row absent from
 *    the supplied records.** That is the guard that turns silent corpus drift
 *    into an error, and it is a contract term rather than an implementation
 *    detail: without it a shrinking corpus quietly orphans finished work.
 */
export interface TranslationStore {
  /**
   * Create or sync the registry from the caller's records. Idempotent:
   * unchanged rows keep their translations, a changed input hash resets only
   * that row, and a registry row missing from `records` is an error (term 6).
   */
  initialize(records: readonly StoreRecord[]): Promise<SyncResult>;

  counts(): Promise<Record<Status, number>>;

  selectCandidates(filter: CandidateFilter): Promise<Item[]>;

  /**
   * Atomically take ownership of a row, or return `null` if someone else got
   * there first. Losing the race is an ordinary outcome under concurrency, not
   * an error, which is why it is a `null` and not a rejection.
   */
  tryClaim(rowNumber: number, runId: string): Promise<Item | null>;

  /** Release rows back to pending, ignoring any no longer running. */
  unclaim(rowNumbers: readonly number[]): Promise<number>;

  /** Reclaim rows and runs abandoned by a process that never came back. */
  reclaimStale(ageMinutes?: number): Promise<number>;

  /**
   * Release rows still claimed by a run that has already ended, without waiting
   * on a clock. Returns the number released.
   *
   * `reclaimStale` needs a cutoff because it cannot tell a dead process from a
   * slow one. When the owning run is recorded as anything other than `running`
   * that question is already answered: `finishRun` is called after every worker
   * has returned, so a settled run has nothing in flight and any row it still
   * holds is stranded. Waiting 30 minutes to release it accomplishes nothing,
   * and under repeated kills the stranded set grows faster than it drains.
   *
   * Rows claimed with no `run_id` are left alone - they predate the column and
   * cannot be attributed, so they remain `reclaimStale`'s business.
   */
  releaseSettledRunClaims(): Promise<number>;

  /**
   * Every answered row's translation, keyed by identifier rather than by row
   * number. Row numbers belong to one reading of one corpus, so they are the
   * wrong key the moment two registries are read together; the identifier is
   * the corpus's own and is what makes two translations comparable. Rows with
   * no answer yet are absent, so a caller reading a partial corpus gets a gap
   * rather than a silently wrong value.
   */
  translationsByIdentifier(): Promise<Map<string, Fields>>;

  startRun(run: RunRecord): Promise<void>;
  finishRun(runId: string, status: RunStatus): Promise<void>;

  /**
   * Allocate the row's next attempt number and insert the attempt, in one
   * transaction.
   *
   * The allocation is inside the write on purpose. It used to be a bare
   * `SELECT MAX(...) + 1` before the insert, which was safe only because the
   * claim had already excluded every other worker *and* because nothing could
   * interleave between two synchronous statements. The second support does not
   * exist here, and the first does not exist for any store whose claim is a
   * lease rather than a lock.
   */
  startAttempt(attempt: AttemptStart): Promise<StartedAttempt>;

  /**
   * Record where an attempt's evidence lives. Separate from `startAttempt`
   * because the log file names embed the attempt number, which the store
   * allocates. Between the two calls an attempt row has null paths, which is
   * consistent: the files do not exist yet either.
   */
  setAttemptPaths(attemptId: number, paths: AttemptPaths): Promise<void>;

  commitSuccess(args: CommitArgs): Promise<void>;

  /** Commit a row the caller answered without a provider. */
  commitPrecomputed(args: PrecomputedCommitArgs): Promise<void>;

  failAttempt(attemptId: number, error: TransientFailure): Promise<void>;

  markItemFailed(args: FailArgs): Promise<void>;

  /**
   * Fail everything a run currently owns, and nothing else. `inFlight` is the
   * rows that run had claimed at the moment it broke; an empty set must update
   * no item at all, because "every running row" would also fail the rows a
   * concurrent process happens to hold.
   */
  recordInternalError(runId: string, error: unknown, inFlight: readonly number[]): Promise<void>;

  /** Release whatever the store is holding. Calling it twice must be safe. */
  close(): Promise<void>;
}
