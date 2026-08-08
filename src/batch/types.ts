// The batch seam: everything a resumable per-row agent batch needs from a
// durable registry, and nothing that knows what a row means.
//
// Every type here was `store/types.ts`'s until the runner was generalized, and
// it moved down rather than being copied. That direction matters: `BatchStore` is
// `TranslationStore`'s supertype, so a second lifecycle built on this seam
// *inherits* the guarantees the translation store already earned instead of
// re-earning them, and `batchConformance` is the executable form of that
// inheritance.
//
// The layer rule (`docs/architecture.md`) is what keeps this honest: `batch` may
// import `errors` and `provider`, and nothing else. A row number and an
// identifier are the only things this file knows about a row.

import type { TransientFailure } from '../errors.ts';

/**
 * The least a claimed row can be, and the only part of a row the batch runner
 * reads.
 *
 * `rowNumber` is the registry's key. `identifier` is the corpus's own name for
 * the row, and it is here rather than left to the caller because the runner
 * builds the per-attempt evidence file names out of it and puts it in every
 * event: a progress line reading `row 4817` helps nobody.
 *
 * A concrete store returns its own richer row type, which is why `BatchStore` is
 * generic in it. `TranslationStore` returns an `Item`; the runner hands whatever
 * came back to the caller's callbacks untouched.
 */
export interface ClaimedRow {
  rowNumber: number;
  identifier: string;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'paused_quota' | 'interrupted';

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

/**
 * The durable registry behind a resumable batch.
 *
 * ## What an implementation must guarantee
 *
 * These are the terms the runner is written against, not a description of the
 * SQLite store, and `batchConformance` in `conformance.ts` checks every one.
 * They are numbered as they are in `docs/architecture.md`, where terms 1 to 5 are
 * these, 6 and 9 belong to `TranslationStore` and 7 and 8 to `ReviewStore`, so a
 * reference to "term 2" means the same thing wherever it appears. One sequence
 * over every interface, which is why a term's number is not contiguous with its
 * interface's others.
 *
 * 1. **Every method is its own transaction.** The runner never needs atomicity
 *    spanning two calls, so no method may leave a partial write visible and
 *    none may require a surrounding transaction.
 *
 * 2. **`tryClaim` is atomic against other *processes*,** not merely against
 *    other workers in this one. It returns a given row to at most one caller,
 *    ever. Everything else rests on this, and it is the one term a lazy
 *    implementation breaks invisibly: the symptom is two workers doing the same
 *    row and the second silently overwriting the first.
 *
 * 3. **Store failures are not row failures.** A rejected store call is a fatal
 *    run error. Never raise `TransientFailure` from a store method: the runner
 *    would retry the row, and a row does not become answerable because you tried
 *    it again after the disk filled up.
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
 * What is deliberately *not* here is how a row is created, selected or settled.
 * Those are the lifecycle's, which is why `initialize`, `selectCandidates`,
 * `commitSuccess` and `markItemFailed` are on `TranslationStore` and why the
 * runner takes committing and failing a row as callbacks rather than as methods.
 */
export interface BatchStore<TRow extends ClaimedRow = ClaimedRow> {
  /**
   * Atomically take ownership of a row, or return `null` if someone else got
   * there first. Losing the race is an ordinary outcome under concurrency, not
   * an error, which is why it is a `null` and not a rejection.
   *
   * What comes back is the store's own row, freshly read. The runner passes it
   * to the caller's callbacks rather than passing the candidate it started from,
   * because between selection and the claim the row may have moved.
   */
  tryClaim(rowNumber: number, runId: string): Promise<TRow | null>;

  /** Release rows back to pending, ignoring any no longer claimed. */
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
   * holds is stranded.
   *
   * Rows claimed with no run recorded against them are left alone: there is no
   * run to ask about them, so they remain `reclaimStale`'s business.
   */
  releaseSettledRunClaims(): Promise<number>;

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

  failAttempt(attemptId: number, error: TransientFailure): Promise<void>;

  /**
   * Fail everything a run currently owns, and nothing else. `inFlight` is the
   * rows that run had claimed at the moment it broke; an empty set must update
   * no row at all, because "every claimed row" would also fail the rows a
   * concurrent process happens to hold.
   */
  recordInternalError(runId: string, error: unknown, inFlight: readonly number[]): Promise<void>;

  /** Release whatever the store is holding. Calling it twice must be safe. */
  close(): Promise<void>;
}
