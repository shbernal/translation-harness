// An executable version of the `TranslationStore` contract.
//
// An interface with no conformance suite is an interface nobody can implement
// correctly. The failure this exists to prevent is specific: somebody starts a
// Postgres store, gets `tryClaim` subtly wrong, and double-translates rows under
// load with nothing anywhere to tell them. Every term in the doc comment on
// `TranslationStore` has a case here.
//
// Terms 1 to 5 and 10 belong to `BatchStore`, so their cases do too: this suite
// runs the whole of `batchConformance` before its own, against a harness built
// out of `initialize`, `counts` and a settled row. A translation store *proves* the generic
// terms rather than asserting them, and a review store proving the same suite
// starts from guarantees that are already demonstrated.
//
// It returns named async assertions rather than calling a test framework,
// because a library has no business choosing a consumer's test runner. Drive
// them from whatever you use:
//
// ```ts
// for (const { name, run } of storeConformance(() => Promise.resolve(myStore())))
//   test(name, run);
// ```
//
// `sqliteStore` runs the whole suite in this package's own tests, so the suite
// is the SQLite regression net too, rather than extra surface maintained for a
// hypothetical third party.

import { batchConformance, type ConformanceCase } from '../batch/conformance.ts';
import { TransientFailure } from '../errors.ts';
import type { StoreRecord, TranslationStore } from './types.ts';

export type { ConformanceCase } from '../batch/conformance.ts';

