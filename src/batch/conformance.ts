// An executable version of the `BatchStore` contract.
//
// An interface with no conformance suite is an interface nobody can implement
// correctly. The failure this exists to prevent is specific: somebody starts a
// Postgres store, gets `tryClaim` subtly wrong, and double-answers rows under
// load with nothing anywhere to tell them. Terms 1 to 5 and 10 on `BatchStore` have a
// case here, and `storeConformance` runs the whole of this suite before its own
// lifecycle cases, so a translation store proves the generic terms rather than
// asserting them.
//
// It returns named async assertions rather than calling a test framework, because
// a library has no business choosing a consumer's test runner:
//
// ```ts
// for (const { name, run } of batchConformance(myHarness)) test(name, run);
// ```

import { TransientFailure } from '../errors.ts';
import type { BatchStore, ClaimedRow } from './types.ts';

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

/**
 * A store with rows in it, plus the two things a generic suite cannot do for
 * itself.
 *
 * `BatchStore` has no way to create a row and no way to count one, on purpose:
 * both are lifecycle knowledge (`TranslationStore.initialize` and `counts`), and
 * putting them in the base interface to make testing easier would have made the
 * base interface a lie. So the host supplies exactly those two capabilities and
 * nothing else.
 */
export interface BatchStoreHarness<TRow extends ClaimedRow = ClaimedRow> {
  store: BatchStore<TRow>;
  /** The row numbers that exist and start out claimable, ascending. */
  rows: readonly number[];
  /** How many of `rows` are claimed right now, however the store records that. */
  claimed(): Promise<number>;
  /**
   * Settle a row, and name the state it settled into.
   *
   * Term 10 is about a status a claim displaced, so the suite needs a row in
   * some state other than the one every row starts in - and settling a row is
   * lifecycle work (`commitSuccess`, `commitVerdict`), exactly as creating one
   * is. The returned label is compared against {@link stateOf} and is never
   * interpreted, so a store may name its states whatever it names them.
   */
  settle(rowNumber: number): Promise<string>;
  /** The row's state right now, in the same vocabulary {@link settle} returns. */
  stateOf(rowNumber: number): Promise<string>;
}

