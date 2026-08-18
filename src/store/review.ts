// The review half of the registry, on the same `node:sqlite` connection.
//
// Additive and separate from translation: nothing in the translate half
// references these tables and nothing here writes to `items` (term 8). The one
// hard link is `review_items.row_number`, which is an `items` row number by
// convention and deliberately not a foreign key, because a review run is a
// snapshot and a corpus that legitimately loses a row must not take a finished
// run with it.
//
// Three tables, and the middle one is the one to read first:
//
// - **`review_runs` is a job**, not an invocation. It is created once with a
//   derived id and a frozen snapshot, and executed as many times as it takes.
// - **`review_passes` is an invocation**, and it is what the batch layer means by
//   a run: `startRun` opens one, `finishRun` closes it, and a claim records the
//   pass holding it. Without this table the two would be the same object, and
//   then `releaseSettledRunClaims` could never fire (a job stays open across the
//   crash that stranded the rows) and `reclaimStale` would read a job's creation
//   time as evidence about a live process. Both of those are guarantees the
//   translate half already ships, and inheriting them was the whole argument for
//   one runner.
// - **`review_items` is a row of the snapshot**, keyed by the run and the corpus
//   row number, which is why a store is scoped to one run.

import { isAbsolute, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AttemptPaths,
  AttemptStart,
  RunRecord,
  RunStatus,
  StartedAttempt,
} from '../batch/types.ts';
import type { TransientFailure } from '../errors.ts';
import {
  closeOnce,
  type DbHandle,
  parseFields,
  tableExists,
  tableStamp,
  tx,
  utcnow,
} from './db.ts';
// Type-only, and it has to stay that way: `migrate.ts` reaches `sqlite.ts`, which
// reaches this file. A `MigrationPlan` is data, so the plan below lives with the
// schema it migrates rather than with the machinery that runs it.
import type { MigrationPlan, MigrationStep } from './migrate.ts';
import type {
  ReviewCandidateFilter,
  ReviewCommitArgs,
  ReviewFailArgs,
  ReviewItem,
  ReviewItemRecord,
  ReviewOutcome,
  ReviewRunRecord,
  ReviewRunStatus,
  ReviewStore,
  StoredReviewRun,
} from './review-types.ts';
import { REVIEW_OUTCOMES } from './review-types.ts';

/**
 * The review half's own version, kept in `schema_versions` rather than in
 * `PRAGMA user_version`.
 *
 * A file has exactly one `user_version` and the translate half has it. That is
 * not a workaround: a host who never reviews must never be migrated for review,
 * and two independent stamps are what makes "never" enforceable rather than
 * merely intended.
 */
export const REVIEW_SCHEMA_VERSION = 2;

/** Where that version lives. Answers 0 for a file that has no review half. */
export const REVIEW_STAMP = tableStamp('review');

const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_runs (
  review_run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('initialized','running','completed','failed','interrupted')),
  provider TEXT,
  model TEXT,
  profile TEXT,
  reasoning_effort TEXT,
  options_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  base_review_run_id TEXT REFERENCES review_runs(review_run_id)
);

