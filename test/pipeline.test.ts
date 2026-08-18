// The worker pool, driven end to end through `runTranslation` with the offline
// mock provider. No model, no cost, no network. The claim, the transactions and
// the attempt bookkeeping are the real ones.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { registerMockProvider } from '../src/contract/mock.ts';
import { hashInput } from '../src/contract/prompt.ts';
import { TransientFailure } from '../src/errors.ts';
import type { Fields, TranslationJob } from '../src/job.ts';
import { type RunEvent, type RunOptions, runTranslation } from '../src/pipeline/run.ts';
import { registerProvider } from '../src/provider/registry.ts';
import { type SqliteStore, sqliteStore } from '../src/store/sqlite.ts';
import type { StoreRecord } from '../src/store/types.ts';
import { scratchDir } from './helpers/fake-cli.ts';

registerMockProvider();

const job: TranslationJob = {
  id: 'test',
  sourceLang: 'English',
  targetLang: 'French',
  fields: [
    { key: 'name', label: 'Name', translate: true, required: true },
    { key: 'description', label: 'Description', translate: true, required: false },
  ],
  promptTemplate: 'DOMAIN GUIDANCE',
  validators: [],
};

function record(rowNumber: number): StoreRecord {
  const identifier = `X-${rowNumber}`;
  const source: Fields = {
    name: `Access control policy number ${rowNumber}`,
    description: `A description long enough to clear the length ratio guardrail, row ${rowNumber}.`,
  };
  return {
    rowNumber,
    identifier,
    source,
    seedSucceeded: false,
    inputHash: hashInput(identifier, source),
  };
}

interface Fixture {
  store: SqliteStore;
  options: RunOptions;
  dir: string;
}

async function withFixture<T>(rows: number, fn: (f: Fixture) => Promise<T>): Promise<T> {
  const scratch = scratchDir('pipeline');
  const workDir = join(scratch.dir, 'work');
  const store = sqliteStore(join(scratch.dir, 'registry.sqlite3'), { pathBase: scratch.dir });
  await store.initialize(Array.from({ length: rows }, (_, i) => record(i + 2)));
  try {
    return await fn({
      store,
      dir: scratch.dir,
      options: {
        cwd: scratch.dir,
        provider: 'mock',
        timeoutSeconds: 10,
        workDir,
        maxAttempts: 2,
        delaySeconds: 0,
      },
    });
  } finally {
    await store.close();
    scratch.remove();
  }
}

const rowsOf = (store: SqliteStore, sql: string): Record<string, unknown>[] =>
  store.db.prepare(sql).all() as Record<string, unknown>[];

