// Opening a review run.
//
// Most of this file is about one property, from as many sides as it can be
// approached from: **the run id is a function of every input and of nothing
// else.** Each input gets a case that moves it and asserts the id moved; the
// things that are not inputs - the row order the caller iterated in, the
// provider binding, `allowPartial` - get a case that moves them and asserts the
// id did not. A derived identity is only worth having if both halves hold.
//
// The other half is the store side: what init writes, what it refuses, and what
// it does the second time it is called with inputs it has already seen.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Fields, TranslationJob } from '../src/job.ts';
import { resolveRunOutput } from '../src/review/chain.ts';
import { buildConsistency } from '../src/review/consistency.ts';
import {
  deriveReviewRun,
  initializeReview,
  type ReviewSourceRow,
  settledByConstruction,
} from '../src/review/init.ts';
import type { ReviewJob } from '../src/review/job.ts';
import type { ReviewItem } from '../src/store/review-types.ts';
import { type SqliteStore, sqliteStore } from '../src/store/sqlite.ts';
import { TEST_JOB } from './helpers/job.ts';
import { GOLDEN_CORPUS, REVIEW_TEST_JOB } from './helpers/review-job.ts';

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

const idOf = (job: ReviewJob, rows = corpus(), profile: string | null = null): string =>
  deriveReviewRun({ job, corpus: rows, profile }).runId;

const BASE = idOf(REVIEW_TEST_JOB);

describe('the derived run id', () => {
  test('is 32 lowercase hex characters', () => {
    assert.match(BASE, /^[0-9a-f]{32}$/);
  });

  test('is the same for the same inputs, which is what makes init idempotent', () => {
    assert.equal(idOf(REVIEW_TEST_JOB), BASE);
  });

  test('does not depend on the order the caller iterated the corpus in', () => {
    const shuffled = [corpus()[2], corpus()[0], corpus()[3], corpus()[1]] as ReviewSourceRow[];
    assert.equal(idOf(REVIEW_TEST_JOB, shuffled), BASE);
  });

  test('moves when the profile does, and an unbound run is its own run', () => {
    const bound = idOf(REVIEW_TEST_JOB, corpus(), 'sonnet-5');
    assert.notEqual(bound, BASE);
    assert.notEqual(bound, idOf(REVIEW_TEST_JOB, corpus(), 'opus-5'));
  });

  test('moves when the guidance does', () => {
    assert.notEqual(idOf({ ...REVIEW_TEST_JOB, promptTemplate: 'OTHER GUIDANCE' }), BASE);
  });

  test('moves when the terminology does, and having none is not having an empty one', () => {
    const empty = idOf({ ...REVIEW_TEST_JOB, terminology: '' });
    const some = idOf({ ...REVIEW_TEST_JOB, terminology: 'policy -> politique\n' });
    assert.equal(empty, BASE, 'an empty terminology block is the same as no block');
    assert.notEqual(some, BASE);
  });

  test('moves when the response schema does', () => {
    assert.notEqual(idOf({ ...REVIEW_TEST_JOB, severityLevels: ['low', 'high'] }), BASE);
    assert.notEqual(idOf({ ...REVIEW_TEST_JOB, reviewFields: ['name'] }), BASE);
  });

  test('moves when one row of the corpus does', () => {
    const edited = corpus();
    (edited[1] as ReviewSourceRow & { target: Fields }).target.name = 'Autre politique';
    assert.notEqual(idOf(REVIEW_TEST_JOB, edited), BASE);
  });

  test('moves when a row is withheld, so a filtered corpus is a different run', () => {
    assert.notEqual(idOf(REVIEW_TEST_JOB, corpus().slice(0, 3)), BASE);
  });

  test('separates the monolingual pass from the bilingual one', () => {
    assert.notEqual(idOf({ ...REVIEW_TEST_JOB, showSource: false }), BASE);
  });

  test('moves when the run chains onto a different base', () => {
    const rows = corpus();
    const chained = deriveReviewRun({
      job: REVIEW_TEST_JOB,
      corpus: rows,
      baseRunId: 'a'.repeat(32),
    }).runId;
    assert.notEqual(chained, BASE);
    assert.notEqual(
      chained,
      deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: rows, baseRunId: 'b'.repeat(32) }).runId,
    );
  });

  // The contract term step 8 handed over: the digest is appended rather than
  // joined, so an absent bag adds nothing at all. Joining an empty string would
  // add a separator and rename every run id derived before `extraInputs`
  // existed - a mechanism a host can decline to use must cost the decliners
  // nothing, which is exactly `promptSalt`'s guarantee on the translate side.
  test('is unchanged by an absent or empty extraInputs, and moves for a populated one', () => {
    assert.equal(idOf({ ...REVIEW_TEST_JOB, extraInputs: {} }), BASE);
    const withTermbase = idOf({ ...REVIEW_TEST_JOB, extraInputs: { termbase: 'abc' } });
    assert.notEqual(withTermbase, BASE);
    assert.notEqual(withTermbase, idOf({ ...REVIEW_TEST_JOB, extraInputs: { termbase: 'abd' } }));
    assert.notEqual(withTermbase, idOf({ ...REVIEW_TEST_JOB, extraInputs: { style: 'abc' } }));
  });
});