/** A fresh store holding `rowCount` claimable rows. One per case. */
export type BatchStoreFactory = (rowCount: number) => Promise<BatchStoreHarness>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`batch conformance: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

export function batchConformance(make: BatchStoreFactory): ConformanceCase[] {
  /** Run `body` against a fresh harness, closing its store whatever happens. */
  const withRows =
    (count: number, body: (h: BatchStoreHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make(count);
      assert(
        harness.rows.length >= count,
        `the harness must supply at least ${count} rows, got ${harness.rows.length}`,
      );
      try {
        await body(harness);
      } finally {
        await harness.store.close();
      }
    };

  /** A harness whose store also has one open run. */
  const withRun =
    (count: number, body: (h: BatchStoreHarness, runId: string) => Promise<void>) =>
    async (): Promise<void> =>
      withRows(count, async (harness) => {
        await harness.store.startRun({ runId: 'run-1', model: 'test:model', options: {} });
        await body(harness, 'run-1');
      })();

  return [
    {
      name: 'tryClaim gives a row to exactly one of many concurrent callers (term 2)',
      run: withRun(1, async ({ store, rows }) => {
        // The invariant everything else rests on. A store that gets this wrong
        // answers the same row twice and silently keeps the second answer.
        const row = rows[0] as number;
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) => store.tryClaim(row, `run-${i}`)),
        );
        equal(results.filter((r) => r !== null).length, 1, 'exactly one caller may win the row');
      }),
    },
    {
      name: 'tryClaim returns null rather than throwing when the row is taken',
      run: withRun(1, async ({ store, rows }) => {
        // Losing the race is an ordinary outcome under concurrency. A throw
        // would make the common case look exceptional.
        const row = rows[0] as number;
        assert(await store.tryClaim(row, 'a'), 'first claim wins');
        equal(await store.tryClaim(row, 'b'), null, 'second claim returns null');
      }),
    },
    {
      name: 'tryClaim returns the store row, so the runner works from fresh data',
      run: withRun(2, async ({ store, rows }) => {
        const row = rows[1] as number;
        const claimed = await store.tryClaim(row, 'run-1');
        assert(claimed, 'the row should be claimable');
        equal(claimed.rowNumber, row, 'the claimed row knows its own number');
        assert(
          typeof claimed.identifier === 'string' && claimed.identifier.length > 0,
          'a claimed row must carry an identifier: the runner names evidence files with it',
        );
      }),
    },
    {
      name: 'unclaim releases claimed rows and ignores rows it does not hold',
      run: withRun(3, async ({ store, rows, claimed }) => {
        await store.tryClaim(rows[0] as number, 'run-1');
        await store.tryClaim(rows[1] as number, 'run-1');
        equal(await store.unclaim(rows), 2, 'only the two claimed rows are released');
        equal(await claimed(), 0, 'nothing is left claimed');
        equal(await store.unclaim([]), 0, 'an empty sweep is a no-op');
      }),
    },
    {
      // A redo pass claims rows that already hold an answer. If releasing one
      // sends it to `pending`, a hard kill mid-redo turns rows that held
      // accepted work into rows the next ordinary run re-answers and re-pays
      // for. Nothing is lost - the answer is still in the row - but nothing
      // says so either, and the money is spent again.
      name: 'a released row returns to the state it held before it was claimed (term 10)',
      run: withRun(3, async ({ store, rows, settle, stateOf, claimed }) => {
        const [redone, alsoRedone, untouched] = rows as [number, number, number];
        const settledState = await settle(redone);
        await settle(alsoRedone);
        const freshState = await stateOf(untouched);
        assert(
          settledState !== freshState,
          'the harness must settle a row into a state a fresh row is not in, ' +
            `or this term cannot be observed (both are ${JSON.stringify(settledState)})`,
        );

        // Every release path makes the same promise, so each is checked. They
        // are separate statements in a real store and it is one edit to fix
        // only the one a test happened to name.
        assert(await store.tryClaim(redone, 'run-1'), 'a settled row is claimable: that is a redo');
        assert(await store.tryClaim(untouched, 'run-1'), 'and so is a fresh one');
        equal(await store.unclaim([redone, untouched]), 2, 'both are released');
        equal(await stateOf(redone), settledState, 'unclaim gives the settled row back its state');
        equal(await stateOf(untouched), freshState, 'and leaves a fresh row where it was');

        assert(await store.tryClaim(redone, 'run-1'), 'claim it again for the next path');
        await store.reclaimStale(0);
        equal(await stateOf(redone), settledState, 'reclaimStale restores it too');

        assert(await store.tryClaim(redone, 'run-1'), 'and once more');
        await store.finishRun('run-1', 'interrupted');
        await store.releaseSettledRunClaims();
        equal(await stateOf(redone), settledState, 'and so does releaseSettledRunClaims');
        equal(await claimed(), 0, 'no path out leaves it claimed');
      }),
    },
    {
      name: 'reclaimStale leaves no row claimed, even if unclaim was never called',
      run: withRun(2, async ({ store, rows, claimed }) => {
        // The safety net for a process that was killed rather than stopped.
        await store.tryClaim(rows[0] as number, 'run-1');
        await store.tryClaim(rows[1] as number, 'run-1');
        equal(await claimed(), 2, 'both rows are claimed');
        equal(await store.reclaimStale(0), 2, 'both are reclaimed at a zero cutoff');
        equal(await claimed(), 0, 'nothing may be left claimed');
      }),
    },
    {
      name: 'releaseSettledRunClaims frees rows held by an ended run and spares a live one',
      run: withRows(3, async ({ store, rows, claimed }) => {
        // The point is the *absence* of a clock: nothing here waits, and the two
        // runs differ only in whether they have been finished.
        await store.startRun({ runId: 'dead', model: 'test:model', options: {} });
        await store.startRun({ runId: 'live', model: 'test:model', options: {} });
        await store.tryClaim(rows[0] as number, 'dead');
        await store.tryClaim(rows[1] as number, 'dead');
        await store.tryClaim(rows[2] as number, 'live');

        equal(await store.releaseSettledRunClaims(), 0, 'nothing is released while both runs run');
        equal(await claimed(), 3, 'all three rows are still claimed');

        await store.finishRun('dead', 'interrupted');
        equal(await store.releaseSettledRunClaims(), 2, 'the ended run gives up both its rows');
        equal(await claimed(), 1, 'the live run keeps its row');
        equal(await store.releaseSettledRunClaims(), 0, 'a second sweep is a no-op');
      }),
    },
    {
      name: 'startAttempt allocates consecutive numbers per row',
      run: withRun(2, async ({ store, rows }, runId) => {
        const [first, second] = [rows[0] as number, rows[1] as number];
        const a = await store.startAttempt({ runId, rowNumber: first });
        const b = await store.startAttempt({ runId, rowNumber: first });
        const c = await store.startAttempt({ runId, rowNumber: second });
        equal(a.attemptNumber, 1, 'first attempt on a row');
        equal(b.attemptNumber, 2, 'second attempt on the same row');
        equal(c.attemptNumber, 1, 'attempt numbers are per row, not global');
        assert(a.attemptId !== b.attemptId, 'attempt ids must be distinct');
      }),
    },
    {
      name: 'startAttempt never issues a duplicate number under concurrency',
      run: withRun(1, async ({ store, rows }, runId) => {
        // The allocation has to be inside the write. Read-then-insert is safe
        // only while nothing can interleave, which is exactly what an async
        // interface stops guaranteeing.
        const rowNumber = rows[0] as number;
        const started = await Promise.all(
          Array.from({ length: 8 }, () => store.startAttempt({ runId, rowNumber })),
        );
        const numbers = started.map((s) => s.attemptNumber).sort((x, y) => x - y);
        equal(new Set(numbers).size, numbers.length, 'attempt numbers must be unique per row');
        equal(numbers.join(','), '1,2,3,4,5,6,7,8', 'and consecutive from one');
      }),
    },
    {
      name: 'setAttemptPaths accepts absolute paths without complaint (term 5)',
      run: withRun(1, async ({ store, rows }, runId) => {
        const { attemptId } = await store.startAttempt({ runId, rowNumber: rows[0] as number });
        await store.setAttemptPaths(attemptId, {
          responsePath: '/tmp/harness/00001_R-1_a01.response.json',
          stdoutPath: '/tmp/harness/00001_R-1_a01.stdout.log',
          stderrPath: '/tmp/harness/00001_R-1_a01.stderr.log',
        });
      }),
    },
    {
      name: 'failAttempt records a transient failure without failing the row',
      run: withRun(1, async ({ store, rows, claimed }, runId) => {
        // A failed attempt is not a failed row: the runner is about to retry it,
        // and it still owns the claim.
        const rowNumber = rows[0] as number;
        await store.tryClaim(rowNumber, runId);
        const { attemptId } = await store.startAttempt({ runId, rowNumber });
        await store.failAttempt(attemptId, new TransientFailure('timeout', 'too slow', 124));
        equal(await claimed(), 1, 'the row is still claimed by the run that is retrying it');
      }),
    },
    {
      name: 'recordInternalError releases only the rows it is given',
      run: withRun(3, async ({ store, rows, claimed }, runId) => {
        // "Every claimed row" would also fail the rows a concurrent process
        // happens to hold, which is how one broken run takes down another.
        const mine = rows[0] as number;
        await store.tryClaim(mine, runId);
        await store.tryClaim(rows[1] as number, 'some-other-run');
        await store.recordInternalError(runId, new Error('boom'), [mine]);
        equal(await claimed(), 1, 'the other run keeps its row and this run gives up its own');
      }),
    },
    {
      name: 'recordInternalError with no rows touches no row',
      run: withRun(2, async ({ store, rows, claimed }, runId) => {
        await store.tryClaim(rows[0] as number, runId);
        await store.recordInternalError(runId, new Error('boom'), []);
        equal(await claimed(), 1, 'an empty set updates nothing');
      }),
    },
    {
      name: 'a run can be started and finished',
      run: withRows(1, async ({ store }) => {
        await store.startRun({ runId: 'r1', model: 'test:model', options: { concurrency: 2 } });
        await store.finishRun('r1', 'completed');
      }),
    },
    {
      name: 'close is idempotent',
      run: async (): Promise<void> => {
        const { store } = await make(1);
        await store.close();
        await store.close();
      },
    },
  ];
}
