// The one shipped `TranslationStore`, on the built-in `node:sqlite`.
//
// All the SQL lives here and nothing above this file names a database. Each
// method wraps a synchronous transaction and returns an already-resolved
// promise: there is no `await` inside any of them, so the atomicity the async
// interface merely *states* is, in this implementation, true by construction.

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TransientFailure } from '../errors.ts';
import type { Fields } from '../job.ts';
import { closeOnce, type DbHandle, parseFields, tableExists, tx, utcnow } from './db.ts';
import { reviewStore } from './review.ts';
import type { ReviewStore } from './review-types.ts';
import type {
  AttemptPaths,
  AttemptStart,
  CandidateFilter,
  CommitArgs,
  FailArgs,
  Item,
  PrecomputedCommitArgs,
  RunRecord,
  RunStatus,
  StartedAttempt,
  Status,
  StoreRecord,
  SyncResult,
  TranslationStore,
} from './types.ts';
import { STATUSES } from './types.ts';

/**
 * Stamped into `PRAGMA user_version` by `applySchema` and checked on open.
 *
 * The library owns the schema, so from the first release onward a schema change
 * meets registries with real rows in them. `initialize`'s guard covers corpus
 * drift, not schema drift; the stamp is what covers schema drift.
 *
 * Refusing to open an unrecognised stamp is the default and stays the default -
 * running new code against an old registry and finding out from the data is the
 * failure it prevents. `migrateRegistry` in `migrate.ts` is the other half, and
 * it is invoked by the host rather than by the open.
 */
export const SCHEMA_VERSION = 1;

/** `items.model` for a row the caller answered without a provider. */
export const PRECOMPUTED_MODEL_LABEL = 'precomputed';

// Re-exported from where they now live, so `translation-harness`'s three
// database helpers keep the one import path a consumer already has.
export { parseFields, tx, utcnow } from './db.ts';

