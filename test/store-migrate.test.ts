// Migration, against a registry actually written by the old schema.
//
// The DDL below is the pre-library one, copied rather than derived: it is what
// files in the wild contain, and generating it from the current schema minus a
// column would test the generator instead of the migration. The proof a step
// worked is not that it ran, it is that `sqliteStore` opens the file afterwards
// and the rows are still there.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  type MigrationPlan,
  migrateRegistry,
  pendingMigrations,
  registryNeedsMigration,
  USER_VERSION_STAMP,
} from '../src/store/migrate.ts';
import { sqliteStore } from '../src/store/sqlite.ts';

const SCHEMA_V0 = `
CREATE TABLE items (
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
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  model TEXT,
  options_json TEXT NOT NULL
);

CREATE TABLE attempts (
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
  stderr_path TEXT
);
`;

interface V0Options {
  /** Insert a second attempt reusing an attempt number the first already took. */
  duplicateAttempt?: boolean;
}

/** A version-0 registry with one finished row and one attempt behind it. */
function writeV0Registry(path: string, options: V0Options = {}): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA_V0);
    db.prepare(
      `INSERT INTO items (row_number, identifier, source_json, input_hash, status, target_json, updated_at)
       VALUES (1, 'row-1', '{"name":"Source 1"}', 'h1', 'succeeded', '{"name":"Cible 1"}', '2026-01-01T00:00:00Z'),
              (2, 'row-2', '{"name":"Source 2"}', 'h2', 'pending', NULL, '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      "INSERT INTO runs VALUES ('old-run', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'completed', 'gpt-old', '{}')",
    ).run();
    db.prepare(
      `INSERT INTO attempts (run_id, row_number, attempt_number, started_at, outcome)
       VALUES ('old-run', 1, 1, '2026-01-01T00:00:30Z', 'succeeded')`,
    ).run();
    if (options.duplicateAttempt) {
      db.prepare(
        `INSERT INTO attempts (run_id, row_number, attempt_number, started_at, outcome)
         VALUES ('old-run', 1, 1, '2026-01-01T00:00:40Z', 'failed')`,
      ).run();
    }
    // The whole point of a version 0 file: nothing stamped it.
    db.exec('PRAGMA user_version = 0');
  } finally {
    db.close();
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'harness-migrate-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return USER_VERSION_STAMP.read(db);
  } finally {
    db.close();
  }
}

describe('registryNeedsMigration', () => {
  test('a path that does not exist yet needs nothing', () => {
    withTempDir((dir) => {
      assert.equal(registryNeedsMigration(join(dir, 'absent.sqlite')), false);
      assert.deepEqual(pendingMigrations(join(dir, 'absent.sqlite')), []);
    });
  });

  test('a registry this library wrote needs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-migrate-'));
    const path = join(dir, 'current.sqlite');
    const store = sqliteStore(path);
    await store.close();
    try {
      assert.equal(registryNeedsMigration(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a version 0 registry needs one step, and says which', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      assert.equal(registryNeedsMigration(path), true);

      const pending = pendingMigrations(path);
      assert.equal(pending.length, 1);
      assert.deepEqual(
        { plan: pending[0]?.plan, from: pending[0]?.from, to: pending[0]?.to },
        { plan: 'registry', from: 0, to: 1 },
      );
      assert.match(pending[0]?.summary ?? '', /attempt numbers unique/);
      assert.equal(userVersion(path), 0, 'asking must not have changed anything');
    });
  });
});

describe('migrateRegistry', () => {
  test('the version this library writes cannot be opened before it is migrated', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);

      // The refusal is the reason this function exists, so assert it here rather
      // than trusting it from elsewhere.
      assert.throws(() => sqliteStore(path), /schema version 0.*writes version 1/s);
      migrateRegistry(path);

      const store = sqliteStore(path);
      try {
        assert.equal(userVersion(path), 1);
      } finally {
        void store.close();
      }
    });
  });

  test('the corpus and its history come through untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-migrate-'));
    const path = join(dir, 'old.sqlite');
    writeV0Registry(path);
    const result = migrateRegistry(path);
    assert.equal(result.kind, 'migrated');

    const store = sqliteStore(path);
    try {
      assert.deepEqual(await store.counts(), {
        pending: 1,
        running: 0,
        succeeded: 1,
        review_required: 0,
        failed: 0,
      });
      const targets = await store.translationsByIdentifier();
      assert.deepEqual(targets.get('row-1'), { name: 'Cible 1' });

      const attempts = store.db.prepare('SELECT run_id, attempt_number FROM attempts').all() as {
        run_id: string;
        attempt_number: number;
      }[];
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.run_id, 'old-run');
      assert.equal(attempts[0]?.attempt_number, 1);

      // The column the step added, and the thing it is for: a claim that records
      // the run holding it.
      const claimed = await store.tryClaim(2, 'new-run');
      assert.equal(claimed?.identifier, 'row-2');
      const held = store.db.prepare('SELECT run_id FROM items WHERE row_number = 2').get() as {
        run_id: string;
      };
      assert.equal(held.run_id, 'new-run');
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the uniqueness the step declares is enforced afterwards', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      migrateRegistry(path);

      const db = new DatabaseSync(path);
      try {
        assert.throws(
          () =>
            db
              .prepare(
                `INSERT INTO attempts (run_id, row_number, attempt_number, started_at)
                 VALUES ('old-run', 1, 1, '2026-01-02T00:00:00Z')`,
              )
              .run(),
          /UNIQUE/i,
        );
      } finally {
        db.close();
      }
    });
  });

  test('a copy is kept, named for the version it was taken at', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      const result = migrateRegistry(path);
      assert.equal(result.kind === 'migrated' && result.backup, `${path}.v0.bak`);
      assert.ok(existsSync(`${path}.v0.bak`));
      assert.equal(userVersion(`${path}.v0.bak`), 0, 'the copy is the file as it was');
    });
  });

  test('a second call is a no-op that says so', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      migrateRegistry(path);
      const again = migrateRegistry(path);
      assert.deepEqual(again, { kind: 'current', versions: { registry: 1 } });
    });
  });

  test('an absent file is reported, not created', () => {
    withTempDir((dir) => {
      const path = join(dir, 'absent.sqlite');
      assert.deepEqual(migrateRegistry(path), { kind: 'absent' });
      assert.equal(existsSync(path), false);
    });
  });

  test('data the new schema forbids refuses, before anything is copied or written', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path, { duplicateAttempt: true });

      assert.throws(() => migrateRegistry(path), /attempt numbers repeat.*row 1 attempt 1 x2/s);
      assert.equal(userVersion(path), 0, 'the file must be exactly as it was');
      assert.equal(
        existsSync(`${path}.v0.bak`),
        false,
        'and no copy taken for a migration that did not happen',
      );
    });
  });

  test('a stamp newer than this library writes is refused rather than downgraded', () => {
    withTempDir((dir) => {
      const path = join(dir, 'future.sqlite');
      writeV0Registry(path);
      const db = new DatabaseSync(path);
      db.exec('PRAGMA user_version = 99');
      db.close();

      assert.throws(() => migrateRegistry(path), /newer than the 1.*Upgrade the package/s);
    });
  });

  test('a plan whose steps cannot reach its target refuses rather than half-migrating', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      const unreachable: MigrationPlan = {
        label: 'registry',
        target: 7,
        stamp: USER_VERSION_STAMP,
        isPresent: () => true,
        steps: [],
      };
      assert.throws(
        () => migrateRegistry(path, { plans: [unreachable] }),
        /no migration reaches it/,
      );
      assert.equal(userVersion(path), 0);
    });
  });
});

// The second half of the schema does not exist yet, so the mechanism is what is
// tested here rather than the review tables: a plan is data, and the next
// independently versioned half of the file is another entry rather than another
// mechanism. Step-for-step this is what the review stamp will do.
describe('a second, independently versioned half of one file', () => {
  const stampTable = `CREATE TABLE IF NOT EXISTS extra_schema (version INTEGER NOT NULL)`;

  const EXTRA: MigrationPlan = {
    label: 'extra',
    target: 1,
    stamp: {
      // Reading has to tolerate the stamp table not existing yet, which is the
      // whole difference between this and `PRAGMA user_version`: a pragma is
      // always readable and answers 0, a table of your own is not.
      read: (db) => {
        const present =
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra_schema'",
            )
            .get() !== undefined;
        if (!present) return 0;
        return (
          (db.prepare('SELECT version FROM extra_schema').get() as { version: number } | undefined)
            ?.version ?? 0
        );
      },
      write: (db, version) => {
        db.exec(stampTable);
        db.prepare('DELETE FROM extra_schema').run();
        db.prepare('INSERT INTO extra_schema VALUES (?)').run(version);
      },
    },
    isPresent: (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra'").get() !==
      undefined,
    steps: [
      {
        to: 1,
        summary: 'give the extra table a note column',
        apply: (db) => db.exec('ALTER TABLE extra ADD COLUMN note TEXT'),
      },
    ],
  };

  test('a half the host has not adopted is not migrated into their file', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      // `extra` is absent, so the plan has nothing to do and must not report a
      // version for something that is not there.
      const result = migrateRegistry(path, { plans: [EXTRA] });
      assert.deepEqual(result, { kind: 'current', versions: {} });
      assert.equal(existsSync(`${path}.v.bak`), false);
    });
  });

  test('two halves migrate together, each stamped where it keeps its own version', () => {
    withTempDir((dir) => {
      const path = join(dir, 'old.sqlite');
      writeV0Registry(path);
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE extra (a INTEGER)');
      db.close();

      const result = migrateRegistry(path, {
        plans: [
          {
            label: 'registry',
            target: 1,
            stamp: USER_VERSION_STAMP,
            isPresent: () => true,
            steps: [
              {
                to: 1,
                summary: 'the registry step',
                apply: (d) => d.exec('ALTER TABLE items ADD COLUMN run_id TEXT'),
              },
            ],
          },
          EXTRA,
        ],
        backup: false,
      });

      assert.equal(result.kind, 'migrated');
      assert.deepEqual(result.kind === 'migrated' && result.versions, { registry: 1, extra: 1 });
      assert.deepEqual(
        result.kind === 'migrated' && result.applied.map((s) => `${s.plan} ${s.from}->${s.to}`),
        ['registry 0->1', 'extra 0->1'],
      );

      assert.equal(userVersion(path), 1);
      const check = new DatabaseSync(path);
      try {
        const stamped = check.prepare('SELECT version FROM extra_schema').get() as {
          version: number;
        };
        assert.equal(stamped.version, 1);
        const columns = check.prepare('PRAGMA table_info(extra)').all() as { name: string }[];
        assert.ok(columns.some((c) => c.name === 'note'));
      } finally {
        check.close();
      }
    });
  });
});
