// Bringing an existing registry up to the schema this version writes.
//
// Opening a registry stamped with an unrecognised version fails, deliberately:
// running new code against an old file and finding out from the data is the
// failure that refusal prevents. What was missing is the other half - a way to
// fix it - and every host that met the refusal had to write its own.
//
// So it ships here, and it is **explicit**. Nothing on this page runs when you
// open a store. An automatic migration turns a mistyped path into a rewritten
// database, and it takes the one moment where a backup is obviously worth taking
// and hides it inside a constructor.
//
// It takes a **path, not a store**, which is forced rather than chosen: the
// thing that fails is the open, so there is no store to hand in. That also makes
// the natural sequence the right one - ask before opening, so the error names the
// migration instead of surfacing as a library complaint about a number.
//
// Synchronous, although `TranslationStore` is asynchronous. That interface is a
// seam so a registry can live somewhere other than a local file; this is about a
// local file, `node:sqlite` is synchronous, and wrapping it in a promise would
// only misrepresent what it is. A store backed by something else migrates with
// its own host's tooling, not with this.

import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { type SchemaStamp, tableExists, tx, USER_VERSION_STAMP } from './db.ts';
import { SCHEMA_VERSION } from './sqlite.ts';

// A stamp is where a version lives, and a plan says which one it uses. Both live
// in `db.ts` with the connection helpers, because "where a version number is
// kept in this file" is a property of the file and not of migrating it; they are
// re-exported here because a plan is what a reader comes looking for them with.
export { type SchemaStamp, tableStamp, USER_VERSION_STAMP } from './db.ts';

/** One version of one half of the schema, and how to get there from the last. */
export interface MigrationStep {
  /** The version this step produces. Steps run in ascending order of it. */
  readonly to: number;
  /** What it does, in one line. Reaches the result and any error it raises. */
  readonly summary: string;
  /**
   * Refuse rather than guess.
   *
   * Return a reason when the data does not satisfy something the new schema
   * declares, and the migration stops before it has copied or written anything.
   * A step that lets the DDL fail instead reports SQLite's message, which names
   * neither what the constraint meant nor what to do about it.
   */
  refuse?(db: DatabaseSync): string | null;
  apply(db: DatabaseSync): void;
}

/** One independently versioned half of the schema and its ladder of steps. */
export interface MigrationPlan {
  /** Names this half in every message and result. */
  readonly label: string;
  /** The version this library writes. `steps` must be able to reach it. */
  readonly target: number;
  readonly stamp: SchemaStamp;
  /**
   * Whether this half exists in the file at all.
   *
   * An absent half is not an old half: `applySchema` creates it at the current
   * version, so there is nothing to migrate and a stamp of 0 means "not here
   * yet" rather than "written by an older release".
   */
  isPresent(db: DatabaseSync): boolean;
  readonly steps: readonly MigrationStep[];
}

/** One step, either about to run or already run. */
export interface MigrationStepInfo {
  /** The owning plan's `label`. */
  plan: string;
  from: number;
  to: number;
  summary: string;
}

export type MigrationResult =
  /** No file at that path. Nothing was created; that is `sqliteStore`'s job. */
  | { kind: 'absent' }
  /** Every plan already at its target. Idempotent, so this is the second call. */
  | { kind: 'current'; versions: Record<string, number> }
  | {
      kind: 'migrated';
      versions: Record<string, number>;
      applied: MigrationStepInfo[];
      /** Where the file was copied first, or `null` if copying was declined. */
      backup: string | null;
    };

export interface MigrateOptions {
  /**
   * Which halves of the schema to bring forward. Defaults to the translate
   * registry alone, because a half a host has not adopted must not be migrated
   * into their file behind their back.
   */
  plans?: readonly MigrationPlan[];
  /**
   * Where to copy the file before touching it, or `false` to decline the copy.
   *
   * A copy is the default because this runs against work that cost real model
   * calls, and it is one `copyFileSync`. The default name carries the versions
   * it was taken at, so it says what is in it and a later migration cannot
   * overwrite it.
   */
  backup?: string | false;
}