describe('what the run id was derived from', () => {
  test('is reported by name, and names the six the store migration maps onto', () => {
    const { inputs } = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus() });
    assert.deepEqual(Object.keys(inputs).sort(), [
      'analysisInput',
      'analysisOutput',
      'prompt',
      'schema',
      'snapshot',
      'terminology',
    ]);
    for (const value of Object.values(inputs)) assert.match(value, /^[0-9a-f]{64}$/);
  });

  test('carries `extra` only when the job declares host inputs', () => {
    const bare = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus() });
    assert.equal('extra' in bare.inputs, false);
    const withExtra = deriveReviewRun({
      job: { ...REVIEW_TEST_JOB, extraInputs: { termbase: 'abc' } },
      corpus: corpus(),
    });
    assert.equal(withExtra.inputs.extra?.length, 64);
  });

  // The analysis reads the rows the snapshot hash was taken over, so the two are
  // the same value. Kept as two names because the id reserves a slot for an
  // analysis over something else; collapsing them would move every id.
  test("the analysis's input hash is the snapshot hash", () => {
    const { inputs, snapshotHash } = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus() });
    assert.equal(inputs.analysisInput, snapshotHash);
    assert.equal(inputs.snapshot, snapshotHash);
  });
});

describe('the snapshot', () => {
  test('carries every row in row order, whatever order it arrived in', () => {
    const { items } = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus().reverse() });
    assert.deepEqual(
      items.map((i) => i.rowNumber),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      items.map((i) => i.identifier),
      ['AC-1', 'AC-2', 'AU-1', 'AU-2'],
    );
  });

  test('reproduces its own analysis, which is why no file is written', () => {
    const derived = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus() });
    const again = buildConsistency(REVIEW_TEST_JOB, derived.items);
    assert.equal(again.hash, derived.analysis.hash);
    assert.equal(again.text, derived.analysis.text);
  });

  test('stores a row with no target as an empty object and hashes it as the empty string', () => {
    const rows = corpus();
    (rows[0] as { target: Fields | null }).target = null;
    const { items } = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: rows });
    assert.deepEqual(items[0]?.target, {});
    // sha256 of the empty string, which is what an absent target hashes to and
    // is deliberately not the hash of `{}`. Published run ids were derived this
    // way; harmonizing the two would rename all of them.
    assert.equal(
      items[0]?.targetHash,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('gives every row the evidence hash of what the analysis found about it', () => {
    const { items } = deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: corpus() });
    // AC-1 and AC-2 share a source name rendered two ways, so both carry
    // evidence; AU-1 has nothing to report and hashes the empty object, and two
    // rows with nothing to report agree.
    assert.notEqual(items[0]?.evidenceHash, items[2]?.evidenceHash);
    assert.equal(items[0]?.evidenceHash, items[1]?.evidenceHash);
  });

  test('refuses a corpus that cannot be a corpus', () => {
    assert.throws(() => deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: [] }), /No corpus/);
    const dupeRow = corpus();
    (dupeRow[1] as { rowNumber: number }).rowNumber = 1;
    assert.throws(
      () => deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: dupeRow }),
      /two rows numbered 1/,
    );
    const dupeId = corpus();
    (dupeId[1] as { identifier: string }).identifier = 'AC-1';
    assert.throws(
      () => deriveReviewRun({ job: REVIEW_TEST_JOB, corpus: dupeId }),
      /two rows identified 'AC-1'/,
    );
  });
});