/** A fresh, empty store. Called once per case; each case owns its store. */
export type StoreFactory = () => Promise<TranslationStore>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`store conformance: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

/** `count` records, numbered from 1, with predictable content. */
export function sampleRecords(count: number): StoreRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    rowNumber: i + 1,
    identifier: `R-${i + 1}`,
    source: { name: `Source ${i + 1}`, note: i % 3 === 0 ? null : `note ${i + 1}` },
    seedSucceeded: false,
    inputHash: `hash-${i + 1}`,
  }));
}

export function storeConformance(make: StoreFactory): ConformanceCase[] {
  /** Run `body` against a fresh store, closing it whatever happens. */
  const withStore =
    (body: (store: TranslationStore) => Promise<void>) => async (): Promise<void> => {
      const store = await make();
      try {
        await body(store);
      } finally {
        await store.close();
      }
    };

  /** A store seeded with `count` pending rows and one open run. */
  const seeded = async (store: TranslationStore, count: number, runId = 'run-1') => {
    await store.initialize(sampleRecords(count));
    await store.startRun({ runId, model: 'test:model', options: {} });
    return runId;
  };

  return [
    // The generic terms, checked against this store. `BatchStore` has no way to
    // create a row or to count a claim, deliberately, so the two capabilities the
    // suite cannot supply for itself come from the lifecycle: `initialize` and
    // `counts`.
    ...batchConformance(async (rowCount) => {
      const store = await make();
      await store.initialize(sampleRecords(rowCount));
      return {
        store,
        rows: Array.from({ length: rowCount }, (_, i) => i + 1),
        claimed: async () => (await store.counts()).running,
        // Term 10 needs a row holding an answer, which is what a redo pass
        // claims. `commitPrecomputed` is the shortest honest way to make one:
        // it settles a row in one transaction without inventing an attempt.
        settle: async (rowNumber: number) => {
          await store.tryClaim(rowNumber, 'seed-run');
          await store.commitPrecomputed({
            rowNumber,
            outcome: 'succeeded',
            translations: { name: 'settled' },
            warnings: [],
            reviewReasons: [],
            promptHash: 'seed',
          });
          return 'succeeded';
        },
        stateOf: async (rowNumber: number) => {
          const row = (await store.items()).find((i) => i.rowNumber === rowNumber);
          if (!row) throw new Error(`store conformance: row ${rowNumber} is missing`);
          return row.status;
        },
      };
    }),
    {
      name: 'initialize inserts every record and reports the count',
      run: withStore(async (store) => {
        const result = await store.initialize(sampleRecords(5));
        equal(result.inserted, 5, 'inserted count');
        equal(result.reset, 0, 'reset count');
        const counts = await store.counts();
        equal(counts.pending, 5, 'pending after initialize');
      }),
    },
    {
      name: 'initialize is idempotent: the same records twice change nothing',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(3));
        const again = await store.initialize(sampleRecords(3));
        equal(again.inserted, 0, 'second initialize inserted');
        equal(again.reset, 0, 'second initialize reset');
      }),
    },
    {
      name: 'initialize resets only the rows whose input hash changed',
      run: withStore(async (store) => {
        const records = sampleRecords(3);
        await store.initialize(records);
        const claimed = await store.tryClaim(1, 'r');
        assert(claimed, 'row 1 should be claimable');
        await store.commitSuccess({
          attemptId: (await startOne(store, 1)).attemptId,
          duration: 1,
          outcome: 'succeeded',
          exitCode: 0,
          rowNumber: 1,
          translations: { name: 'done' },
          warnings: [],
          reviewReasons: [],
          promptHash: 'p',
          modelLabel: 'm',
          attemptNumber: 1,
        });

        const changed = records.map((r) =>
          r.rowNumber === 2 ? { ...r, inputHash: 'hash-2-changed' } : r,
        );
        const result = await store.initialize(changed);
        equal(result.reset, 1, 'only the changed row resets');
        const counts = await store.counts();
        equal(counts.succeeded, 1, 'the finished row keeps its translation');
      }),

      // `startOne` is defined below; hoisting is fine because `run` is deferred.
    },
    {
      name: 'initialize refuses a record set missing a row the registry holds (term 6)',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(4));
        let rejected = false;
        try {
          await store.initialize(sampleRecords(3));
        } catch {
          rejected = true;
        }
        assert(rejected, 'a shrinking corpus must be an error, not a silent orphaning');
      }),
    },
    {
      name: 'selectCandidates returns pending rows in row order',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(4));
        const rows = await store.selectCandidates({});
        equal(rows.length, 4, 'candidate count');
        equal(
          rows.map((r) => r.rowNumber).join(','),
          '1,2,3,4',
          'candidates must come back in row order',
        );
        equal(rows[0]?.source.name, 'Source 1', 'the source fields come back parsed');
      }),
    },
    {
      name: 'selectCandidates never returns a running row',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(3));
        await store.tryClaim(2, 'r');
        const rows = await store.selectCandidates({
          redo: true,
          retryFailed: true,
          includeReview: true,
        });
        assert(
          !rows.some((r) => r.rowNumber === 2),
          'a live run owns claimed rows, whatever the filter says',
        );
      }),
    },
    {
      name: 'selectCandidates honours limit and identifiers',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(5));
        equal((await store.selectCandidates({ limit: 2 })).length, 2, 'limit');
        const byId = await store.selectCandidates({ identifiers: ['R-3', 'R-5'] });
        equal(byId.map((r) => r.identifier).join(','), 'R-3,R-5', 'identifier filter');
      }),
    },
    {
      name: 'commitSuccess settles the row and makes the translation readable',
      run: withStore(async (store) => {
        const runId = await seeded(store, 2);
        await store.tryClaim(1, runId);
        const { attemptId, attemptNumber } = await store.startAttempt({ runId, rowNumber: 1 });
        await store.commitSuccess({
          attemptId,
          duration: 2.5,
          outcome: 'review_required',
          exitCode: 0,
          rowNumber: 1,
          translations: { name: 'Traduction' },
          warnings: ['a warning'],
          reviewReasons: ['a reason'],
          promptHash: 'p1',
          modelLabel: 'test:model',
          attemptNumber,
        });
        const counts = await store.counts();
        equal(counts.review_required, 1, 'the row settled as review_required');
        equal(counts.running, 0, 'and is no longer claimed');
        const byId = await store.translationsByIdentifier();
        equal(byId.get('R-1')?.name, 'Traduction', 'the translation is readable back');
      }),
    },
    {
      name: 'commitPrecomputed settles a row that no attempt ever touched',
      run: withStore(async (store) => {
        const runId = await seeded(store, 1);
        await store.tryClaim(1, runId);
        await store.commitPrecomputed({
          rowNumber: 1,
          outcome: 'succeeded',
          translations: { name: 'known' },
          warnings: [],
          reviewReasons: [],
          promptHash: 'p1',
        });
        equal((await store.counts()).succeeded, 1, 'settled without an attempt');
        equal((await store.translationsByIdentifier()).get('R-1')?.name, 'known', 'and readable');
      }),
    },
    {
      name: 'translationsByIdentifier omits rows with no answer yet',
      run: withStore(async (store) => {
        // A caller reading a partial corpus must get a gap, not a wrong value.
        const runId = await seeded(store, 3);
        await store.tryClaim(1, runId);
        await store.commitPrecomputed({
          rowNumber: 1,
          outcome: 'succeeded',
          translations: { name: 'done' },
          warnings: [],
          reviewReasons: [],
          promptHash: 'p',
        });
        const byId = await store.translationsByIdentifier();
        equal(byId.size, 1, 'only the answered row is present');
        equal(byId.has('R-2'), false, 'an unanswered row is absent, not empty');
      }),
    },
    {
      name: 'items returns every row in row-number order, including a claimed one (term 9)',
      run: withStore(async (store) => {
        // Deliberately the awkward case: one row in flight and one settled, so a
        // store that reused its candidate selection here returns 2 rows, not 3.
        const runId = await seeded(store, 3);
        await store.tryClaim(2, runId);
        await store.tryClaim(3, runId);
        await store.commitPrecomputed({
          rowNumber: 3,
          outcome: 'succeeded',
          translations: { name: 'done' },
          warnings: [],
          reviewReasons: [],
          promptHash: 'p',
        });
        const rows = await store.items();
        equal(rows.length, 3, 'every row comes back whatever its status');
        equal(
          rows.map((r) => r.rowNumber).join(','),
          '1,2,3',
          'and in row-number order, unconditionally',
        );
        equal(rows[1]?.status, 'running', 'a claimed row is included, not filtered out');
        equal(rows[0]?.identifier, 'R-1', 'with the identifier the corpus knows it by');
        equal(rows[0]?.inputHash, 'hash-1', 'and the input hash a snapshot needs');
      }),
    },
    {
      name: 'items reports an unanswered row as a null target, never as {} (term 9)',
      run: withStore(async (store) => {
        // This is the term's load-bearing half. A store that normalizes the two
        // passes every other case here and silently moves every review run id
        // derived from the corpus it returns.
        const runId = await seeded(store, 2);
        await store.tryClaim(1, runId);
        await store.commitPrecomputed({
          rowNumber: 1,
          outcome: 'succeeded',
          translations: {},
          warnings: [],
          reviewReasons: [],
          promptHash: 'p',
        });
        const rows = await store.items();
        const answered = rows.find((r) => r.rowNumber === 1);
        const unanswered = rows.find((r) => r.rowNumber === 2);
        equal(unanswered?.target, null, 'a row with no answer has a null target');
        assert(
          answered?.target !== null && answered?.target !== undefined,
          'a row answered with an empty object has a target, not null',
        );
        equal(
          Object.keys(answered.target).length,
          0,
          'and that target is empty, which is a different thing from absent',
        );
      }),
    },
    {
      name: 'failAttempt and markItemFailed record a row that ran out of attempts',
      run: withStore(async (store) => {
        const runId = await seeded(store, 1);
        await store.tryClaim(1, runId);
        const { attemptId, attemptNumber } = await store.startAttempt({ runId, rowNumber: 1 });
        await store.failAttempt(attemptId, new TransientFailure('timeout', 'too slow', 124));
        await store.markItemFailed({
          rowNumber: 1,
          lastError: 'timeout: too slow',
          promptHash: 'p1',
          modelLabel: 'test:model',
          attemptCount: attemptNumber,
        });
        const counts = await store.counts();
        equal(counts.failed, 1, 'the row is failed');
        equal(counts.running, 0, 'and released');
      }),
    },
    {
      name: 'recordInternalError marks the rows it is given failed, and no others',
      run: withStore(async (store) => {
        // `batchConformance` checks that it releases only those rows. What is
        // this lifecycle's is where they land: `failed`, not back in `pending`.
        const runId = await seeded(store, 3);
        await store.tryClaim(1, runId);
        await store.tryClaim(2, 'some-other-run');
        await store.recordInternalError(runId, new Error('boom'), [1]);
        const counts = await store.counts();
        equal(counts.failed, 1, 'only the given row failed');
        equal(counts.running, 1, 'the other run keeps its row');
      }),
    },
  ];
}

/** Start one attempt against a store with no open run, opening one if needed. */
async function startOne(
  store: TranslationStore,
  rowNumber: number,
): Promise<{ attemptId: number; attemptNumber: number }> {
  const runId = `aux-${rowNumber}`;
  await store.startRun({ runId, model: 'test:model', options: {} });
  return store.startAttempt({ runId, rowNumber });
}
