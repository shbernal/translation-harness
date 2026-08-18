// What `reclaimStale` treats as evidence that a run is dead.
//
// Both halves used to read a start time: a run or a pass that began before the
// cutoff had its in-flight attempts stamped `abandoned` and was then declared
// interrupted, whether or not it was working at that moment. A batch that
// legitimately runs longer than `ageMinutes` was therefore misreported while it
// was running, and it self-healed as each attempt committed over the stamp,
// which is why nothing caught it. The rows are the evidence a run is alive; its
// age is not.
//
// Both halves are here rather than in their own files because it is one rule,
// stated twice against two schemas, and the pair is the point: this is the
// first fix that has to land on `runs`/`items` and `review_passes`/`review_items`
// at once.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sampleRecords } from '../src/store/conformance.ts';
import type { ReviewItemRecord, ReviewRunRecord } from '../src/store/review-types.ts';
import { type SqliteStore, sqliteStore } from '../src/store/sqlite.ts';

const REVIEW_RUN = 'a7f3c1d2e4b5968708192a3b4c5d6e7f';

/** An ISO stamp `minutes` in the past, second-granular as the store writes them. */
const ago = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const one = (store: SqliteStore, sql: string, ...args: unknown[]): Record<string, unknown> =>
  store.db.prepare(sql).get(...(args as never[])) as Record<string, unknown>;

describe('reclaimStale judges a run by its rows, not by its start time', () => {
  /**
   * A run started an hour ago holding one claimed row, with an attempt open.
   * The row's `updated_at` is the only thing the two cases differ in.
   */
  async function longRun(rowTouchedMinutesAgo: number): Promise<SqliteStore> {
    const store = sqliteStore(':memory:');
    await store.initialize(sampleRecords(2));
    await store.startRun({ runId: 'long', model: 'test:model', options: {} });
    await store.tryClaim(1, 'long');
    await store.startAttempt({ runId: 'long', rowNumber: 1 });
    store.db.prepare('UPDATE runs SET started_at = ? WHERE run_id = ?').run(ago(60), 'long');
    store.db
      .prepare('UPDATE items SET updated_at = ? WHERE row_number = ?')
      .run(ago(rowTouchedMinutesAgo), 1);
    return store;
  }

  test('a run working on a fresh row survives a cutoff its start time is past', async () => {
    // Started 60 minutes ago, touched a row 1 minute ago, swept at 30.
    const store = await longRun(1);
    try {
      assert.equal(await store.reclaimStale(30), 0, 'the row it is working on is not stale');

      assert.equal(
        one(store, "SELECT status FROM runs WHERE run_id = 'long'").status,
        'running',
        'a long run is not a dead run',
      );
      assert.equal(
        one(store, 'SELECT status FROM items WHERE row_number = 1').status,
        'running',
        'and it keeps the row it is working on',
      );
      assert.equal(
        one(store, 'SELECT outcome FROM attempts WHERE row_number = 1').outcome,
        null,
        'its in-flight attempt is not stamped abandoned underneath it',
      );
    } finally {
      await store.close();
    }
  });

  // The mirror, so the fix cannot be read as having disabled reclamation.
  test('a run whose every row went stale is still reclaimed', async () => {
    const store = await longRun(45);
    try {
      assert.equal(await store.reclaimStale(30), 1, 'the stranded row is released');

      assert.equal(
        one(store, "SELECT status FROM runs WHERE run_id = 'long'").status,
        'interrupted',
      );
      assert.equal(one(store, 'SELECT status FROM items WHERE row_number = 1').status, 'pending');
      const attempt = one(
        store,
        'SELECT outcome, error_category FROM attempts WHERE row_number = 1',
      );
      assert.equal(attempt.outcome, 'failed');
      assert.equal(
        attempt.error_category,
        'abandoned',
        'the run was declared dead before the attempts statement read its status',
      );
    } finally {
      await store.close();
    }
  });
});

describe('the review half reads liveness the same way', () => {
  function sampleRun(): ReviewRunRecord {
    return {
      runId: REVIEW_RUN,
      provider: null,
      model: null,
      profile: 'reviewer-default',
      reasoningEffort: null,
      options: { reviewFields: ['name'], showSource: true },
      inputs: { prompt: 'p-hash', schema: 's-hash', snapshot: 'c-hash' },
      baseRunId: null,
    };
  }

  const sampleItems = (count: number): ReviewItemRecord[] =>
    Array.from({ length: count }, (_, i) => ({
      rowNumber: i + 1,
      identifier: `R-${i + 1}`,
      inputHash: `hash-${i + 1}`,
      sourceHash: `src-${i + 1}`,
      targetHash: `tgt-${i + 1}`,
      evidenceHash: `ev-${i + 1}`,
      source: { name: `Source ${i + 1}` },
      target: { name: `Cible ${i + 1}` },
    }));

  async function longPass(rowTouchedMinutesAgo: number): Promise<SqliteStore> {
    const store = sqliteStore(':memory:');
    const review = store.review(REVIEW_RUN);
    await review.createRun(sampleRun(), sampleItems(2));
    await review.startRun({ runId: 'pass-1', model: 'test:model', options: {} });
    await review.tryClaim(1, 'pass-1');
    await review.startAttempt({ runId: 'pass-1', rowNumber: 1 });
    store.db
      .prepare('UPDATE review_passes SET started_at = ? WHERE pass_id = ?')
      .run(ago(60), 'pass-1');
    store.db
      .prepare('UPDATE review_items SET updated_at = ? WHERE row_number = ?')
      .run(ago(rowTouchedMinutesAgo), 1);
    return store;
  }

  test('a pass working on a fresh row survives a cutoff its start time is past', async () => {
    const store = await longPass(1);
    try {
      assert.equal(await store.review(REVIEW_RUN).reclaimStale(30), 0);

      assert.equal(
        one(store, "SELECT status FROM review_passes WHERE pass_id = 'pass-1'").status,
        'running',
        'a long pass is not a dead pass',
      );
      assert.equal(
        one(store, 'SELECT outcome FROM review_items WHERE row_number = 1').outcome,
        'running',
      );
      assert.equal(
        one(store, 'SELECT outcome FROM review_attempts WHERE row_number = 1').outcome,
        null,
        'its in-flight attempt is not stamped abandoned underneath it',
      );
    } finally {
      await store.close();
    }
  });

  test('a pass whose every row went stale is still reclaimed', async () => {
    const store = await longPass(45);
    try {
      assert.equal(await store.review(REVIEW_RUN).reclaimStale(30), 1);

      assert.equal(
        one(store, "SELECT status FROM review_passes WHERE pass_id = 'pass-1'").status,
        'interrupted',
      );
      assert.equal(
        one(store, 'SELECT outcome FROM review_items WHERE row_number = 1').outcome,
        'pending',
      );
      assert.equal(
        one(store, 'SELECT error_category FROM review_attempts WHERE row_number = 1')
          .error_category,
        'abandoned',
      );
    } finally {
      await store.close();
    }
  });
});
