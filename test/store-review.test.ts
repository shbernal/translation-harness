// The review half of the store.
//
// The first block is the point of the whole exercise: `batchConformance` runs
// unchanged against `ReviewStore`, so the review lifecycle *inherits* the five
// generic contract terms rather than re-earning them. If a case in there fails,
// the review store is not a batch store and no amount of review-specific testing
// covers for it.
//
// The rest is what only this half has: a run that is a job rather than an
// invocation, a snapshot that outlives the corpus it was taken from, and the
// refusal to write anything into `items`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { batchConformance } from '../src/batch/conformance.ts';
import type { ReviewItemRecord, ReviewRunRecord, ReviewStore } from '../src/store/review-types.ts';
import { type SqliteStore, sqliteStore } from '../src/store/sqlite.ts';

const RUN_ID = 'a7f3c1d2e4b5968708192a3b4c5d6e7f';

function sampleRun(runId = RUN_ID): ReviewRunRecord {
  return {
    runId,
    provider: null,
    model: null,
    profile: 'reviewer-default',
    reasoningEffort: null,
    options: { reviewFields: ['name'], showSource: true },
    inputs: { prompt: 'p-hash', schema: 's-hash', snapshot: 'c-hash' },
    baseRunId: null,
  };
}

/** `count` snapshotted rows, numbered from 1, with predictable content. */
function sampleItems(count: number): ReviewItemRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    rowNumber: i + 1,
    identifier: `R-${i + 1}`,
    inputHash: `hash-${i + 1}`,
    sourceHash: `src-${i + 1}`,
    targetHash: `tgt-${i + 1}`,
    evidenceHash: `ev-${i + 1}`,
    source: { name: `Source ${i + 1}` },
    target: { name: `Cible ${i + 1}` },
  }));
}

/** A registry with a corpus-free review run of `count` rows already in it. */
async function seeded(count: number, runId = RUN_ID): Promise<[SqliteStore, ReviewStore]> {
  const store = sqliteStore(':memory:');
  const review = store.review(runId);
  await review.createRun(sampleRun(runId), sampleItems(count));
  return [store, review];
}

describe('ReviewStore is a BatchStore', () => {
  // The two capabilities the generic suite cannot supply for itself come from the
  // review lifecycle, exactly as they come from `initialize` and `counts` on the
  // translate side: `createRun` makes the rows and `counts` counts the claims.
  for (const { name, run } of batchConformance(async (rowCount) => {
    const [, review] = await seeded(rowCount);
    return {
      store: review,
      rows: Array.from({ length: rowCount }, (_, i) => i + 1),
      claimed: async () => (await review.counts()).running,
    };
  })) {
    test(name, run);
  }
});

describe('a review run is a job, not an invocation', () => {
  test('createRun writes the run and its rows, and reports that it created them', async () => {
    const [store, review] = await seeded(3);
    const run = await review.run();
    assert.equal(run?.status, 'initialized');
    assert.equal(run?.profile, 'reviewer-default');
    assert.deepEqual(run?.inputs, { prompt: 'p-hash', schema: 's-hash', snapshot: 'c-hash' });
    assert.equal((await review.snapshot()).length, 3);
    await store.close();
  });

  test('a second createRun changes nothing and says so (term 7)', async () => {
    const [store, review] = await seeded(2);
    // Init is idempotent by derivation: the same inputs give the same run id, so
    // the second call has to return the first run rather than rebuild it.
    const again = await review.createRun(sampleRun(), sampleItems(5));
    assert.equal(again, false);
    assert.equal((await review.snapshot()).length, 2, "the first run's rows are untouched");
    await store.close();
  });

  test('a store refuses to create a run it is not scoped to', async () => {
    const store = sqliteStore(':memory:');
    const review = store.review(RUN_ID);
    await assert.rejects(
      () => review.createRun(sampleRun('some-other-run'), sampleItems(1)),
      /scoped to review run/,
    );
    await store.close();
  });

  test('two runs over the same row numbers do not see each other', async () => {
    // The reason a store is scoped to a run: `row_number` is the corpus row, so
    // it repeats across runs and only means something once the run is fixed.
    const store = sqliteStore(':memory:');
    const first = store.review('run-one');
    const second = store.review('run-two');
    await first.createRun(sampleRun('run-one'), sampleItems(3));
    await second.createRun(sampleRun('run-two'), sampleItems(3));

    await first.startRun({ runId: 'pass-1', model: 'test:model', options: {} });
    assert.ok(await first.tryClaim(2, 'pass-1'));
    assert.equal((await first.counts()).running, 1);
    assert.equal((await second.counts()).running, 0, 'the other run keeps its own row 2');
    await store.close();
  });

  test('setRunStatus records a finish time only for a status that ends the job', async () => {
    const [store, review] = await seeded(1);
    await review.setRunStatus('running');
    assert.equal((await review.run())?.finishedAt, null);
    await review.setRunStatus('completed');
    assert.ok((await review.run())?.finishedAt, 'a completed run has finished');
    await store.close();
  });

  test('bindProvider fixes the model on a run created without one', async () => {
    const [store, review] = await seeded(1);
    assert.equal((await review.run())?.provider, null);
    await review.bindProvider({ provider: 'codex', model: 'gpt-5', reasoningEffort: 'high' });
    const run = await review.run();
    assert.equal(run?.provider, 'codex');
    assert.equal(run?.model, 'gpt-5');
    assert.equal(run?.reasoningEffort, 'high');
    await store.close();
  });
});