CREATE TABLE IF NOT EXISTS review_passes (
  pass_id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(review_run_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','paused_quota','interrupted')),
  model TEXT,
  options_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_items (
  review_run_id TEXT NOT NULL REFERENCES review_runs(review_run_id),
  row_number INTEGER NOT NULL,
  identifier TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  target_snapshot_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','running','pass','change_proposed','failed')),
  severity TEXT,
  confidence TEXT,
  proposals_json TEXT,
  issues_json TEXT,
  pass_id TEXT,
  -- The outcome tryClaim displaced, so a released row goes back to what it was
  -- rather than to 'pending'. Null whenever the row is not claimed.
  claimed_from TEXT,
  started_at TEXT,
  finished_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (review_run_id, row_number),
  UNIQUE (review_run_id, identifier)
);

CREATE TABLE IF NOT EXISTS review_attempts (
  review_attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_run_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  pass_id TEXT REFERENCES review_passes(pass_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_seconds REAL,
  outcome TEXT,
  exit_code INTEGER,
  error_category TEXT,
  error_message TEXT,
  response_path TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  UNIQUE (review_run_id, row_number, attempt_number),
  FOREIGN KEY (review_run_id, row_number) REFERENCES review_items(review_run_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_review_items_outcome ON review_items(review_run_id, outcome, row_number);
CREATE INDEX IF NOT EXISTS idx_review_attempts_row ON review_attempts(review_run_id, row_number, attempt_number);
`;

/**
 * Create the review tables if they are absent and stamp their version.
 *
 * Exported for symmetry with `applySchema`, and for a host that wants the review
 * half present in a file before anything reviews anything. The ordinary way in is
 * `sqliteStore(path).review(runId)`, which calls this once.
 */
export function applyReviewSchema(db: DatabaseSync): void {
  db.exec(REVIEW_SCHEMA);
  REVIEW_STAMP.write(db, REVIEW_SCHEMA_VERSION);
}

/**
 * Bring the review half of an open connection into use, refusing a version this
 * release does not write.
 *
 * The same refusal the translate half makes on open, for the same reason, in the
 * one place a host can reach the review tables. It fires later than the
 * translate one, which is correct rather than unfortunate: a file whose review
 * half is old still opens, still translates and still reports, and only the code
 * that would misread the old tables is stopped.
 */
function useReviewSchema(db: DatabaseSync): void {
  const version = REVIEW_STAMP.read(db);
  if (version === REVIEW_SCHEMA_VERSION || (version === 0 && !tableExists(db, 'review_items'))) {
    applyReviewSchema(db);
    return;
  }
  throw new Error(
    `The review half of this registry is at schema version ${version}, but this version of ` +
      `translation-harness writes version ${REVIEW_SCHEMA_VERSION}. Refusing to use it: run ` +
      '`migrateRegistry(path, { plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] })` first. ' +
      'Ask `registryNeedsMigration` with the same plans before opening and you get this as a ' +
      'question rather than as a failure.',
  );
}

interface ReviewItemRow {
  row_number: number;
  identifier: string;
  input_hash: string;
  source_snapshot_hash: string;
  target_snapshot_hash: string;
  evidence_hash: string;
  source_json: string;
  target_json: string;
  outcome: ReviewOutcome;
  severity: string | null;
  confidence: string | null;
  proposals_json: string | null;
  issues_json: string | null;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
}

function toReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    rowNumber: row.row_number,
    identifier: row.identifier,
    inputHash: row.input_hash,
    sourceHash: row.source_snapshot_hash,
    targetHash: row.target_snapshot_hash,
    evidenceHash: row.evidence_hash,
    source: parseFields(row.source_json),
    target: parseFields(row.target_json),
    outcome: row.outcome,
    severity: row.severity,
    confidence: row.confidence,
    proposals: row.proposals_json === null ? null : parseFields(row.proposals_json),
    issues: row.issues_json === null ? null : (JSON.parse(row.issues_json) as string[]),
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

const ITEM_COLUMNS =
  'row_number, identifier, input_hash, source_snapshot_hash, target_snapshot_hash, evidence_hash, ' +
  'source_json, target_json, outcome, severity, confidence, proposals_json, issues_json, ' +
  'attempt_count, last_error, updated_at';

export interface ReviewStoreOptions {
  /** Record attempt paths relative to this directory rather than absolutely. */
  pathBase?: string;
}

/**
 * A `ReviewStore` over an open connection, scoped to one review run.
 *
 * Takes the shared `DbHandle` rather than a `DatabaseSync` so that closing this
 * store and closing the translate store it came from are the same act, done
 * once. Reached through `sqliteStore(path).review(runId)`; exported for a host
 * that already has a connection of its own.
 */
export function reviewStore(
  handle: DbHandle,
  reviewRunId: string,
  options: ReviewStoreOptions = {},
): ReviewStore {
  const { db } = handle;
  useReviewSchema(db);
  const base = options.pathBase;
  const rel = (p: string): string => (base && isAbsolute(p) ? relative(base, p) : p);

  /** The row as it now stands, read back after a write that changed it. */
  const readItem = (rowNumber: number): ReviewItem => {
    const row = db
      .prepare(
        `SELECT ${ITEM_COLUMNS} FROM review_items WHERE review_run_id = ? AND row_number = ?`,
      )
      .get(reviewRunId, rowNumber) as unknown as ReviewItemRow;
    return toReviewItem(row);
  };

  return {
    reviewRunId,

    /**
     * Term 7: the run and every one of its rows, or neither.
     *
     * The existence check is inside the same transaction as the insert, so two
     * processes initializing the same derived run id cannot both decide they
     * created it. The loser gets `false` from a unique-constraint failure being
     * impossible rather than from a race it did not notice.
     */
    async createRun(run: ReviewRunRecord, items: readonly ReviewItemRecord[]): Promise<boolean> {
      if (run.runId !== reviewRunId) {
        throw new Error(
          `This store is scoped to review run ${reviewRunId} and cannot create ${run.runId}`,
        );
      }
      const now = utcnow();
      return tx(db, () => {
        const existing = db
          .prepare('SELECT review_run_id FROM review_runs WHERE review_run_id = ?')
          .get(reviewRunId);
        if (existing !== undefined) return false;

        db.prepare(
          `INSERT INTO review_runs (review_run_id, created_at, status, provider, model, profile,
             reasoning_effort, options_json, inputs_json, base_review_run_id)
           VALUES (?, ?, 'initialized', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          reviewRunId,
          now,
          run.provider,
          run.model,
          run.profile,
          run.reasoningEffort,
          JSON.stringify(run.options),
          JSON.stringify(run.inputs),
          run.baseRunId,
        );

        const insert = db.prepare(
          `INSERT INTO review_items (review_run_id, row_number, identifier, input_hash,
             source_snapshot_hash, target_snapshot_hash, evidence_hash, source_json, target_json,
             outcome, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of items) {
          insert.run(
            reviewRunId,
            item.rowNumber,
            item.identifier,
            item.inputHash,
            item.sourceHash,
            item.targetHash,
            item.evidenceHash,
            JSON.stringify(item.source),
            JSON.stringify(item.target),
            item.settled ? 'pass' : 'pending',
            now,
          );
        }
        return true;
      });
    },

    async run(): Promise<StoredReviewRun | null> {
      const row = db
        .prepare('SELECT * FROM review_runs WHERE review_run_id = ?')
        .get(reviewRunId) as
        | {
            created_at: string;
            finished_at: string | null;
            status: ReviewRunStatus;
            provider: string | null;
            model: string | null;
            profile: string | null;
            reasoning_effort: string | null;
            options_json: string;
            inputs_json: string;
            base_review_run_id: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: reviewRunId,
        status: row.status,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        provider: row.provider,
        model: row.model,
        profile: row.profile,
        reasoningEffort: row.reasoning_effort,
        options: JSON.parse(row.options_json) as Record<string, unknown>,
        inputs: JSON.parse(row.inputs_json) as Record<string, string>,
        baseRunId: row.base_review_run_id,
      };
    },

    async bindProvider(binding): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            'UPDATE review_runs SET provider = ?, model = ?, reasoning_effort = ? WHERE review_run_id = ?',
          )
          .run(binding.provider, binding.model, binding.reasoningEffort, reviewRunId),
      );
    },

    /**
     * A finish time is recorded only for a status that ends the job. A run that
     * goes back to `running` after a pass stopped early has not finished, and a
     * stale `finished_at` beside a live status is the kind of disagreement that
     * makes a registry stop being evidence.
     */
    async setRunStatus(status: ReviewRunStatus): Promise<void> {
      const done = status === 'completed' || status === 'failed' || status === 'interrupted';
      tx(db, () =>
        db
          .prepare('UPDATE review_runs SET status = ?, finished_at = ? WHERE review_run_id = ?')
          .run(status, done ? utcnow() : null, reviewRunId),
      );
    },

    async counts(): Promise<Record<ReviewOutcome, number>> {
      const values = Object.fromEntries(REVIEW_OUTCOMES.map((o) => [o, 0])) as Record<
        ReviewOutcome,
        number
      >;
      const rows = db
        .prepare(
          'SELECT outcome, COUNT(*) AS count FROM review_items WHERE review_run_id = ? GROUP BY outcome',
        )
        .all(reviewRunId) as { outcome: ReviewOutcome; count: number }[];
      for (const row of rows) values[row.outcome] = row.count;
      return values;
    },

    async selectCandidates(filter: ReviewCandidateFilter): Promise<ReviewItem[]> {
      // `running` is never a candidate whatever the filter says: a live pass owns
      // those rows, and `tryClaim` refuses them anyway.
      const outcomes: ReviewOutcome[] = filter.redo
        ? ['pending', 'failed', 'pass', 'change_proposed']
        : ['pending'];
      if (filter.retryFailed && !filter.redo) outcomes.push('failed');
      const where = ['review_run_id = ?', `outcome IN (${outcomes.map(() => '?').join(',')})`];
      const params: (string | number)[] = [reviewRunId, ...outcomes];
      if (filter.identifiers?.length) {
        where.push(`identifier IN (${filter.identifiers.map(() => '?').join(',')})`);
        params.push(...filter.identifiers);
      }
      let sql = `SELECT ${ITEM_COLUMNS} FROM review_items WHERE ${where.join(' AND ')} ORDER BY row_number`;
      if (filter.limit != null) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
      }
      const rows = db.prepare(sql).all(...params) as unknown as ReviewItemRow[];
      if (filter.identifiers?.length) {
        const found = new Set(rows.map((r) => r.identifier));
        const missing = filter.identifiers.filter((id) => !found.has(id));
        if (missing.length)
          throw new Error(`Requested identifiers not eligible or not found: ${missing.join(', ')}`);
      }
      return rows.map(toReviewItem);
    },

    async snapshot(): Promise<ReviewItem[]> {
      const rows = db
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM review_items WHERE review_run_id = ? ORDER BY row_number`,
        )
        .all(reviewRunId) as unknown as ReviewItemRow[];
      return rows.map(toReviewItem);
    },

    /**
     * Term 2, and the reason it holds here.
     *
     * The `AND outcome != 'running'` is the whole point: the UPDATE and the test
     * are one statement, so two passes over one run - which is the ordinary way
     * a review is resumed while another process is still going - cannot both
     * come away believing they own the row.
     */
    async tryClaim(rowNumber: number, passId: string): Promise<ReviewItem | null> {
      const now = utcnow();
      const changed = tx(db, () => {
        const cursor = db
          .prepare(
            `UPDATE review_items SET claimed_from = outcome, outcome = 'running', pass_id = ?,
                    started_at = ?, updated_at = ?
             WHERE review_run_id = ? AND row_number = ? AND outcome != 'running'`,
          )
          .run(passId, now, now, reviewRunId, rowNumber);
        return cursor.changes;
      });
      if (changed !== 1) return null;
      return readItem(rowNumber);
    },

    async unclaim(rowNumbers: readonly number[]): Promise<number> {
      if (!rowNumbers.length) return 0;
      return tx(db, () => {
        const cursor = db
          .prepare(
            `UPDATE review_items SET outcome = COALESCE(claimed_from, 'pending'), claimed_from = NULL,
                    pass_id = NULL, updated_at = ?
             WHERE review_run_id = ? AND outcome = 'running'
               AND row_number IN (${rowNumbers.map(() => '?').join(',')})`,
          )
          .run(utcnow(), reviewRunId, ...rowNumbers);
        return cursor.changes as number;
      });
    },

    /**
     * The cutoff is inclusive, as it is for translate, so `reclaimStale(0)` can
     * express "release everything now".
     *
     * It closes stale *passes* and leaves the run alone, which is the one place
     * this diverges from the translate half. A pass has a real start time and a
     * process behind it; a run may have been created yesterday and legitimately
     * be executing now, so its `created_at` is not evidence about liveness and
     * reading it as such would interrupt a healthy job.
     *
     * The same argument then applies one level down, and used not to. A pass
     * has a start time and a process, but a *long* pass has an old start time
     * and a working process, so a pass is interrupted only when it also holds
     * no row touched since the cutoff. Its rows are the evidence; its age is
     * not. That gate is what lets the attempts statement key off pass status
     * alone - it used to close dangling attempts for any pass merely *started*
     * before the cutoff, stamping `abandoned` over the in-flight attempts of a
     * healthy long pass and then interrupting the pass underneath them.
     *
     * `pass_id IS NOT NULL` inside the subquery is load-bearing rather than
     * tidy: one NULL in a `NOT IN` list makes the comparison NULL for every
     * row, which would switch pass reclamation off entirely.
     */
    async reclaimStale(ageMinutes = 30): Promise<number> {
      const cutoff = new Date(Date.now() - ageMinutes * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      return tx(db, () => {
        // The passes statement goes first, so a pass this call has just
        // declared dead has its dangling attempts closed by the next one, in
        // the same transaction.
        db.prepare(
          `UPDATE review_passes SET status = 'interrupted', finished_at = ?
           WHERE review_run_id = ? AND status = 'running' AND started_at <= ?
             AND pass_id NOT IN (
               SELECT pass_id FROM review_items
               WHERE review_run_id = ? AND outcome = 'running' AND pass_id IS NOT NULL
                 AND updated_at > ?
             )`,
        ).run(utcnow(), reviewRunId, cutoff, reviewRunId, cutoff);
        db.prepare(
          `UPDATE review_attempts SET finished_at = ?, outcome = 'failed', error_category = 'abandoned',
             error_message = 'runner ended before recording the attempt result'
           WHERE review_run_id = ? AND outcome IS NULL
             AND pass_id IN (SELECT pass_id FROM review_passes WHERE status != 'running')`,
        ).run(utcnow(), reviewRunId);
        const cursor = db
          .prepare(
            `UPDATE review_items SET outcome = COALESCE(claimed_from, 'pending'), claimed_from = NULL,
                    pass_id = NULL, last_error = 'reclaimed stale running row', updated_at = ?
             WHERE review_run_id = ? AND outcome = 'running' AND updated_at <= ?`,
          )
          .run(utcnow(), reviewRunId, cutoff);
        return cursor.changes as number;
      });
    },

    /**
     * The clock-free half of `reclaimStale`, and it is the reason `review_passes`
     * exists. A pass with a settled status has nothing in flight, because
     * `finishRun` runs after every worker has returned, so any row it still holds
     * is stranded. Were a claim recorded against the review run instead, this
     * could never fire: the job stays open across exactly the crash that stranded
     * the rows.
     */
    async releaseSettledRunClaims(): Promise<number> {
      return tx(db, () => {
        db.prepare(
          `UPDATE review_attempts SET finished_at = ?, outcome = 'failed', error_category = 'abandoned',
             error_message = 'runner ended before recording the attempt result'
           WHERE review_run_id = ? AND outcome IS NULL
             AND pass_id IN (SELECT pass_id FROM review_passes WHERE status != 'running')`,
        ).run(utcnow(), reviewRunId);
        const cursor = db
          .prepare(
            `UPDATE review_items SET outcome = COALESCE(claimed_from, 'pending'), claimed_from = NULL,
                    pass_id = NULL,
                    last_error = 'released: the pass holding this row had already ended', updated_at = ?
             WHERE review_run_id = ? AND outcome = 'running' AND pass_id IS NOT NULL
               AND pass_id IN (SELECT pass_id FROM review_passes WHERE status != 'running')`,
          )
          .run(utcnow(), reviewRunId);
        return cursor.changes as number;
      });
    },

    /** Open a pass over this run. The batch layer's "run" is one of these. */
    async startRun(pass: RunRecord): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `INSERT INTO review_passes (pass_id, review_run_id, started_at, status, model, options_json)
             VALUES (?, ?, ?, 'running', ?, ?)`,
          )
          .run(pass.runId, reviewRunId, utcnow(), pass.model, JSON.stringify(pass.options)),
      );
    },

    async finishRun(passId: string, status: RunStatus): Promise<void> {
      tx(db, () =>
        db
          .prepare('UPDATE review_passes SET finished_at = ?, status = ? WHERE pass_id = ?')
          .run(utcnow(), status, passId),
      );
    },

    /**
     * Attempt numbers are per row within the run, allocated inside the write for
     * the reason `startAttempt` gives on the base interface: the read-then-insert
     * this replaces was safe only while nothing could interleave between two
     * synchronous statements, which an async interface stops promising.
     */
    async startAttempt(attempt: AttemptStart): Promise<StartedAttempt> {
      return tx(db, () => {
        const next = db
          .prepare(
            `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM review_attempts
             WHERE review_run_id = ? AND row_number = ?`,
          )
          .get(reviewRunId, attempt.rowNumber) as { n: number };
        const cursor = db
          .prepare(
            `INSERT INTO review_attempts (review_run_id, row_number, attempt_number, pass_id, started_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(reviewRunId, attempt.rowNumber, next.n, attempt.runId, utcnow());
        return { attemptId: Number(cursor.lastInsertRowid), attemptNumber: next.n };
      });
    },

    async setAttemptPaths(attemptId: number, paths: AttemptPaths): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE review_attempts SET response_path = ?, stdout_path = ?, stderr_path = ?
             WHERE review_attempt_id = ?`,
          )
          .run(rel(paths.responsePath), rel(paths.stdoutPath), rel(paths.stderrPath), attemptId),
      );
    },

    async failAttempt(attemptId: number, error: TransientFailure): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE review_attempts SET finished_at = ?, outcome = 'failed', exit_code = ?,
               error_category = ?, error_message = ? WHERE review_attempt_id = ?`,
          )
          .run(utcnow(), error.exitCode, error.category, error.message.slice(-2000), attemptId),
      );
    },

    /**
     * A verdict and the attempt that produced it, in one transaction, and
     * nothing outside `review_items` (term 8). The reviewer proposes; adopting
     * the proposal is a separate, human, auditable step.
     */
    async commitVerdict(a: ReviewCommitArgs): Promise<void> {
      tx(db, () => {
        db.prepare(
          `UPDATE review_attempts SET finished_at = ?, duration_seconds = ?, outcome = ?, exit_code = ?
           WHERE review_attempt_id = ?`,
        ).run(utcnow(), a.duration, a.verdict, a.exitCode, a.attemptId);
        db.prepare(
          `UPDATE review_items SET outcome = ?, severity = ?, confidence = ?, proposals_json = ?,
             issues_json = ?, finished_at = ?, attempt_count = ?, last_error = NULL, pass_id = NULL,
             claimed_from = NULL, updated_at = ?
           WHERE review_run_id = ? AND row_number = ?`,
        ).run(
          a.verdict,
          a.severity,
          a.confidence,
          JSON.stringify(a.proposals),
          JSON.stringify(a.issues),
          utcnow(),
          a.attemptNumber,
          utcnow(),
          reviewRunId,
          a.rowNumber,
        );
      });
    },

    async markItemFailed(a: ReviewFailArgs): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE review_items SET outcome = 'failed', attempt_count = ?, last_error = ?,
               pass_id = NULL, claimed_from = NULL, updated_at = ?
             WHERE review_run_id = ? AND row_number = ?`,
          )
          .run(a.attemptCount, a.lastError, utcnow(), reviewRunId, a.rowNumber),
      );
    },

    async recordInternalError(
      passId: string,
      error: unknown,
      inFlight: readonly number[],
    ): Promise<void> {
      const message = `${error instanceof Error ? error.name : 'Error'}: ${String(error)}`.slice(
        -2000,
      );
      tx(db, () => {
        db.prepare(
          `UPDATE review_attempts SET finished_at = ?, outcome = 'failed',
             error_category = 'internal_error', error_message = ?
           WHERE pass_id = ? AND outcome IS NULL`,
        ).run(utcnow(), message, passId);
        if (!inFlight.length) return;
        db.prepare(
          `UPDATE review_items SET outcome = 'failed', last_error = ?, pass_id = NULL,
                  claimed_from = NULL, updated_at = ?
           WHERE review_run_id = ? AND outcome = 'running'
             AND row_number IN (${inFlight.map(() => '?').join(',')})`,
        ).run(`internal runner error: ${message}`, utcnow(), reviewRunId, ...inFlight);
      });
    },

    async close(): Promise<void> {
      closeOnce(handle);
    },
  };
}