/**
 * Version 1: the schema the library's first release writes.
 *
 * Registries written before the library owned the schema are stamped 0. Both
 * differences are additive - nothing is dropped and no value is rewritten - so a
 * corpus and every finished run come through untouched.
 */
const TO_VERSION_1: MigrationStep = {
  to: 1,
  summary: 'record the run holding each claimed row, and declare attempt numbers unique per row',

  refuse(db) {
    const dupes = db
      .prepare(
        `SELECT row_number, attempt_number, COUNT(*) AS n FROM attempts
         GROUP BY row_number, attempt_number HAVING n > 1 ORDER BY row_number LIMIT 5`,
      )
      .all() as { row_number: number; attempt_number: number; n: number }[];
    if (!dupes.length) return null;
    // The old allocation was `MAX + 1` under a claim, so this should be
    // unreachable. If it has happened the file needs a human, not a retry.
    return (
      'attempt numbers repeat, which the new schema forbids: ' +
      `${dupes.map((d) => `row ${d.row_number} attempt ${d.attempt_number} x${d.n}`).join('; ')}. ` +
      'This should not be reachable; inspect the file before migrating it.'
    );
  },

  apply(db) {
    const columns = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'run_id')) {
      db.exec('ALTER TABLE items ADD COLUMN run_id TEXT');
    }
    // A fresh file gets this as a table-level `UNIQUE (row_number,
    // attempt_number)`, which `ALTER TABLE` cannot add. A unique index is the
    // same guarantee by another spelling, so a migrated file and a new one
    // enforce the same thing and only the schema text differs.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_row_attempt ON attempts(row_number, attempt_number)',
    );
  },
};

/** The translate half: `items`, `runs`, `attempts`, stamped in `user_version`. */
export const REGISTRY_MIGRATIONS: MigrationPlan = {
  label: 'registry',
  target: SCHEMA_VERSION,
  stamp: USER_VERSION_STAMP,
  isPresent: (db) => tableExists(db, 'items'),
  steps: [TO_VERSION_1],
};

interface PlanState {
  plan: MigrationPlan;
  version: number;
  pending: MigrationStepInfo[];
  steps: MigrationStep[];
}

function planFor(db: DatabaseSync, path: string, plan: MigrationPlan): PlanState | null {
  if (!plan.isPresent(db)) return null;
  const version = plan.stamp.read(db);
  if (version === plan.target) return { plan, version, pending: [], steps: [] };
  if (version > plan.target) {
    throw new Error(
      `Registry at ${path} has ${plan.label} schema version ${version}, which is newer than ` +
        `the ${plan.target} this version of translation-harness ` +
        'writes. Upgrade the package rather than migrating the file backwards.',
    );
  }

  const steps = plan.steps.filter((s) => s.to > version && s.to <= plan.target);
  steps.sort((a, b) => a.to - b.to);
  const reached = steps.at(-1)?.to;
  if (reached !== plan.target) {
    throw new Error(
      `Registry at ${path} has ${plan.label} schema version ${version} and this version of ` +
        `translation-harness writes ${plan.target}, but no migration reaches it` +
        `${reached === undefined ? '' : ` (the steps available stop at ${reached})`}. ` +
        'Point at a new registry.',
    );
  }

  let from = version;
  const pending: MigrationStepInfo[] = [];
  for (const step of steps) {
    pending.push({ plan: plan.label, from, to: step.to, summary: step.summary });
    from = step.to;
  }
  return { plan, version, pending, steps };
}

function inspect(path: string, options: MigrateOptions): PlanState[] {
  const plans = options.plans ?? [REGISTRY_MIGRATIONS];
  const db = new DatabaseSync(path);
  try {
    return plans.map((plan) => planFor(db, path, plan)).filter((s): s is PlanState => s !== null);
  } finally {
    db.close();
  }
}

function versionsOf(states: readonly PlanState[]): Record<string, number> {
  return Object.fromEntries(states.map((s) => [s.plan.label, s.plan.target]));
}

