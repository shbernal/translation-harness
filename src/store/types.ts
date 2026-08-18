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
//
// Half of it now lives one layer down. `BatchStore` in `batch/types.ts` holds
// everything a claim-and-retry pool needs and nothing about what a row means, and
// `TranslationStore` extends it with the translation lifecycle. The edge points
// this way and only this way: `store` may import `batch`, never the reverse.

import type { BatchStore, ClaimedRow } from '../batch/types.ts';
import type { Fields } from '../job.ts';

// Re-exported rather than redeclared: these describe a run and an attempt, not a
// translation, so they moved down with the runner. They stay visible here (and at
// the package root) because they were published there first.
export type {
  AttemptPaths,
  AttemptStart,
  RunRecord,
  RunStatus,
  StartedAttempt,
} from '../batch/types.ts';

export const STATUSES = ['pending', 'running', 'succeeded', 'review_required', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

/** How a row settled once it had an answer. */
export type Outcome = 'succeeded' | 'review_required';

/** One row of the registry, as the runner sees it. */
export interface Item extends ClaimedRow {
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
 * The durable registry behind a resumable translation run.
 *
 * ## What an implementation must guarantee
 *
 * These are not documentation of the SQLite implementation, they are the terms
 * the runner is written against. `storeConformance` in `conformance.ts` checks
 * every one of them, and running it is how you find out whether your store is
 * actually a store.
 *
 * **Terms 1 to 5 and 10 are `BatchStore`'s** and their prose is on that interface:
 * every method is its own transaction; `tryClaim` is atomic against other
 * *processes*; store failures are never row failures; `recordInternalError` may
 * itself fail; paths handed to the store are absolute; and a released row returns
 * to the status it held before it was claimed. They are checked by `batchConformance`,
 * which `storeConformance` runs first. Nothing about them is translation-specific,
 * which is why they are stated once for both lifecycles.
 *
 * Two terms are this interface's own:
 *
 * 6. **`initialize` refuses to run when the registry holds a row absent from
 *    the supplied records.** That is the guard that turns silent corpus drift
 *    into an error, and it is a contract term rather than an implementation
 *    detail: without it a shrinking corpus quietly orphans finished work.
 *
 * 9. **`items` returns every row, in row-number order, and a row with no answer
 *    has a `target` of `null` and never `{}`.** The `null` half is the
 *    load-bearing one and it is a term rather than a detail because getting it
 *    wrong produces a wrong answer rather than a failure: an unanswered row and
 *    a row answered with an empty object hash differently, so a store that
 *    normalizes one to the other silently moves every review run id derived
 *    from the corpus it returns.
 *
 * **The gap from 6 to 9 is deliberate.** Terms 7 and 8 are `ReviewStore`'s, which
 * continues this numbering rather than restarting it, so the numbers name
 * guarantees across the whole contract and a comment reading "term 2" means one
 * thing everywhere. A new term therefore takes the next free number, not the next
 * number on its own interface. Nothing renumbers, ever: the numbering did not
 * shift when the seam split either, and comments across `src/` and `test/` name
 * terms by number.
 */
export interface TranslationStore extends BatchStore<Item> {
  /**
   * Create or sync the registry from the caller's records. Idempotent:
   * unchanged rows keep their translations, a changed input hash resets only
   * that row, and a registry row missing from `records` is an error (term 6).
   */
  initialize(records: readonly StoreRecord[]): Promise<SyncResult>;

  counts(): Promise<Record<Status, number>>;

  /**
   * Every row of the corpus, in row-number order, whatever its status (term 9).
   *
   * This is the corpus, not a work queue, and the difference from
   * `selectCandidates` is the whole reason it exists. A candidate selection
   * excludes `running` because a live pass owns those rows; a corpus that
   * excluded them would be a corpus with a hole in it whose shape depended on
   * what happened to be executing.
   *
   * It exists for `initializeReview`, which takes its corpus as *data* rather
   * than reading a store - that is what makes a filtered corpus a different run
   * id instead of a run with a hole in it - and therefore leaves a host whose
   * corpus does live in this registry with nothing to read it back with.
   * `Item` satisfies `ReviewSourceRow` structurally, so the way in is
   * `initializeReview(store.review, { corpus: await store.items(), ... })`.
   * Before this existed, two hosts out of two hand-wrote the same query.
   *
   * Neither of the two readers already here would do. `translationsByIdentifier`
   * drops the status and the input hash, and `selectCandidates({redo: true})`
   * returns everything except `running` only as a consequence of what a redo
   * means, so using it as a corpus reader would be relying on an accident.
   *
   * It returns an array rather than streaming, which is a deliberate limit: a
   * whole-corpus read is a whole corpus in memory. The caller it exists for
   * cannot avoid that anyway, because a review run id is a hash over every row
   * in row order, so an iterator would move the materialization rather than
   * remove it.
   */
  items(): Promise<Item[]>;

  selectCandidates(filter: CandidateFilter): Promise<Item[]>;

  /**
   * Every answered row's translation, keyed by identifier rather than by row
   * number. Row numbers belong to one reading of one corpus, so they are the
   * wrong key the moment two registries are read together; the identifier is
   * the corpus's own and is what makes two translations comparable. Rows with
   * no answer yet are absent, so a caller reading a partial corpus gets a gap
   * rather than a silently wrong value.
   */
  translationsByIdentifier(): Promise<Map<string, Fields>>;

  commitSuccess(args: CommitArgs): Promise<void>;

  /** Commit a row the caller answered without a provider. */
  commitPrecomputed(args: PrecomputedCommitArgs): Promise<void>;

  markItemFailed(args: FailArgs): Promise<void>;
}