/** Bring a review half written before the library owned it up to version 1. */
const TO_REVIEW_VERSION_1: MigrationStep = {
  to: 1,
  summary: "record passes separately from runs, and move a run's derived inputs into one column",

  refuse(db) {
    // The new schema declares an identifier unique within a run. The old one did
    // not, although a corpus with two rows under one identifier could never have
    // been translated in the first place, so a file that has them is telling you
    // something the migration should not paper over.
    const dupes = db
      .prepare(
        `SELECT review_run_id, identifier, COUNT(*) AS n FROM review_items
         GROUP BY review_run_id, identifier HAVING n > 1 LIMIT 5`,
      )
      .all() as { review_run_id: string; identifier: string; n: number }[];
    if (!dupes.length) return null;
    return (
      'an identifier appears twice in one review run, which the new schema forbids: ' +
      `${dupes.map((d) => `run ${d.review_run_id} identifier ${d.identifier} x${d.n}`).join('; ')}. ` +
      'Inspect the file before migrating it.'
    );
  },

  apply(db) {
    // `review_runs` is rebuilt rather than altered, and it is the only table
    // here that is. Its old shape declares seven hash columns `NOT NULL`, two of
    // which name things the library does not know about (a termbase, a path into
    // the host's work directory), so leaving them in place would mean either
    // freezing a consumer's vocabulary into a published schema or writing rows
    // that violate their own table. Rebuilding copies every value forward: the
    // hashes land in `inputs_json` under the names the run id derives them from.
    // One row per review run, so the copy is small however large the corpus is.
    const columns = new Set(
      (db.prepare('PRAGMA table_info(review_runs)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('inputs_json')) {
      // Dropping a table that `review_items` and `review_attempts` reference is
      // only possible because `migrateRegistry` runs every step with foreign
      // keys off and checks the file once at the end. Nothing here may assume
      // otherwise, and nothing outside a migration step may drop this table.
      db.exec(`
        CREATE TABLE review_runs_migrated (
          review_run_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('initialized','running','completed','failed','interrupted')),
          provider TEXT,
          model TEXT,
          profile TEXT,
          reasoning_effort TEXT,
          options_json TEXT NOT NULL,
          inputs_json TEXT NOT NULL,
          base_review_run_id TEXT REFERENCES review_runs(review_run_id)
        );

        INSERT INTO review_runs_migrated
          SELECT review_run_id, started_at, finished_at, status, provider, model, reviewer_profile,
                 reasoning_effort, options_json,
                 json_object(
                   'prompt', prompt_hash,
                   'schema', response_schema_hash,
                   'terminology', terminology_hash,
                   'analysisInput', corpus_analysis_input_hash,
                   'analysisOutput', corpus_analysis_output_hash,
                   'snapshot', corpus_snapshot_hash
                 ),
                 json_extract(options_json, '$.base_review_run_id')
          FROM review_runs;

        DROP TABLE review_runs;
        ALTER TABLE review_runs_migrated RENAME TO review_runs;
      `);
    }

    // Everything else is additive. A pass is a new concept, so no historical row
    // belongs to one: `pass_id` stays null on the attempts that predate it, which
    // is the truth rather than a gap.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_passes (
        pass_id TEXT PRIMARY KEY,
        review_run_id TEXT NOT NULL REFERENCES review_runs(review_run_id),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','paused_quota','interrupted')),
        model TEXT,
        options_json TEXT NOT NULL
      );
    `);
    const itemColumns = new Set(
      (db.prepare('PRAGMA table_info(review_items)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!itemColumns.has('pass_id')) db.exec('ALTER TABLE review_items ADD COLUMN pass_id TEXT');
    if (!itemColumns.has('updated_at')) {
      // A non-constant default is not allowed in `ALTER TABLE`, so the column
      // arrives nullable and is filled from the best timestamp each row has.
      db.exec('ALTER TABLE review_items ADD COLUMN updated_at TEXT');
      db.exec(
        `UPDATE review_items SET updated_at =
           COALESCE(finished_at, started_at,
                    (SELECT started_at FROM review_runs r WHERE r.review_run_id = review_items.review_run_id))`,
      );
    }
    const attemptColumns = new Set(
      (db.prepare('PRAGMA table_info(review_attempts)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!attemptColumns.has('pass_id'))
      db.exec('ALTER TABLE review_attempts ADD COLUMN pass_id TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_identifier ON review_items(review_run_id, identifier)',
    );
  },
};

/**
 * The review half: `review_runs`, `review_passes`, `review_items`,
 * `review_attempts`, stamped in `schema_versions`.
 *
 * Not in `migrateRegistry`'s default plan list, deliberately. A host who has
 * never called `.review(...)` has no review tables, `isPresent` is false, and
 * their file is not touched. A host who has them passes
 * `{ plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] }`.
 */
/**
 * Remember what a row was before it was claimed. The review half's copy of
 * `TO_VERSION_2` on the translate side, stamped and migrated separately as
 * every schema change here is.
 *
 * Additive, so no `refuse`: there is no existing data a new nullable column can
 * contradict. A row already sitting `running` when this runs has no recorded
 * prior outcome and stays null, so it keeps the old behaviour and is released
 * to `pending` - the truth about it, rather than a fabricated value in the one
 * column this step exists to make trustworthy.
 */
const TO_REVIEW_VERSION_2: MigrationStep = {
  to: 2,
  summary: 'record the outcome each claimed row held before it was claimed',

  apply(db) {
    const columns = db.prepare('PRAGMA table_info(review_items)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'claimed_from')) {
      db.exec('ALTER TABLE review_items ADD COLUMN claimed_from TEXT');
    }
  },
};

export const REVIEW_MIGRATIONS: MigrationPlan = {
  label: 'review',
  target: REVIEW_SCHEMA_VERSION,
  stamp: REVIEW_STAMP,
  isPresent: (db) => tableExists(db, 'review_items'),
  steps: [TO_REVIEW_VERSION_1, TO_REVIEW_VERSION_2],
};
