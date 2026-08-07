// The escape hatch: a host keeping its own tables on the registry's connection.
//
// This is what the SQLite store exposes that the interface deliberately does
// not, and it is exported because the alternative is a host reimplementing
// `tx` and `parseFields` beside ours, at which point the two halves of one
// database can disagree about what a null column means and about what a
// transaction covers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sampleRecords } from '../src/store/conformance.ts';
import { parseFields, sqliteStore, tx } from '../src/store/sqlite.ts';

describe('parseFields', () => {
  test('a null or empty column is no fields, not a crash', () => {
    assert.deepEqual(parseFields(null), {});
    assert.deepEqual(parseFields(''), {});
  });

  test('round-trips what the registry writes', () => {
    const fields = { name: 'Politique', note: null };
    assert.deepEqual(parseFields(JSON.stringify(fields)), fields);
  });
});

describe('the shared connection', () => {
  test('a host can create its own tables and read the registry alongside them', async () => {
    const store = sqliteStore(':memory:');
    try {
      await store.initialize(sampleRecords(3));

      // Exactly what the private consumer this was extracted from does: its own
      // DDL, on the same connection, after the library's schema.
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS review_items (
          row_number INTEGER PRIMARY KEY,
          verdict TEXT NOT NULL
        )`);

      tx(store.db, () => {
        store.db.prepare('INSERT INTO review_items VALUES (?, ?)').run(1, 'pass');
      });

      const joined = store.db
        .prepare(
          `SELECT i.identifier, i.source_json, r.verdict
           FROM items i JOIN review_items r ON r.row_number = i.row_number`,
        )
        .all() as { identifier: string; source_json: string; verdict: string }[];

      assert.equal(joined.length, 1);
      assert.equal(joined[0]?.verdict, 'pass');
      assert.equal(parseFields(joined[0]?.source_json ?? null).name, 'Source 1');
    } finally {
      await store.close();
    }
  });

  test('tx rolls back, so a failed host write leaves nothing behind', async () => {
    const store = sqliteStore(':memory:');
    try {
      await store.initialize(sampleRecords(1));
      store.db.exec('CREATE TABLE host (a INTEGER)');

      assert.throws(() =>
        tx(store.db, () => {
          store.db.prepare('INSERT INTO host VALUES (1)').run();
          throw new Error('the host changed its mind');
        }),
      );

      const rows = store.db.prepare('SELECT * FROM host').all();
      assert.deepEqual(rows, [], 'the insert must not have survived');
    } finally {
      await store.close();
    }
  });
});