describe('settledByConstruction', () => {
  const answering = (answer: Fields | null): TranslationJob => ({
    ...TEST_JOB,
    precomputed: () => answer,
  });

  test('is false for a job that answers nothing', () => {
    assert.equal(settledByConstruction(TEST_JOB, { name: 'a' }, { name: 'a' }), false);
    assert.equal(settledByConstruction(answering(null), { name: 'a' }, { name: 'a' }), false);
  });

  test('is true only when the corpus carries exactly the answer', () => {
    const job = answering({ name: 'Fixe' });
    assert.equal(settledByConstruction(job, { name: 'a' }, { name: 'Fixe' }), true);
    assert.equal(settledByConstruction(job, { name: 'a' }, { name: 'Fixe ' }), false);
    assert.equal(settledByConstruction(job, { name: 'a' }, {}), false);
    assert.equal(settledByConstruction(job, { name: 'a' }, null), false);
  });

  test('seeds those rows pass, and counts them', async () => {
    const job: ReviewJob = {
      ...REVIEW_TEST_JOB,
      translation: {
        ...TEST_JOB,
        precomputed: (source) => (source.name === 'Audit Records' ? { name: 'Registres' } : null),
      },
    };
    const rows = corpus();
    (rows[2] as { target: Fields }).target.name = 'Registres';
    const derived = deriveReviewRun({ job, corpus: rows });
    assert.equal(derived.settledCount, 1);
    assert.deepEqual(
      derived.items.map((i) => Boolean(i.settled)),
      [false, false, true, false],
    );

    const store = sqliteStore(':memory:');
    const result = await initializeReview(store.review, { job, corpus: rows });
    const snapshot = await store.review(result.runId).snapshot();
    assert.deepEqual(
      snapshot.map((i) => i.outcome),
      ['pending', 'pending', 'pass', 'pending'],
    );
    await store.close();
  });
});

/** A registry with the golden corpus initialized as a review run. */
async function initialized(
  overrides: Partial<Parameters<typeof initializeReview>[1]> = {},
): Promise<[SqliteStore, Awaited<ReturnType<typeof initializeReview>>]> {
  const store = sqliteStore(':memory:');
  const result = await initializeReview(store.review, {
    job: REVIEW_TEST_JOB,
    corpus: corpus(),
    ...overrides,
  });
  return [store, result];
}

