// A review pass, driven end to end through `runReview` with the offline
// reviewer. No model, no cost, no network. The claim, the transactions, the
// attempt bookkeeping and the pass ledger are the real ones.
//
// Two things get more attention than the rest, because they are what this
// lifecycle adds to the runner it shares with translation: **the job and the
// pass are different objects** (a run is created once and executed many times,
// so its status is a statement about its rows rather than about a process), and
// **the binding is fixed on first execution** (a run records one provider, and
// a run answered under two of them would store a claim about itself that is
// false for half its rows).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import type { Fields } from '../src/job.ts';
import { registerProvider } from '../src/provider/registry.ts';
import { buildConsistency, promptEvidence } from '../src/review/consistency.ts';
import { initializeReview, type ReviewSourceRow } from '../src/review/init.ts';
import type { ReviewJob } from '../src/review/job.ts';
import {
  invokeReviewMock,
  REVIEW_MOCK_PROVIDER_NAME,
  registerReviewMockProvider,
} from '../src/review/mock.ts';
import { buildReviewPrompt } from '../src/review/prompt.ts';
import { type ReviewRunOptions, runReview } from '../src/review/run.ts';
import { buildReviewSchema } from '../src/review/schema.ts';
import type { ReviewStore } from '../src/store/review-types.ts';
import { type SqliteStore, sqliteStore } from '../src/store/sqlite.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { TEST_JOB } from './helpers/job.ts';
import { GOLDEN_CORPUS, REVIEW_TEST_JOB } from './helpers/review-job.ts';

registerReviewMockProvider();

/** Every prompt the runner composed, in the order the providers saw them. */
const captured: string[] = [];
const CAPTURING = 'review-capture';
registerProvider(CAPTURING, async (args) => {
  captured.push(args.prompt);
  return invokeReviewMock(args);
});

registerProvider('review-quota', async () => {
  throw new TransientFailure('quota', 'reviewer quota reached');
});
registerProvider('review-broken', async () => {
  throw new TransientFailure('invalid_json', 'not JSON');
});

/** The four-row golden corpus as init takes it: accepted, numbered from one. */
function corpus(): ReviewSourceRow[] {
  return GOLDEN_CORPUS.map((row, i) => ({
    rowNumber: i + 1,
    identifier: row.identifier,
    inputHash: `in-${i + 1}`,
    source: { ...row.source },
    target: { ...row.target } as Fields,
    status: 'succeeded' as const,
  }));
}

/** The same corpus with one target the offline reviewer will object to. */
function corpusWithDefect(): ReviewSourceRow[] {
  const rows = corpus();
  (rows[2] as { target: Fields }).target.name = 'Registres  d audit';
  return rows;
}

interface Fixture {
  store: SqliteStore;
  review: ReviewStore;
  runId: string;
  job: ReviewJob;
  options: ReviewRunOptions;
  dir: string;
}

