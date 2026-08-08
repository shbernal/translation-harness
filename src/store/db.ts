// The four things every table in this file needs, wherever those tables live.
//
// They were `sqlite.ts`'s until the review half arrived. `sqlite.ts` builds the
// translate store and hands out `.review(...)`, and `review.ts` builds the review
// store: with these three helpers left where they were, the two modules would
// import each other. A cycle that ESM happens to tolerate is still a cycle, and
// the layering test cannot see it because both files are the same layer.
//
// Nothing here knows what a row means. `parseFields` is the one that looks like
// it does, and does not: it decides what an empty `*_json` column is, which is a
// property of how this file stores JSON and not of translation.

import type { DatabaseSync } from 'node:sqlite';
import type { Fields } from '../job.ts';

/** Second-granular UTC, the format every timestamp column in the file uses. */
export function utcnow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Read a `*_json` column back into fields.
 *
 * Exported because a host running its own tables on this store's connection
 * (which is what `SqliteStore.db` is for) has to read the same columns the
 * registry writes, and reimplementing "empty means no fields" in each of them
 * is how two halves of one database start disagreeing about what a null column
 * means.
 */
export function parseFields(json: string | null): Fields {
  if (!json) return {};
  return JSON.parse(json) as Fields;
}

/**
 * Run `fn` inside a single transaction, committing on success.
 *
 * Exported for the same reason as `parseFields`: a host that has been handed the
 * connection will otherwise reimplement it beside ours, and then a failed write
 * in one half leaves the other half committed.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * One connection and whether it has been closed, shared by every store built on
 * it.
 *
 * The translate store and each review store are separate objects over one file,
 * and every one of them publishes `close()`. Without a shared flag the second
 * close double-closes the handle, and worse, a store whose sibling closed the
 * file would go on preparing statements against it.
 */
export interface DbHandle {
  readonly db: DatabaseSync;
  closed: boolean;
}

/** Close the connection if it is still open. Safe from any store, any number of times. */
export function closeOnce(handle: DbHandle): void {
  if (handle.closed) return;
  handle.closed = true;
  handle.db.close();
}

/**
 * Whether a table exists.
 *
 * Used by callers that all ask the same question for the same reason: a half of
 * the schema is *absent* rather than old, and telling those apart is what keeps
 * a host from being migrated for a feature they never adopted.
 */
export function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Where a version number is kept, so that two halves of one file can be
 * versioned independently.
 *
 * The translate half uses `PRAGMA user_version`, which a file has exactly one
 * of. Anything added later that a host can decline to adopt therefore cannot
 * use it, and must not: a consumer who never uses a feature must never be
 * migrated for it. Making the stamp part of a `MigrationPlan` is what keeps that
 * from becoming a second migration mechanism.
 */
export interface SchemaStamp {
  read(db: DatabaseSync): number;
  write(db: DatabaseSync, version: number): void;
}

/** `PRAGMA user_version`: the translate half's stamp, and one per file. */
export const USER_VERSION_STAMP: SchemaStamp = {
  read: (db) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  write: (db, version) => {
    // `PRAGMA` takes no parameters, so this is interpolated; the guard is what
    // makes that safe rather than the fact that every caller so far is internal.
    if (!Number.isInteger(version))
      throw new Error(`Schema version must be an integer: ${version}`);
    db.exec(`PRAGMA user_version = ${version}`);
  },
};

/** One row per independently versioned half of the file. Created on first write. */
const SCHEMA_VERSIONS_DDL =
  'CREATE TABLE IF NOT EXISTS schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)';

/**
 * A stamp kept in a table, for every half of the file after the first.
 *
 * One table with a row per component rather than a table per component, so a
 * third half is a new row and not a new mechanism. Reading it has to tolerate
 * the table not existing, which is the whole difference between this and
 * `PRAGMA user_version`: a pragma is always readable and answers 0, and a table
 * of your own is not - the first read happens inside the migration planner,
 * before any step could have created it.
 */
export function tableStamp(component: string): SchemaStamp {
  return {
    read: (db) => {
      if (!tableExists(db, 'schema_versions')) return 0;
      const row = db
        .prepare('SELECT version FROM schema_versions WHERE component = ?')
        .get(component) as { version: number } | undefined;
      return row?.version ?? 0;
    },
    write: (db, version) => {
      db.exec(SCHEMA_VERSIONS_DDL);
      db.prepare(
        `INSERT INTO schema_versions (component, version) VALUES (?, ?)
         ON CONFLICT (component) DO UPDATE SET version = excluded.version`,
      ).run(component, version);
    },
  };
}
