// An executable version of the `TranslationStore` contract.
//
// An interface with no conformance suite is an interface nobody can implement
// correctly. The failure this exists to prevent is specific: somebody starts a
// Postgres store, gets `tryClaim` subtly wrong, and double-translates rows under
// load with nothing anywhere to tell them. Every term in the doc comment on
// `TranslationStore` has a case here.
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

import { TransientFailure } from '../errors.ts';
import type { StoreRecord, TranslationStore } from './types.ts';

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

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
      name: 'tryClaim gives a row to exactly one of many concurrent callers (term 2)',
      run: withStore(async (store) => {
        // The invariant everything else rests on. A store that gets this wrong
        // translates the same row twice and silently keeps the second answer.
        await seeded(store, 1);
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) => store.tryClaim(1, `run-${i}`)),
        );
        const winners = results.filter((r) => r !== null);
        equal(winners.length, 1, 'exactly one caller may win the row');
      }),
    },
    {
      name: 'tryClaim returns null rather than throwing when the row is taken',
      run: withStore(async (store) => {
        // Losing the race is an ordinary outcome under concurrency. A throw
        // would make the common case look exceptional.
        await seeded(store, 1);
        assert(await store.tryClaim(1, 'a'), 'first claim wins');
        equal(await store.tryClaim(1, 'b'), null, 'second claim returns null');
      }),
    },
    {
      name: 'unclaim releases claimed rows and ignores rows it does not hold',
      run: withStore(async (store) => {
        await seeded(store, 3);
        await store.tryClaim(1, 'run-1');
        await store.tryClaim(2, 'run-1');
        const released = await store.unclaim([1, 2, 3]);
        equal(released, 2, 'only the two running rows are released');
        equal((await store.counts()).pending, 3, 'all three are pending again');
        equal(await store.unclaim([]), 0, 'an empty sweep is a no-op');
      }),
    },
    {
      name: 'reclaimStale leaves no row running, even if unclaim was never called',
      run: withStore(async (store) => {
        // The safety net for a process that was killed rather than stopped.
        await seeded(store, 2);
        await store.tryClaim(1, 'run-1');
        await store.tryClaim(2, 'run-1');
        equal((await store.counts()).running, 2, 'both rows are claimed');
        const reclaimed = await store.reclaimStale(0);
        equal(reclaimed, 2, 'both are reclaimed at a zero cutoff');
        equal((await store.counts()).running, 0, 'nothing may be left running');
      }),
    },
    {
      name: 'releaseSettledRunClaims frees rows held by an ended run and spares a live one',
      run: withStore(async (store) => {
        // The point is the *absence* of a clock: nothing here waits, and the two
        // runs differ only in whether they have been finished.
        await store.initialize(sampleRecords(3));
        await store.startRun({ runId: 'dead', model: 'test:model', options: {} });
        await store.startRun({ runId: 'live', model: 'test:model', options: {} });
        await store.tryClaim(1, 'dead');
        await store.tryClaim(2, 'dead');
        await store.tryClaim(3, 'live');

        equal(await store.releaseSettledRunClaims(), 0, 'nothing is released while both runs run');
        equal((await store.counts()).running, 3, 'all three rows are still claimed');

        await store.finishRun('dead', 'interrupted');
        equal(await store.releaseSettledRunClaims(), 2, 'the ended run gives up both its rows');
        const counts = await store.counts();
        equal(counts.running, 1, 'the live run keeps its row');
        equal(counts.pending, 2, 'the released rows are selectable again');
        equal(await store.releaseSettledRunClaims(), 0, 'a second sweep is a no-op');
      }),
    },
    {
      name: 'startAttempt allocates consecutive numbers per row',
      run: withStore(async (store) => {
        const runId = await seeded(store, 2);
        const a = await store.startAttempt({ runId, rowNumber: 1 });
        const b = await store.startAttempt({ runId, rowNumber: 1 });
        const c = await store.startAttempt({ runId, rowNumber: 2 });
        equal(a.attemptNumber, 1, 'first attempt on a row');
        equal(b.attemptNumber, 2, 'second attempt on the same row');
        equal(c.attemptNumber, 1, 'attempt numbers are per row, not global');
        assert(a.attemptId !== b.attemptId, 'attempt ids must be distinct');
      }),
    },
    {
      name: 'startAttempt never issues a duplicate number under concurrency',
      run: withStore(async (store) => {
        // The allocation has to be inside the write. Read-then-insert is safe
        // only while nothing can interleave, which is exactly what an async
        // interface stops guaranteeing.
        const runId = await seeded(store, 1);
        const started = await Promise.all(
          Array.from({ length: 8 }, () => store.startAttempt({ runId, rowNumber: 1 })),
        );
        const numbers = started.map((s) => s.attemptNumber).sort((x, y) => x - y);
        equal(new Set(numbers).size, numbers.length, 'attempt numbers must be unique per row');
        equal(numbers.join(','), '1,2,3,4,5,6,7,8', 'and consecutive from one');
      }),
    },
    {
      name: 'setAttemptPaths accepts absolute paths without complaint (term 5)',
      run: withStore(async (store) => {
        const runId = await seeded(store, 1);
        const { attemptId } = await store.startAttempt({ runId, rowNumber: 1 });
        await store.setAttemptPaths(attemptId, {
          responsePath: '/tmp/harness/00001_R-1_a01.response.json',
          stdoutPath: '/tmp/harness/00001_R-1_a01.stdout.log',
          stderrPath: '/tmp/harness/00001_R-1_a01.stderr.log',
        });
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
      name: 'recordInternalError fails only the rows it is given',
      run: withStore(async (store) => {
        // "Every running row" would also fail the rows a concurrent process
        // happens to hold, which is how one broken run takes down another.
        const runId = await seeded(store, 3);
        await store.tryClaim(1, runId);
        await store.tryClaim(2, 'some-other-run');
        await store.recordInternalError(runId, new Error('boom'), [1]);
        const counts = await store.counts();
        equal(counts.failed, 1, 'only the given row failed');
        equal(counts.running, 1, 'the other run keeps its row');
      }),
    },
    {
      name: 'recordInternalError with no rows touches no item',
      run: withStore(async (store) => {
        const runId = await seeded(store, 2);
        await store.tryClaim(1, runId);
        await store.recordInternalError(runId, new Error('boom'), []);
        equal((await store.counts()).failed, 0, 'an empty set updates nothing');
      }),
    },
    {
      name: 'a run can be started and finished',
      run: withStore(async (store) => {
        await store.initialize(sampleRecords(1));
        await store.startRun({ runId: 'r1', model: 'test:model', options: { concurrency: 2 } });
        await store.finishRun('r1', 'completed');
      }),
    },
    {
      name: 'close is idempotent',
      run: async (): Promise<void> => {
        const store = await make();
        await store.close();
        await store.close();
      },
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