async function withRun<T>(
  fn: (f: Fixture) => Promise<T>,
  rows: ReviewSourceRow[] = corpus(),
  job: ReviewJob = REVIEW_TEST_JOB,
): Promise<T> {
  const scratch = scratchDir('review-run');
  const store = sqliteStore(join(scratch.dir, 'registry.sqlite3'), { pathBase: scratch.dir });
  const init = await initializeReview(store.review, { job, corpus: rows });
  try {
    return await fn({
      store,
      review: store.review(init.runId),
      runId: init.runId,
      job,
      dir: scratch.dir,
      options: {
        cwd: scratch.dir,
        provider: REVIEW_MOCK_PROVIDER_NAME,
        timeoutSeconds: 10,
        workDir: join(scratch.dir, 'work'),
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

describe('runReview', () => {
  test('reviews every pending row and completes the run', async () => {
    await withRun(async ({ review, job, options }) => {
      const summary = await runReview(review, job, await review.selectCandidates({}), options);

      assert.deepEqual(summary, { pass: 4, change_proposed: 0, failed: 0 });
      const counts = await review.counts();
      assert.equal(counts.pass, 4);
      assert.equal(counts.pending, 0);
      assert.equal(counts.running, 0);

      const run = await review.run();
      assert.equal(run?.status, 'completed');
      assert.ok(run?.finishedAt, 'a completed job records when it finished');
    });
  });

  test('records the verdict, the proposal, the grades and the issues', async () => {
    await withRun(async ({ review, job, options }) => {
      const summary = await runReview(review, job, await review.selectCandidates({}), options);
      assert.deepEqual(summary, { pass: 3, change_proposed: 1, failed: 0 });

      const snapshot = await review.snapshot();
      const flagged = snapshot.find((row) => row.identifier === 'AU-1');
      assert.equal(flagged?.outcome, 'change_proposed');
      assert.equal(flagged?.target.name, 'Registres  d audit', 'the snapshot is what was reviewed');
      assert.equal(flagged?.proposals?.name, 'Registres d audit');
      assert.equal(flagged?.proposals?.description, null, 'null is how a field is left alone');
      assert.equal(flagged?.severity, 'minor');
      assert.equal(flagged?.confidence, 'high');
      assert.deepEqual(flagged?.issues, ['name: stray whitespace']);

      const clean = snapshot.find((row) => row.identifier === 'AC-1');
      assert.equal(clean?.outcome, 'pass');
      assert.equal(clean?.severity, null, 'a pass grades nothing, because it found nothing');
    }, corpusWithDefect());
  });

  // The evidence comes from the run's own snapshot rather than from a file init
  // left behind, so this also asserts that the analysis survives the round trip
  // through the store byte for byte.
  test('composes the contract prompt, consistency evidence and all', async () => {
    await withRun(async ({ review, job, options }) => {
      captured.length = 0;
      await runReview(review, job, await review.selectCandidates({}), {
        ...options,
        provider: CAPTURING,
      });

      assert.equal(captured.length, 4);
      const analysis = buildConsistency(job, await review.snapshot());
      const first = GOLDEN_CORPUS[0];
      assert.equal(
        captured[0],
        buildReviewPrompt(
          job,
          first.identifier,
          first.source,
          first.target as Fields,
          promptEvidence(analysis, first.source),
        ),
      );
      assert.match(captured[0] as string, /CONSISTENCY EVIDENCE/);
    });
  });

  test('keeps the per-attempt evidence, and writes the schema beside the run', async () => {
    await withRun(async ({ store, review, job, options, runId, dir }) => {
      await runReview(review, job, await review.selectCandidates({}), options);

      const attempts = rowsOf(store, 'SELECT * FROM review_attempts ORDER BY row_number');
      assert.equal(attempts.length, 4);
      for (const attempt of attempts) {
        assert.equal(attempt.outcome, 'pass');
        assert.ok(attempt.pass_id, 'an attempt names the pass that made it, not the job');
        for (const key of ['response_path', 'stdout_path', 'stderr_path']) {
          const recorded = attempt[key] as string;
          assert.ok(recorded, `${key} must be recorded`);
          assert.ok(!recorded.startsWith(dir), `${key} is relativized by the store`);
          assert.ok(existsSync(join(dir, recorded)), `${key} must point at a file that exists`);
        }
      }

      const schemaPath = join(dir, 'work', 'review', runId, 'review-response.schema.json');
      assert.equal(readFileSync(schemaPath, 'utf8'), buildReviewSchema(job).text);
    });
  });

  test('resumes, and each execution is a pass of its own', async () => {
    await withRun(async ({ store, review, job, options }) => {
      const first = await runReview(review, job, await review.selectCandidates({ limit: 2 }), {
        ...options,
        model: 'mock-1',
      });
      assert.equal(first.pass, 2);
      const open = await review.run();
      assert.equal(open?.status, 'running', 'the job stays open while rows remain');
      assert.equal(open?.finishedAt, null);

      const second = await runReview(review, job, await review.selectCandidates({}), options);
      assert.equal(second.pass, 2);
      assert.equal((await review.run())?.status, 'completed');

      const passes = rowsOf(store, 'SELECT * FROM review_passes ORDER BY rowid');
      assert.equal(passes.length, 2, 'two executions of one job are two passes');
      assert.deepEqual(
        passes.map((p) => p.status),
        ['completed', 'completed'],
      );
      assert.deepEqual(
        passes.map((p) => p.model),
        ['review-mock:mock-1', 'review-mock:mock-1'],
        'the second pass inherited the binding rather than restating it',
      );
    });
  });

  test('rows the job answers itself never reach a pass', async () => {
    const job: ReviewJob = {
      ...REVIEW_TEST_JOB,
      translation: {
        ...TEST_JOB,
        precomputed: (source) =>
          source.name === 'Audit Records' ? { name: 'Registres d audit' } : null,
      },
    };
    await withRun(
      async ({ store, review, options }) => {
        const candidates = await review.selectCandidates({});
        assert.equal(candidates.length, 2, 'the two settled rows are not candidates');

        const summary = await runReview(review, job, candidates, options);
        assert.equal(summary.pass, 2);
        assert.equal((await review.counts()).pass, 4, 'all four rows have a verdict');
        assert.equal((await review.run())?.status, 'completed');
        assert.equal(
          rowsOf(store, 'SELECT * FROM review_attempts').length,
          2,
          'a row settled by construction costs no attempt',
        );
      },
      corpus(),
      job,
    );
  });

  test('refuses a run that was never opened', async () => {
    await withRun(async ({ store, job, options }) => {
      await assert.rejects(
        runReview(store.review('0'.repeat(32)), job, [], options),
        /Unknown review run/,
      );
    });
  });
});

describe('the provider binding', () => {
  test('is fixed by the first pass and reported by the run', async () => {
    await withRun(async ({ review, job, options }) => {
      assert.equal((await review.run())?.provider, null, 'init left it unbound');
      await runReview(review, job, await review.selectCandidates({ limit: 1 }), {
        ...options,
        model: 'mock-1',
      });
      const run = await review.run();
      assert.equal(run?.provider, REVIEW_MOCK_PROVIDER_NAME);
      assert.equal(run?.model, 'mock-1');
    });
  });

  test('refuses a switch rather than quietly running what it is bound to', async () => {
    await withRun(async ({ review, job, options }) => {
      await runReview(review, job, await review.selectCandidates({ limit: 1 }), {
        ...options,
        model: 'mock-1',
      });
      await assert.rejects(
        runReview(review, job, [], { ...options, provider: 'somewhere-else' }),
        /bound to provider review-mock/,
      );
      await assert.rejects(
        runReview(review, job, [], { ...options, model: 'mock-2' }),
        /bound to model mock-1/,
      );
      // Passing the binding back is not a switch, and neither is omitting it.
      await runReview(review, job, [], { ...options, model: 'mock-1' });
      await runReview(review, job, await review.selectCandidates({}), options);
      assert.equal((await review.run())?.status, 'completed');
    });
  });
});

describe('how a pass ends', () => {
  test('a quota refusal pauses the pass and leaves the job open', async () => {
    await withRun(async ({ store, review, job, options }) => {
      const summary = await runReview(review, job, await review.selectCandidates({}), {
        ...options,
        provider: 'review-quota',
      });

      assert.equal(
        summary.failed,
        1,
        'the row that hit the wall is failed; the rest are untouched',
      );
      assert.equal((await review.counts()).pending, 3);
      assert.equal((await review.run())?.status, 'running', 'the job is open, not finished');
      assert.equal(rowsOf(store, 'SELECT * FROM review_passes')[0]?.status, 'paused_quota');
    });
  });

  test('an abort interrupts the job and releases what it was holding', async () => {
    await withRun(async ({ review, job, options }) => {
      const controller = new AbortController();
      controller.abort();
      const summary = await runReview(review, job, await review.selectCandidates({}), {
        ...options,
        signal: controller.signal,
      });

      assert.deepEqual(summary, { pass: 0, change_proposed: 0, failed: 0 });
      const counts = await review.counts();
      assert.equal(counts.pending, 4);
      assert.equal(counts.running, 0, 'nothing is left claimed');
      assert.equal((await review.run())?.status, 'interrupted');
    });
  });

  // `completed` means no row is still waiting, not that every row got a verdict.
  // A failed row is a recorded answer a human can see and act on, and
  // `retryFailed` is how they act on it; a run one stubborn row could block
  // forever would be a worse contract than one that says what happened.
  test('rows that exhaust their attempts fail, and the job still completes', async () => {
    await withRun(async ({ review, job, options }) => {
      const summary = await runReview(review, job, await review.selectCandidates({}), {
        ...options,
        provider: 'review-broken',
        concurrency: 4,
      });

      assert.equal(summary.failed, 4);
      const counts = await review.counts();
      assert.equal(counts.failed, 4);
      assert.equal(counts.pending, 0);
      assert.equal((await review.run())?.status, 'completed');
    });
  });
});

describe('chaining onto what a pass produced', () => {
  test('a completed run is what stage two snapshots', async () => {
    await withRun(async ({ store, review, job, options, runId }) => {
      await runReview(review, job, await review.selectCandidates({}), options);
      assert.equal((await review.run())?.status, 'completed');

      const stage2 = await initializeReview(store.review, {
        job,
        corpus: corpusWithDefect(),
        baseRunId: runId,
      });
      assert.notEqual(stage2.runId, runId);

      const snapshot = await store.review(stage2.runId).snapshot();
      const corrected = snapshot.find((row) => row.identifier === 'AU-1');
      assert.equal(
        corrected?.target.name,
        'Registres d audit',
        'stage two reviews the proposal stage one made, not the corpus it was made against',
      );
      const untouched = snapshot.find((row) => row.identifier === 'AC-1');
      assert.equal(untouched?.target.name, "Politique de controle d'acces");
    }, corpusWithDefect());
  });
});