/**
 * The steps `migrateRegistry` would run, in order, without running them.
 *
 * Useful in its own right - a host can say what is about to happen to a file
 * before it happens - and it is what `registryNeedsMigration` is asking.
 */
export function pendingMigrations(path: string, options: MigrateOptions = {}): MigrationStepInfo[] {
  if (!existsSync(path)) return [];
  return inspect(path, options).flatMap((state) => state.pending);
}

/**
 * Whether a registry is stamped with a version this library will refuse to open.
 *
 * Ask this *before* opening, so the failure names the migration and the command
 * that runs it rather than arriving as an error about two numbers. A path that
 * does not exist yet needs no migration: `sqliteStore` creates it at the current
 * version.
 */
export function registryNeedsMigration(path: string, options: MigrateOptions = {}): boolean {
  return pendingMigrations(path, options).length > 0;
}

/**
 * Bring an existing registry up to the schema this version writes.
 *
 * Idempotent: a second call reports `current`. It is not concurrency-safe and is
 * not meant to be - migrate a file when nothing is running against it, which for
 * a registry whose whole purpose is resuming means between passes.
 *
 * The order is deliberate. Every step's `refuse` hook runs first, across every
 * plan, so a file that cannot be migrated is left exactly as it was and no
 * backup is taken for a migration that never happens. Then the write-ahead log
 * is folded back in, so the copy taken next is the whole registry rather than a
 * prefix of it. Then each step applies inside its own transaction and stamps its
 * own version, so an interruption leaves a file at a version some step produced
 * rather than at a version nothing describes.
 */
export function migrateRegistry(path: string, options: MigrateOptions = {}): MigrationResult {
  if (!existsSync(path)) return { kind: 'absent' };

  const states = inspect(path, options);
  const applied = states.flatMap((state) => state.pending);
  if (!applied.length) {
    return {
      kind: 'current',
      versions: Object.fromEntries(states.map((s) => [s.plan.label, s.version])),
    };
  }

  const refusals: string[] = [];
  const inspectDb = new DatabaseSync(path);
  try {
    for (const state of states) {
      for (const step of state.steps) {
        const reason = step.refuse?.(inspectDb);
        if (reason) refusals.push(`${state.plan.label} version ${step.to}: ${reason}`);
      }
    }
    if (refusals.length) {
      throw new Error(`Registry at ${path} cannot be migrated. ${refusals.join(' ')}`);
    }
    inspectDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    inspectDb.close();
  }

  const backup =
    options.backup === false
      ? null
      : (options.backup ??
        `${path}.v${states
          .filter((s) => s.pending.length)
          .map((s) => s.version)
          .join('-')}.bak`);
  if (backup !== null) copyFileSync(path, backup);

  // Foreign keys are **off** for the whole of the migration, which is not a
  // shortcut: a step that has to change a table's declaration rebuilds it (make
  // the new one, copy, drop the old, rename), and dropping a table two others
  // reference cannot be done with the constraints live. `PRAGMA foreign_keys` is
  // a no-op inside a transaction and `defer_foreign_keys` does not help, because
  // the violations a drop counts are never re-checked after the rename puts the
  // table back. So the constraints come off here and the file is checked once at
  // the end, which is the sequence SQLite's own rebuild procedure prescribes.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    for (const state of states) {
      for (const step of state.steps) {
        tx(db, () => {
          step.apply(db);
          state.plan.stamp.write(db, step.to);
        });
      }
    }

    const broken = db.prepare('PRAGMA foreign_key_check').all() as { table: string }[];
    if (broken.length) {
      const tables = [...new Set(broken.map((row) => row.table))].join(', ');
      throw new Error(
        `Registry at ${path} has ${broken.length} broken foreign key reference(s) after ` +
          `migrating (${tables}). The steps have been applied and stamped, so fix the file or ` +
          `restore it${backup === null ? '' : ` from ${backup}`}; this is a defect in a ` +
          'migration step, not something a retry resolves.',
      );
    }
  } finally {
    db.close();
  }

  return { kind: 'migrated', versions: versionsOf(states), applied, backup };
}