describe('rows, verdicts and selection', () => {
  test('a settled row is seeded pass and is never a candidate', async () => {
    const store = sqliteStore(':memory:');
    const review = store.review(RUN_ID);
    const items = sampleItems(3);
    // `settled` is `job.precomputed` one level up: the caller already knows the
    // answer, so the row is part of the snapshot but costs no model call.
    items[1] = { ...(items[1] as ReviewItemRecord), settled: true };
    await review.createRun(sampleRun(), items);

    assert.deepEqual(await review.counts(), {
      pending: 2,
      running: 0,
      pass: 1,
      change_proposed: 0,
      failed: 0,
    });
    const candidates = await review.selectCandidates({});
    assert.deepEqual(
      candidates.map((c) => c.rowNumber),
      [1, 3],
    );
    await store.close();
  });

  test('commitVerdict settles the row and releases the claim', async () => {
    const [store, review] = await seeded(2);
    await review.startRun({ runId: 'pass-1', model: 'test:model', options: {} });
    const claimed = await review.tryClaim(1, 'pass-1');
    assert.ok(claimed);
    const { attemptId, attemptNumber } = await review.startAttempt({
      runId: 'pass-1',
      rowNumber: 1,
    });
    await review.commitVerdict({
      attemptId,
      attemptNumber,
      duration: 2.5,
      exitCode: 0,
      rowNumber: 1,
      verdict: 'change_proposed',
      severity: 'moderate',
      confidence: 'high',
      proposals: { name: 'Cible corrigee' },
      issues: ['register too informal'],
    });

    const [row] = await review.snapshot();
    assert.equal(row?.outcome, 'change_proposed');
    assert.equal(row?.severity, 'moderate');
    assert.deepEqual(row?.proposals, { name: 'Cible corrigee' });
    assert.deepEqual(row?.issues, ['register too informal']);
    assert.equal((await review.counts()).running, 0, 'settling releases the claim');
    await store.close();
  });

  test('markItemFailed leaves the row failed and retryable', async () => {
    const [store, review] = await seeded(2);
    await review.markItemFailed({ rowNumber: 2, lastError: 'exhausted attempts', attemptCount: 3 });
    assert.equal((await review.counts()).failed, 1);
    assert.deepEqual(
      (await review.selectCandidates({})).map((c) => c.rowNumber),
      [1],
      'a failed row is not a candidate by default',
    );
    assert.deepEqual(
      (await review.selectCandidates({ retryFailed: true })).map((c) => c.rowNumber),
      [1, 2],
    );
    await store.close();
  });

  test('selectCandidates refuses an identifier it cannot offer', async () => {
    const [store, review] = await seeded(2);
    await assert.rejects(
      () => review.selectCandidates({ identifiers: ['R-1', 'R-99'] }),
      /R-99/,
      'a typo in an identifier list must not silently review fewer rows',
    );
    await store.close();
  });

  test('redo widens to rows that already hold a verdict', async () => {
    const [store, review] = await seeded(2);
    await review.markItemFailed({ rowNumber: 1, lastError: 'x', attemptCount: 1 });
    const redo = await review.selectCandidates({ redo: true });
    assert.deepEqual(
      redo.map((c) => c.rowNumber),
      [1, 2],
    );
    await store.close();
  });
});

describe('the review half writes nowhere else', () => {
  test('a whole review lifecycle leaves items untouched (term 8)', async () => {
    // The property the lifecycle exists to have: the reviewer proposes, and
    // adopting the proposal is a separate, human, auditable step.
    const store = sqliteStore(':memory:');
    await store.initialize([
      {
        rowNumber: 1,
        identifier: 'R-1',
        source: { name: 'Source 1' },
        target: { name: 'Cible 1' },
        seedSucceeded: true,
        inputHash: 'hash-1',
      },
    ]);
    const before = await store.translationsByIdentifier();

    const review = store.review(RUN_ID);
    await review.createRun(sampleRun(), sampleItems(1));
    await review.startRun({ runId: 'pass-1', model: 'test:model', options: {} });
    await review.tryClaim(1, 'pass-1');
    const attempt = await review.startAttempt({ runId: 'pass-1', rowNumber: 1 });
    await review.commitVerdict({
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      duration: 1,
      exitCode: 0,
      rowNumber: 1,
      verdict: 'change_proposed',
      severity: 'major',
      confidence: 'high',
      proposals: { name: 'Une reecriture' },
      issues: [],
    });
    await review.finishRun('pass-1', 'completed');
    await review.setRunStatus('completed');

    assert.deepEqual(await store.translationsByIdentifier(), before, 'the corpus is unchanged');
    assert.deepEqual((await store.counts()).succeeded, 1);
    await store.close();
  });

  test('closing either store closes the file once', async () => {
    const store = sqliteStore(':memory:');
    const review = store.review(RUN_ID);
    await review.close();
    await store.close();
    await review.close();
  });
});