const countWhere = (store: SqliteStore, where: string): number =>
  (store.db.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${where}`).get() as { c: number }).c;

describe('runTranslation', () => {
  test('translates a corpus and settles every row exactly once', async () => {
    await withFixture(6, async ({ store, options }) => {
      const candidates = await store.selectCandidates({});
      const summary = await runTranslation(store, job, candidates, options);

      assert.equal(summary.succeeded, 6);
      assert.equal(summary.failed, 0);
      const counts = await store.counts();
      assert.equal(counts.succeeded, 6);
      assert.equal(counts.running, 0);

      const byId = await store.translationsByIdentifier();
      assert.equal(byId.get('X-2')?.name, 'mock: Access control policy number 2');
    });
  });

  test('keeps the per-attempt evidence, which is the audit trail', async () => {
    await withFixture(2, async ({ store, options, dir }) => {
      await runTranslation(store, job, await store.selectCandidates({}), options);

      const attempts = rowsOf(store, 'SELECT * FROM attempts ORDER BY row_number');
      assert.equal(attempts.length, 2);
      for (const attempt of attempts) {
        assert.equal(attempt.outcome, 'succeeded');
        for (const key of ['response_path', 'stdout_path', 'stderr_path']) {
          const recorded = attempt[key] as string;
          assert.ok(recorded, `${key} must be recorded`);
          assert.ok(
            !recorded.startsWith(dir),
            `${key} is relativized by the store, not stored raw`,
          );
          assert.ok(existsSync(join(dir, recorded)), `${key} must point at a file that exists`);
        }
      }
      const response = attempts[0]?.response_path as string;
      assert.ok(JSON.parse(readFileSync(join(dir, response), 'utf8')).identifier);
    });
  });

  test('the run records how it was configured', async () => {
    await withFixture(4, async ({ store, options }) => {
      await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        concurrency: 3,
      });
      const run = store.db.prepare('SELECT * FROM runs').get() as {
        options_json: string;
        status: string;
        model: string;
      };
      assert.equal(JSON.parse(run.options_json).concurrency, 3);
      assert.equal(run.status, 'completed');
      assert.equal(run.model, 'mock:config-default');
    });
  });

  test('a row the job answers itself costs no attempt', async () => {
    await withFixture(3, async ({ store, options }) => {
      const answering: TranslationJob = {
        ...job,
        precomputed: (source) =>
          source.name === 'Access control policy number 3'
            ? {
                name: 'Politique connue',
                description: 'Description connue et suffisamment longue.',
              }
            : null,
      };
      const events: RunEvent[] = [];
      await runTranslation(store, answering, await store.selectCandidates({}), {
        ...options,
        onEvent: (e) => events.push(e),
      });

      assert.equal(
        rowsOf(store, 'SELECT * FROM attempts').length,
        2,
        'only two rows saw a provider',
      );
      const precomputed = events.filter((e) => e.kind === 'row-settled' && e.precomputed);
      assert.equal(precomputed.length, 1);
      const row = store.db.prepare('SELECT model FROM items WHERE row_number = 3').get() as {
        model: string;
      };
      assert.equal(row.model, 'precomputed', 'and the row says so, so it stays auditable');
    });
  });

  // `precomputed` is held to the identical contract a model answer faces, which
  // has to cut both ways: an answer it refuses fails the row, the way a model
  // answer refused by the same call fails the row. It used to kill the batch,
  // so one bad precomputed answer meant every later row was never attempted.
  test('a precomputed answer the contract refuses fails its row, not the batch', async () => {
    await withFixture(2, async ({ store, options }) => {
      const answering: TranslationJob = {
        ...job,
        // Answers the first row with nothing for a field the source has, which
        // is what `validateResponse` refuses. The second row is left to the
        // provider, so the run has somewhere to go after the failure.
        precomputed: (source) => (source.name === 'Access control policy number 2' ? {} : null),
      };
      const events: RunEvent[] = [];
      const summary = await runTranslation(store, answering, await store.selectCandidates({}), {
        ...options,
        onEvent: (e) => events.push(e),
      });

      assert.equal(summary.failed, 1);
      assert.equal(summary.succeeded, 1, 'the row behind it was still attempted');
      const counts = await store.counts();
      assert.equal(counts.failed, 1);
      assert.equal(counts.succeeded, 1);
      assert.equal(counts.running, 0, 'and nothing is left claimed');

      const run = store.db.prepare('SELECT status FROM runs').get() as { status: string };
      assert.equal(run.status, 'completed', 'a refused row is not a broken run');

      const failed = store.db
        .prepare('SELECT last_error, attempt_count FROM items WHERE row_number = 2')
        .get() as { last_error: string; attempt_count: number };
      assert.match(failed.last_error, /invalid_shape: Field 'name' needs a non-empty translation/);
      assert.equal(failed.attempt_count, 0, 'no attempt was ever started, and none is claimed');
      assert.equal(
        rowsOf(store, 'SELECT * FROM attempts').length,
        1,
        'retrying a pure function of the source would only spend the wait',
      );

      const settled = events.filter((e) => e.kind === 'row-settled');
      assert.deepEqual(
        settled.map((e) => [e.outcome, e.precomputed]),
        [
          ['failed', true],
          ['succeeded', false],
        ],
        'the failure is reported as the precomputed row it was',
      );
    });
  });
});

describe('the worker pool', () => {
  test('at concurrency 4 every row settles exactly once', async () => {
    await withFixture(20, async ({ store, options }) => {
      const candidates = await store.selectCandidates({});
      assert.equal(candidates.length, 20);

      const summary = await runTranslation(store, job, candidates, { ...options, concurrency: 4 });
      assert.equal(summary.succeeded + summary.review_required + summary.failed, 20);
      assert.equal(summary.failed, 0);

      const statuses = rowsOf(store, 'SELECT status, COUNT(*) AS c FROM items GROUP BY status');
      assert.equal(statuses.length, 1, 'one terminal status for the whole corpus');
      assert.equal(statuses[0]?.status, 'succeeded');
      assert.equal(statuses[0]?.c, 20);

      // Attempt numbering is per row, so a pool cannot make two rows share one
      // and cannot give one row two attempts it did not need.
      const attempts = rowsOf(
        store,
        'SELECT row_number, attempt_number FROM attempts ORDER BY row_number, attempt_number',
      );
      assert.equal(attempts.length, 20);
      assert.ok(attempts.every((a) => a.attempt_number === 1));
    });
  });

  test('concurrency 1 and concurrency 6 reach the same corpus state', async () => {
    const run = (concurrency: number) =>
      withFixture(12, async ({ store, options }) => {
        await runTranslation(store, job, await store.selectCandidates({}), {
          ...options,
          concurrency,
        });
        return rowsOf(
          store,
          'SELECT identifier, status, target_json FROM items ORDER BY row_number',
        );
      });
    assert.deepEqual(await run(6), await run(1), 'the pool changes throughput, not results');
  });

  test('an abort mid-run strands no row, and the rest resumes', async () => {
    await withFixture(40, async ({ store, options }) => {
      // A per-worker delay is what gives the abort somewhere to land: the mock
      // provider answers instantly, so without it all 40 rows would finish
      // before the signal arrived and the test would pass proving nothing.
      const controller = new AbortController();
      const paced = { ...options, delaySeconds: 0.02, concurrency: 4, signal: controller.signal };
      const timer = setTimeout(() => controller.abort(), 40);
      try {
        await runTranslation(store, job, await store.selectCandidates({}), paced);
      } finally {
        clearTimeout(timer);
      }

      assert.equal(
        countWhere(store, "status = 'running'"),
        0,
        'a stranded claim is invisible to every selection filter, so a resume would skip it',
      );
      const pending = countWhere(store, "status = 'pending'");
      assert.ok(pending > 0, 'the abort actually stopped the run');
      assert.equal(pending + countWhere(store, "status = 'succeeded'"), 40);

      const run = store.db.prepare('SELECT status FROM runs ORDER BY rowid DESC LIMIT 1').get() as {
        status: string;
      };
      assert.equal(run.status, 'interrupted', 'the run says why it stopped');

      const resumed = await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        concurrency: 4,
      });
      assert.equal(resumed.succeeded, pending);
      assert.equal(countWhere(store, "status = 'succeeded'"), 40);
    });
  });

  test('a signal already aborted stops the run before it claims anything', async () => {
    await withFixture(5, async ({ store, options }) => {
      const summary = await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        signal: AbortSignal.abort(),
      });
      assert.deepEqual(summary, { succeeded: 0, review_required: 0, failed: 0 });
      assert.equal(countWhere(store, "status = 'running'"), 0);
      assert.equal(countWhere(store, "status = 'pending'"), 5);
    });
  });

  test('no path out of a run leaves a row running', async () => {
    // The invariant, stated once and checked across every exit: completed,
    // aborted, quota-paused and fatal.
    for (const scenario of ['completed', 'aborted', 'quota', 'fatal'] as const) {
      await withFixture(8, async ({ store, options }) => {
        const candidates = await store.selectCandidates({});
        assert.equal(candidates.length, 8, 'the scenario must actually have rows to claim');
        const controller = new AbortController();
        const timer = scenario === 'aborted' ? setTimeout(() => controller.abort(), 20) : undefined;
        try {
          await runTranslation(store, job, candidates, {
            ...options,
            concurrency: 2,
            delaySeconds: scenario === 'aborted' ? 0.02 : 0,
            signal: controller.signal,
            provider:
              scenario === 'quota'
                ? 'always-quota'
                : scenario === 'fatal'
                  ? 'always-fatal'
                  : 'mock',
          }).catch(() => {}); // `fatal` rethrows; the invariant holds regardless.
        } finally {
          clearTimeout(timer);
        }
        assert.equal(
          countWhere(store, "status = 'running'"),
          0,
          `a ${scenario} run must leave no row claimed`,
        );
        assert.ok(
          rowsOf(store, 'SELECT * FROM runs').length > 0,
          `a ${scenario} run must have been recorded`,
        );
      });
    }
  });
});

describe('failure handling', () => {
  test('a quota refusal pauses the batch instead of burning through it', async () => {
    await withFixture(10, async ({ store, options }) => {
      const events: RunEvent[] = [];
      const summary = await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        provider: 'always-quota',
        concurrency: 1,
        onEvent: (e) => events.push(e),
      });

      assert.equal(summary.failed, 1, 'exactly one row pays for the discovery');
      assert.equal(countWhere(store, "status = 'pending'"), 9, 'the rest are untouched');
      assert.ok(events.some((e) => e.kind === 'quota-paused'));

      const run = store.db.prepare('SELECT status FROM runs').get() as { status: string };
      assert.equal(run.status, 'paused_quota');

      // And it does not retry: a quota refusal costs the same refusal again.
      assert.equal(rowsOf(store, 'SELECT * FROM attempts').length, 1);
    });
  });

  test('a transient failure retries up to the attempt budget, then fails the row', async () => {
    await withFixture(1, async ({ store, options }) => {
      const events: RunEvent[] = [];
      const summary = await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        provider: 'always-transient',
        maxAttempts: 3,
        onEvent: (e) => events.push(e),
      });

      assert.equal(summary.failed, 1);
      const attempts = rowsOf(store, 'SELECT attempt_number FROM attempts ORDER BY attempt_number');
      assert.deepEqual(
        attempts.map((a) => a.attempt_number),
        [1, 2, 3],
        'the budget is spent, and the numbering is consecutive',
      );
      const retries = events.filter((e) => e.kind === 'row-retrying');
      assert.equal(retries.length, 2, 'a retry is announced between attempts, not after the last');

      const item = store.db.prepare('SELECT * FROM items').get() as {
        status: string;
        attempt_count: number;
        last_error: string;
      };
      assert.equal(item.status, 'failed');
      assert.equal(item.attempt_count, 3, 'the row records what it cost');
      assert.match(item.last_error, /^exit_code: /);
    });
  });

  test('a non-transient error stops the run and is reported to the caller', async () => {
    await withFixture(6, async ({ store, options }) => {
      await assert.rejects(
        runTranslation(store, job, await store.selectCandidates({}), {
          ...options,
          provider: 'always-fatal',
          concurrency: 2,
        }),
        /the disk caught fire/,
      );
      const run = store.db.prepare('SELECT status FROM runs').get() as { status: string };
      assert.equal(run.status, 'failed');
      assert.equal(countWhere(store, "status = 'running'"), 0);
      assert.ok(
        countWhere(store, "status = 'failed'") > 0,
        'the rows it owned are recorded failed',
      );
    });
  });

  test('a store that rejects is a run failure, never a retried row', async () => {
    // Contract term 3. A row does not become translatable because you tried it
    // again after the disk filled up.
    await withFixture(4, async ({ store, options }) => {
      const candidates = await store.selectCandidates({});
      let calls = 0;
      const failing = {
        ...store,
        commitSuccess: async () => {
          calls++;
          throw new Error('registry is read-only');
        },
      };
      await assert.rejects(
        runTranslation(failing, job, candidates, { ...options, concurrency: 1 }),
        /registry is read-only/,
      );
      assert.equal(calls, 1, 'the run stops at the first store failure rather than retrying it');
    });
  });
});

describe('progress events', () => {
  test('report settled count, not cursor position', async () => {
    await withFixture(10, async ({ store, options }) => {
      // With workers, rows settle out of order, and a position number would
      // claim progress the run has not made.
      const settled: number[] = [];
      await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        concurrency: 4,
        onEvent: (e) => {
          if (e.kind === 'row-settled') settled.push(e.completed);
        },
      });
      assert.deepEqual(settled, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  test('carry what a caller needs to render a line', async () => {
    await withFixture(2, async ({ store, options }) => {
      const events: RunEvent[] = [];
      await runTranslation(store, job, await store.selectCandidates({}), {
        ...options,
        onEvent: (e) => events.push(e),
      });
      const first = events[0];
      assert.equal(first?.kind, 'row-settled');
      if (first?.kind === 'row-settled') {
        assert.equal(first.identifier, 'X-2');
        assert.equal(first.outcome, 'succeeded');
        assert.equal(first.precomputed, false);
        assert.equal(first.total, 2);
      }
    });
  });

  test('a run with no reporter is exactly as valid', async () => {
    await withFixture(3, async ({ store, options }) => {
      const summary = await runTranslation(store, job, await store.selectCandidates({}), options);
      assert.equal(summary.succeeded, 3);
    });
  });
});

// Providers that fail in specific, useful ways. Registered once; none of them
// launches anything.
registerProvider('always-quota', async () => {
  throw new TransientFailure('quota', 'You have hit your usage limit.', 1);
});
registerProvider('always-transient', async () => {
  throw new TransientFailure('exit_code', 'the agent fell over', 1);
});
registerProvider('always-fatal', async () => {
  throw new Error('the disk caught fire');
});