describe('initializeReview', () => {
  test('writes the run and every one of its rows', async () => {
    const [store, result] = await initialized();
    assert.equal(result.created, true);
    assert.equal(result.status, 'initialized');
    assert.equal(result.itemCount, 4);
    assert.equal(result.runId, BASE);
    const review = store.review(result.runId);
    assert.equal((await review.snapshot()).length, 4);
    assert.deepEqual((await review.run())?.inputs, result.inputs);
    await store.close();
  });

  test('a second call on unchanged inputs returns the first run rather than rebuilding it', async () => {
    const [store, first] = await initialized();
    const second = await initializeReview(store.review, {
      job: REVIEW_TEST_JOB,
      corpus: corpus(),
    });
    assert.equal(second.runId, first.runId);
    assert.equal(second.created, false);
    assert.equal((await store.review(first.runId).snapshot()).length, 4);
    await store.close();
  });

  // Reported from the store rather than echoed back, because on `created: false`
  // the binding that means anything is the one the *first* call recorded. Echoing
  // the arguments would quietly claim this call's profile was in the id.
  test('reports the binding the run actually holds, not the one this call passed', async () => {
    const [store, first] = await initialized({
      profile: 'sonnet-5',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    assert.equal(first.provider, 'claude');
    const second = await initializeReview(store.review, {
      job: REVIEW_TEST_JOB,
      corpus: corpus(),
      profile: 'sonnet-5',
      provider: 'codex',
      model: 'gpt-5',
    });
    assert.equal(second.created, false);
    assert.equal(second.provider, 'claude');
    assert.equal(second.model, 'claude-sonnet-5');
    await store.close();
  });

  test('records how the run was configured, and the caller cannot overwrite that', async () => {
    const [store, result] = await initialized({
      options: { note: 'stage one', showSource: 'lies' },
    });
    const options = (await store.review(result.runId).run())?.options;
    assert.equal(options?.note, 'stage one');
    assert.equal(options?.showSource, true);
    assert.equal(options?.jobId, 'test-review');
    assert.equal(options?.allowPartial, false);
    assert.deepEqual(options?.reviewFields, ['name', 'description']);
    await store.close();
  });

  test('opens the store at the derived id, and closes nothing', async () => {
    const store = sqliteStore(':memory:');
    const asked: string[] = [];
    const result = await initializeReview(
      (runId) => {
        asked.push(runId);
        return store.review(runId);
      },
      { job: REVIEW_TEST_JOB, corpus: corpus() },
    );
    assert.deepEqual(asked, [result.runId]);
    // The shipped provider hands back stores over one shared connection, so an
    // init that closed the store it opened would close the caller's registry.
    assert.equal((await store.counts()).pending, 0);
    await store.close();
  });
});

describe('the accepted-corpus rule', () => {
  test('refuses a corpus that is not fully accepted, and says what is not', async () => {
    const rows = corpus();
    (rows[1] as { status: string }).status = 'pending';
    (rows[3] as { status: string }).status = 'review_required';
    const store = sqliteStore(':memory:');
    await assert.rejects(
      initializeReview(store.review, { job: REVIEW_TEST_JOB, corpus: rows }),
      /fully accepted corpus; not accepted: pending=1, review_required=1/,
    );
    await store.close();
  });

  test('allowPartial lets it through and leaves the run visibly partial', async () => {
    const rows = corpus();
    (rows[1] as { status: string }).status = 'pending';
    const [store, result] = await initialized({ corpus: rows, allowPartial: true });
    assert.equal(result.created, true);
    assert.equal((await store.review(result.runId).run())?.options.allowPartial, true);
    await store.close();
  });

  // It is not an id input and does not need to be: a row with no answer
  // snapshots differently from the same row once it has one, so the two corpora
  // already derive two ids.
  test('allowPartial does not change the run id', async () => {
    const [store, result] = await initialized({ allowPartial: true });
    assert.equal(result.runId, BASE);
    await store.close();
  });
});

describe('chaining', () => {
  /** A completed run whose reviewer proposed a rewrite on AC-1's name. */
  async function completedBase(store: SqliteStore): Promise<string> {
    const result = await initializeReview(store.review, {
      job: REVIEW_TEST_JOB,
      corpus: corpus(),
      profile: 'stage-one',
    });
    const review = store.review(result.runId);
    await review.startRun({ runId: 'pass-1', model: 'test', options: {} });
    const claimed = await review.tryClaim(1, 'pass-1');
    assert.ok(claimed);
    const attempt = await review.startAttempt({ rowNumber: 1, runId: 'pass-1' });
    await review.commitVerdict({
      attemptId: attempt.attemptId,
      duration: 0,
      exitCode: 0,
      rowNumber: 1,
      verdict: 'change_proposed',
      severity: 'minor',
      confidence: 'high',
      proposals: { name: "Politique d'acces", description: null },
      issues: ['wording'],
      attemptNumber: attempt.attemptNumber,
    });
    await review.setRunStatus('completed');
    return result.runId;
  }

  test('refuses a base that does not exist', async () => {
    const store = sqliteStore(':memory:');
    await assert.rejects(
      initializeReview(store.review, {
        job: REVIEW_TEST_JOB,
        corpus: corpus(),
        baseRunId: 'f'.repeat(32),
      }),
      /Unknown base review run/,
    );
    await store.close();
  });

  test('refuses a base that has not completed', async () => {
    const store = sqliteStore(':memory:');
    const first = await initializeReview(store.review, {
      job: REVIEW_TEST_JOB,
      corpus: corpus(),
      profile: 'stage-one',
    });
    await assert.rejects(
      initializeReview(store.review, {
        job: REVIEW_TEST_JOB,
        corpus: corpus(),
        baseRunId: first.runId,
      }),
      /is initialized; it must be completed before chaining/,
    );
    await store.close();
  });

  test('refuses a base that does not cover every row', async () => {
    const store = sqliteStore(':memory:');
    const baseId = await completedBase(store);
    const wider = [
      ...corpus(),
      {
        rowNumber: 5,
        identifier: 'AU-3',
        inputHash: 'in-5',
        source: { name: 'New' },
        target: { name: 'Nouveau' },
        status: 'succeeded' as const,
      },
    ];
    await assert.rejects(
      initializeReview(store.review, { job: REVIEW_TEST_JOB, corpus: wider, baseRunId: baseId }),
      /does not cover row 5 \(AU-3\)/,
    );
    await store.close();
  });

  test("reviews the base run's resolved output rather than the live corpus", async () => {
    const store = sqliteStore(':memory:');
    const baseId = await completedBase(store);
    const stage2 = await initializeReview(store.review, {
      job: REVIEW_TEST_JOB,
      corpus: corpus(),
      baseRunId: baseId,
    });
    const snapshot = await store.review(stage2.runId).snapshot();
    // The accepted proposal is what stage two sees; the field the reviewer left
    // alone still reads as the corpus does, and so does every other row.
    assert.equal(snapshot[0]?.target.name, "Politique d'acces");
    assert.equal(snapshot[0]?.target.description, corpus()[0]?.target?.description);
    assert.equal(snapshot[1]?.target.name, corpus()[1]?.target?.name);
    // A chained run reviews different text, so it is a different run.
    assert.notEqual(stage2.runId, BASE);
    assert.equal(stage2.baseRunId, baseId);
    await store.close();
  });
});

describe('resolveRunOutput', () => {
  const item = (over: Partial<ReviewItem>): ReviewItem => ({
    rowNumber: 1,
    identifier: 'AC-1',
    inputHash: 'in',
    sourceHash: 's',
    targetHash: 't',
    evidenceHash: 'e',
    source: { name: 'Access Control Policy' },
    target: { name: 'Politique', description: 'Texte' },
    outcome: 'pass',
    severity: null,
    confidence: null,
    proposals: null,
    issues: null,
    attemptCount: 0,
    lastError: null,
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  test('writes a proposal over the snapshot, field by field', () => {
    const resolved = resolveRunOutput([
      item({
        outcome: 'change_proposed',
        proposals: { name: 'Politique de controle', description: null },
      }),
    ]);
    assert.deepEqual(resolved.get(1), { name: 'Politique de controle', description: 'Texte' });
  });

  // The same rule `resolveDecisions` applies to an empty proposal, and the
  // half that needs it more: nobody is reading this loop and there is no
  // warnings channel, so an emptied field would reach the next stage's
  // snapshot with nothing recording that it had been emptied.
  test('an empty proposal is nothing proposed, not a rewrite to empty', () => {
    const resolved = resolveRunOutput([
      item({
        outcome: 'change_proposed',
        proposals: { name: 'Politique de controle', description: '' },
      }),
    ]);
    assert.deepEqual(resolved.get(1), { name: 'Politique de controle', description: 'Texte' });
  });

  test('leaves a row alone unless the reviewer proposed a change', () => {
    for (const outcome of ['pass', 'pending', 'failed'] as const) {
      const resolved = resolveRunOutput([item({ outcome, proposals: { name: 'Ignored' } })]);
      assert.equal(resolved.get(1)?.name, 'Politique', `${outcome} must not adopt a proposal`);
    }
  });

  test('does not mutate the snapshot it resolved', () => {
    const one = item({ outcome: 'change_proposed', proposals: { name: 'Autre' } });
    resolveRunOutput([one]);
    assert.equal(one.target.name, 'Politique');
  });
});