function parseList(json: string | null): string[] | null {
  if (!json) return null;
  return JSON.parse(json) as string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  row_number INTEGER PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  source_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','review_required','failed')),
  target_json TEXT,
  warnings_json TEXT,
  review_reasons_json TEXT,
  prompt_hash TEXT,
  model TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  model TEXT,
  options_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  row_number INTEGER NOT NULL REFERENCES items(row_number),
  attempt_number INTEGER NOT NULL,
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
  UNIQUE (row_number, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_items_status_row ON items(status, row_number);
CREATE INDEX IF NOT EXISTS idx_attempts_row ON attempts(row_number, attempt_number);
`;

/**
 * Create the tables if they are absent and stamp the schema version.
 *
 * Exported because a host may want extra tables of its own on the same
 * connection, which is exactly what `sqliteStore(...).db` is for.
 */
export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Foreign keys are off by default in SQLite, so the attempts-to-runs
  // reference would be decoration without this.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL so a reader (a status command, another process) is not blocked by the
  // run's writes, and FULL so a row that reports committed has actually reached
  // the disk. A batch that spends a subprocess per row can afford the fsync;
  // what it cannot afford is re-translating an hour of work after a power cut.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  const hasItems = tableExists(db, 'items');

  if (version === SCHEMA_VERSION || (version === 0 && !hasItems)) {
    applySchema(db);
    return db;
  }
  db.close();
  throw new Error(
    `Registry at ${path} has schema version ${version}, but this version of ` +
      `translation-harness writes version ${SCHEMA_VERSION}. Refusing to open it: ` +
      'run `migrateRegistry(path)` first, or point at a new one. Ask ' +
      '`registryNeedsMigration(path)` before opening and you get this as a question ' +
      'rather than as a failure.',
  );
}

interface ItemRow {
  row_number: number;
  identifier: string;
  source_json: string;
  input_hash: string;
  status: Status;
  target_json: string | null;
  warnings_json: string | null;
  review_reasons_json: string | null;
  prompt_hash: string | null;
  model: string | null;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
}

function toItem(row: ItemRow): Item {
  return {
    rowNumber: row.row_number,
    identifier: row.identifier,
    source: parseFields(row.source_json),
    inputHash: row.input_hash,
    status: row.status,
    target: row.target_json === null ? null : parseFields(row.target_json),
    warnings: parseList(row.warnings_json),
    reviewReasons: parseList(row.review_reasons_json),
    promptHash: row.prompt_hash,
    model: row.model,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export interface SqliteStoreOptions {
  /**
   * Record attempt paths relative to this directory rather than absolutely.
   *
   * Absolute paths in a registry make it non-portable and leak the machine it
   * ran on into a file somebody may well commit. The runner always hands
   * absolute paths (contract term 5); what to do with them is this store's
   * decision, and this is where it is made.
   */
  pathBase?: string;
}

/** The SQLite store, plus the handle, which the interface deliberately lacks. */
export interface SqliteStore extends TranslationStore {
  /**
   * The live connection.
   *
   * Exposed on the concrete type only, never on `TranslationStore`, because the
   * interface has to stay implementable by something with no such handle to
   * give. It is here so a host can run its own DDL on the same connection and
   * keep its tables in the same transactional world as the registry.
   */
  readonly db: DatabaseSync;

  /**
   * The review half of this registry, scoped to one review run.
   *
   * Calling this is how a host **opts in** to the review tables: they are
   * created on the first call and never by opening a registry, so a consumer who
   * only ever translates has a file the review migration will not touch
   * (`REVIEW_MIGRATIONS.isPresent` is false for it). The run need not exist yet -
   * this is a scope, not a lookup, and `createRun` is what creates it.
   *
   * The returned store shares this connection, so a review run and the corpus it
   * reviews are in one transactional world by construction rather than by a host
   * wiring two databases together. It also shares the close: closing either one
   * closes the file, once.
   */
  review(reviewRunId: string): ReviewStore;
}

/**
 * Open (or create) a registry at `path`. Use `':memory:'` for tests.
 *
 * Requires Node 24 or newer, and requires it at *typecheck* time as well as at
 * runtime: this module's types name `node:sqlite`, so a consumer without Node
 * 24 typings cannot compile against the package even if they never touch this
 * store.
 */
export function sqliteStore(path: string, options: SqliteStoreOptions = {}): SqliteStore {
  const db = openDatabase(path);
  const base = options.pathBase;
  const rel = (p: string): string => (base && isAbsolute(p) ? relative(base, p) : p);
  // Shared with every review store handed out below, so that whichever of them
  // is closed first closes the file, and the rest are no-ops rather than errors.
  const handle: DbHandle = { db, closed: false };

  return {
    db,

    review(reviewRunId: string): ReviewStore {
      return reviewStore(handle, reviewRunId, { pathBase: base });
    },

    async initialize(records: readonly StoreRecord[]): Promise<SyncResult> {
      const now = utcnow();
      let inserted = 0;
      let reset = 0;

      tx(db, () => {
        const existing = db.prepare('SELECT input_hash FROM items WHERE row_number = ?');
        const insert = db.prepare(
          `INSERT INTO items (row_number, identifier, source_json, input_hash, status, target_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const resetStmt = db.prepare(
          `UPDATE items SET identifier = ?, source_json = ?, input_hash = ?, status = 'pending',
             target_json = NULL, warnings_json = NULL, review_reasons_json = NULL, prompt_hash = NULL,
             model = NULL, attempt_count = 0, run_id = NULL, last_error = 'source input changed', updated_at = ?
           WHERE row_number = ?`,
        );

        for (const record of records) {
          const prior = existing.get(record.rowNumber) as { input_hash: string } | undefined;
          const sourceJson = JSON.stringify(record.source);
          if (!prior) {
            const status: Status = record.seedSucceeded ? 'succeeded' : 'pending';
            const targetJson = record.target ? JSON.stringify(record.target) : null;
            insert.run(
              record.rowNumber,
              record.identifier,
              sourceJson,
              record.inputHash,
              status,
              targetJson,
              now,
            );
            inserted++;
          } else if (prior.input_hash !== record.inputHash) {
            resetStmt.run(record.identifier, sourceJson, record.inputHash, now, record.rowNumber);
            reset++;
          }
        }

        // Contract term 6. A registry row the caller no longer supplies means
        // the corpus changed under a run's feet, and carrying on would orphan
        // finished work with nothing anywhere to say so.
        const expected = new Set(records.map((r) => r.rowNumber));
        const held = db.prepare('SELECT row_number FROM items').all() as { row_number: number }[];
        for (const row of held) {
          if (!expected.has(row.row_number)) {
            throw new Error('Registry contains rows absent from the supplied records');
          }
        }
      });

      return { inserted, reset };
    },

    async counts(): Promise<Record<Status, number>> {
      const values = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
      const rows = db
        .prepare('SELECT status, COUNT(*) AS count FROM items GROUP BY status')
        .all() as { status: Status; count: number }[];
      for (const row of rows) values[row.status] = row.count;
      return values;
    },

    async items(): Promise<Item[]> {
      // No WHERE at all, which is the point: term 9 excludes nothing, `running`
      // included. `toItem` is what keeps the other half of the term - it maps a
      // NULL `target_json` to `null` rather than to `{}`, and those two hash
      // differently in a review snapshot.
      const rows = db
        .prepare('SELECT * FROM items ORDER BY row_number')
        .all() as unknown as ItemRow[];
      return rows.map(toItem);
    },

    async selectCandidates(filter: CandidateFilter): Promise<Item[]> {
      // `running` is never a candidate whatever the filter says: a live pass
      // owns those rows, and `tryClaim` refuses them anyway.
      const statuses: Status[] = filter.redo
        ? ['pending', 'failed', 'review_required', 'succeeded']
        : ['pending'];
      if (filter.retryFailed && !filter.redo) statuses.push('failed');
      if (filter.includeReview && !filter.redo) statuses.push('review_required');
      const where = [`status IN (${statuses.map(() => '?').join(',')})`];
      const params: (string | number)[] = [...statuses];
      if (filter.identifiers?.length) {
        where.push(`identifier IN (${filter.identifiers.map(() => '?').join(',')})`);
        params.push(...filter.identifiers);
      }
      let sql = `SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY row_number`;
      if (filter.limit != null) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
      }
      const rows = db.prepare(sql).all(...params) as unknown as ItemRow[];
      if (filter.identifiers?.length) {
        const found = new Set(rows.map((r) => r.identifier));
        const missing = filter.identifiers.filter((id) => !found.has(id));
        if (missing.length)
          throw new Error(`Requested identifiers not eligible or not found: ${missing.join(', ')}`);
      }
      return rows.map(toItem);
    },

    /**
     * Contract term 2, and the reason it holds here.
     *
     * The `AND status != 'running'` is the whole point: the UPDATE and the test
     * are one statement, so two workers, or two processes against the same
     * file, cannot both come away believing they own the row. An unconditional
     * claim would let both translate it, both write an answer, and the second
     * silently overwrite the first.
     */
    async tryClaim(rowNumber: number, runId: string): Promise<Item | null> {
      const changed = tx(db, () => {
        const cursor = db
          .prepare(
            `UPDATE items SET status = 'running', run_id = ?, updated_at = ?
             WHERE row_number = ? AND status != 'running'`,
          )
          .run(runId, utcnow(), rowNumber);
        return cursor.changes;
      });
      if (changed !== 1) return null;
      const row = db
        .prepare('SELECT * FROM items WHERE row_number = ?')
        .get(rowNumber) as unknown as ItemRow;
      return toItem(row);
    },

    /**
     * A run's final sweep: whatever path it took out, it must not leave a row
     * it claimed still claimed. A stranded `running` row is invisible to every
     * selection filter (`selectCandidates` excludes it deliberately), so a
     * resume silently skips it until `reclaimStale`'s cutoff passes. That is a
     * corpus with a hole in it and no error anywhere to say so.
     */
    async unclaim(rowNumbers: readonly number[]): Promise<number> {
      if (!rowNumbers.length) return 0;
      return tx(db, () => {
        const cursor = db
          .prepare(
            `UPDATE items SET status = 'pending', run_id = NULL, updated_at = ?
             WHERE status = 'running' AND row_number IN (${rowNumbers.map(() => '?').join(',')})`,
          )
          .run(utcnow(), ...rowNumbers);
        return cursor.changes as number;
      });
    },

    /**
     * The cutoff is inclusive (`<=`, not `<`).
     *
     * Timestamps here are second-granular, so a strict comparison makes
     * `reclaimStale(0)` a no-op against rows claimed in the current second: it
     * cannot express "release everything now", which is both the obvious
     * reading of a zero cutoff and the only version of this that a test can
     * assert without sleeping. At the default 30 minutes the difference is one
     * second at the boundary.
     */
    async reclaimStale(ageMinutes = 30): Promise<number> {
      const cutoff = new Date(Date.now() - ageMinutes * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      return tx(db, () => {
        db.prepare(
          `UPDATE attempts SET finished_at = ?, outcome = 'failed', error_category = 'abandoned',
             error_message = 'runner ended before recording the attempt result'
           WHERE outcome IS NULL AND run_id IN (SELECT run_id FROM runs WHERE status != 'running' OR started_at <= ?)`,
        ).run(utcnow(), cutoff);
        db.prepare(
          `UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND started_at <= ?`,
        ).run(utcnow(), cutoff);
        const cursor = db
          .prepare(
            `UPDATE items SET status = 'pending', run_id = NULL, last_error = 'reclaimed stale running item', updated_at = ?
             WHERE status = 'running' AND updated_at <= ?`,
          )
          .run(utcnow(), cutoff);
        return cursor.changes as number;
      });
    },

    /**
     * The clock-free half of `reclaimStale`, and it reads the run rather than
     * the timestamp: `run_id IN (SELECT ... WHERE status != 'running')` is the
     * whole test. `finishRun` runs after every worker has returned, so a run
     * with a settled status owns nothing, and the same condition already
     * governs which dangling attempts `reclaimStale` closes.
     *
     * `run_id IS NOT NULL` is not redundant with the subquery - it says out
     * loud that a row claimed before the column existed is deliberately left
     * for the cutoff, because there is no run to ask about it.
     */
    async releaseSettledRunClaims(): Promise<number> {
      return tx(db, () => {
        db.prepare(
          `UPDATE attempts SET finished_at = ?, outcome = 'failed', error_category = 'abandoned',
             error_message = 'runner ended before recording the attempt result'
           WHERE outcome IS NULL AND run_id IN (SELECT run_id FROM runs WHERE status != 'running')`,
        ).run(utcnow());
        const cursor = db
          .prepare(
            `UPDATE items SET status = 'pending', run_id = NULL,
                    last_error = 'released: the run holding this row had already ended', updated_at = ?
             WHERE status = 'running' AND run_id IS NOT NULL
               AND run_id IN (SELECT run_id FROM runs WHERE status != 'running')`,
          )
          .run(utcnow());
        return cursor.changes as number;
      });
    },

    async translationsByIdentifier(): Promise<Map<string, Fields>> {
      const rows = db
        .prepare('SELECT identifier, target_json FROM items WHERE target_json IS NOT NULL')
        .all() as { identifier: string; target_json: string }[];
      return new Map(rows.map((r) => [r.identifier, parseFields(r.target_json)]));
    },

    async startRun(run: RunRecord): Promise<void> {
      tx(db, () =>
        db
          .prepare("INSERT INTO runs VALUES (?, ?, NULL, 'running', ?, ?)")
          .run(run.runId, utcnow(), run.model, JSON.stringify(run.options)),
      );
    },

    async finishRun(runId: string, status: RunStatus): Promise<void> {
      tx(db, () =>
        db
          .prepare('UPDATE runs SET finished_at = ?, status = ? WHERE run_id = ?')
          .run(utcnow(), status, runId),
      );
    },

    async startAttempt(attempt: AttemptStart): Promise<StartedAttempt> {
      return tx(db, () => {
        const next = db
          .prepare(
            'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM attempts WHERE row_number = ?',
          )
          .get(attempt.rowNumber) as { n: number };
        const cursor = db
          .prepare(
            `INSERT INTO attempts (run_id, row_number, attempt_number, started_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(attempt.runId, attempt.rowNumber, next.n, utcnow());
        return { attemptId: Number(cursor.lastInsertRowid), attemptNumber: next.n };
      });
    },

    async setAttemptPaths(attemptId: number, paths: AttemptPaths): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            'UPDATE attempts SET response_path = ?, stdout_path = ?, stderr_path = ? WHERE attempt_id = ?',
          )
          .run(rel(paths.responsePath), rel(paths.stdoutPath), rel(paths.stderrPath), attemptId),
      );
    },

    async commitSuccess(a: CommitArgs): Promise<void> {
      tx(db, () => {
        db.prepare(
          'UPDATE attempts SET finished_at = ?, duration_seconds = ?, outcome = ?, exit_code = ? WHERE attempt_id = ?',
        ).run(utcnow(), a.duration, a.outcome, a.exitCode, a.attemptId);
        db.prepare(
          `UPDATE items SET status = ?, target_json = ?, warnings_json = ?, review_reasons_json = ?,
             prompt_hash = ?, model = ?, attempt_count = ?, last_error = NULL, run_id = NULL, updated_at = ?
           WHERE row_number = ?`,
        ).run(
          a.outcome,
          JSON.stringify(a.translations),
          JSON.stringify(a.warnings),
          JSON.stringify(a.reviewReasons),
          a.promptHash,
          a.modelLabel,
          a.attemptNumber,
          utcnow(),
          a.rowNumber,
        );
      });
    },

    /**
     * Same single-row transaction as a model answer, so resume semantics are
     * unchanged. `attempt_count` stays 0 because no attempt ran: `attempts`
     * means "one subprocess invocation with its retained output", and a
     * synthetic entry with empty logs would misreport that. The model label is
     * what makes such a row auditable after the fact.
     */
    async commitPrecomputed(a: PrecomputedCommitArgs): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE items SET status = ?, target_json = ?, warnings_json = ?, review_reasons_json = ?,
               prompt_hash = ?, model = ?, last_error = NULL, run_id = NULL, updated_at = ?
             WHERE row_number = ?`,
          )
          .run(
            a.outcome,
            JSON.stringify(a.translations),
            JSON.stringify(a.warnings),
            JSON.stringify(a.reviewReasons),
            a.promptHash,
            PRECOMPUTED_MODEL_LABEL,
            utcnow(),
            a.rowNumber,
          ),
      );
    },

    async failAttempt(attemptId: number, error: TransientFailure): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE attempts SET finished_at = ?, outcome = 'failed', exit_code = ?, error_category = ?, error_message = ?
             WHERE attempt_id = ?`,
          )
          .run(utcnow(), error.exitCode, error.category, error.message.slice(-2000), attemptId),
      );
    },

    async markItemFailed(a: FailArgs): Promise<void> {
      tx(db, () =>
        db
          .prepare(
            `UPDATE items SET status = 'failed', attempt_count = ?, last_error = ?, prompt_hash = ?,
               model = ?, run_id = NULL, updated_at = ?
             WHERE row_number = ?`,
          )
          .run(a.attemptCount, a.lastError, a.promptHash, a.modelLabel, utcnow(), a.rowNumber),
      );
    },

    async recordInternalError(
      runId: string,
      error: unknown,
      inFlight: readonly number[],
    ): Promise<void> {
      const message = `${error instanceof Error ? error.name : 'Error'}: ${String(error)}`.slice(
        -2000,
      );
      tx(db, () => {
        db.prepare(
          `UPDATE attempts SET finished_at = ?, outcome = 'failed', error_category = 'internal_error', error_message = ?
           WHERE run_id = ? AND outcome IS NULL`,
        ).run(utcnow(), message, runId);
        if (!inFlight.length) return;
        db.prepare(
          `UPDATE items SET status = 'failed', last_error = ?, updated_at = ?
           WHERE status = 'running' AND row_number IN (${inFlight.map(() => '?').join(',')})`,
        ).run(`internal runner error: ${message}`, utcnow(), ...inFlight);
      });
    },

    async close(): Promise<void> {
      closeOnce(handle);
    },
  };
}
