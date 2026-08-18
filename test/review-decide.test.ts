// Resolving a human's decisions over a review run.
//
// Most of this file is the degenerate cases, and that is the right proportion:
// the happy path is three lines of substitution, and everything that makes the
// function worth publishing is what it does with a cell somebody filled in
// wrong. Each of those keeps the value under review and says so, because the
// alternative - refusing - throws away ten thousand correct decisions over one
// mistyped one.
//
// The last two suites are the two claims that are not about warnings: that a
// rewrite is written exactly as typed, and that this and `resolveRunOutput`
// resolve a run the same way when they are asked the same thing.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fields } from '../src/job.ts';
import { resolveRunOutput } from '../src/review/chain.ts';
import {
  type ReviewDecision,
  type ReviewDecisions,
  resolveDecisions,
} from '../src/review/decide.ts';
import { initializeReview, type ReviewSourceRow } from '../src/review/init.ts';
import type { ReviewJob } from '../src/review/job.ts';
import { REVIEW_MOCK_PROVIDER_NAME, registerReviewMockProvider } from '../src/review/mock.ts';
import { runReview } from '../src/review/run.ts';
import type { ReviewItem } from '../src/store/review-types.ts';
import { sqliteStore } from '../src/store/sqlite.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { TEST_JOB } from './helpers/job.ts';
import { GOLDEN_CORPUS, REVIEW_TEST_JOB } from './helpers/review-job.ts';

registerReviewMockProvider();

/** One snapshot row, with only what a decision can see spelled out. */
function item(
  rowNumber: number,
  identifier: string,
  target: Fields,
  over: Partial<ReviewItem> = {},
): ReviewItem {
  return {
    rowNumber,
    identifier,
    inputHash: `in-${rowNumber}`,
    sourceHash: `src-${rowNumber}`,
    targetHash: `tgt-${rowNumber}`,
    evidenceHash: `ev-${rowNumber}`,
    source: { name: `source ${rowNumber}` },
    target,
    outcome: 'pass',
    severity: null,
    confidence: null,
    proposals: null,
    issues: null,
    attemptCount: 1,
    lastError: null,
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/**
 * Two rows: one the reviewer wants changed, one it passed. Between them they
 * cover every branch - a proposal that exists, a proposal that is `null`
 * because the reviewer left the field alone, and a row with no proposals at all.
 */
const SNAPSHOT: ReviewItem[] = [
  item(
    1,
    'AC-1',
    { name: 'Politique de controle', description: 'La politique.' },
    {
      outcome: 'change_proposed',
      proposals: { name: "Politique de controle d'acces", description: null },
      severity: 'moderate',
      confidence: 'high',
      issues: ['name: incomplete'],
    },
  ),
  item(2, 'AU-1', { name: 'Registres d audit', description: 'Les enregistrements.' }),
];

const decisions = (entries: Record<string, Record<string, ReviewDecision>>): ReviewDecisions =>
  new Map(Object.entries(entries));

const NOTHING: ReviewDecisions = new Map();

describe('resolveDecisions', () => {
  test('resolves every row of the run, decided or not', () => {
    const { resolved, counts, warnings } = resolveDecisions(SNAPSHOT, NOTHING);

    assert.deepEqual([...resolved.keys()], [1, 2], 'a run resolves as a whole or not at all');
    assert.deepEqual(resolved.get(1), SNAPSHOT[0]?.target);
    assert.deepEqual(resolved.get(2), SNAPSHOT[1]?.target);
    assert.deepEqual(counts, { keep: 0, proposal: 0, custom: 0 }, 'nobody decided anything');
    assert.deepEqual(warnings, []);
  });

  test('keep, proposal and custom are the three answers', () => {
    const { resolved, counts, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({
        'AC-1': { name: { kind: 'proposal' }, description: { kind: 'keep' } },
        'AU-1': { name: { kind: 'custom', custom: 'Journaux d audit' } },
      }),
    );

    assert.deepEqual(resolved.get(1), {
      name: "Politique de controle d'acces",
      description: 'La politique.',
    });
    assert.deepEqual(resolved.get(2), {
      name: 'Journaux d audit',
      description: 'Les enregistrements.',
    });
    assert.deepEqual(counts, { keep: 1, proposal: 1, custom: 1 });
    assert.deepEqual(warnings, []);
  });

  test('a field nobody decided is untouched, whatever happened to its neighbour', () => {
    const { resolved } = resolveDecisions(
      SNAPSHOT,
      decisions({ 'AC-1': { name: { kind: 'proposal' } } }),
    );
    assert.equal(resolved.get(1)?.description, 'La politique.');
  });

  // The store keeps a verdict and a proposal separately, so a `pass` row can
  // carry one. `resolveRunOutput` ignores it, because a chained run has nobody
  // to ask; a human reading both may well prefer the proposal, so this honours
  // it. The two functions disagreeing here is the point rather than a bug.
  test('honours a proposal on a row the reviewer passed', () => {
    const snapshot = [item(1, 'AC-1', { name: 'as it stands' }, { proposals: { name: 'better' } })];

    assert.equal(resolveRunOutput(snapshot).get(1)?.name, 'as it stands');
    const { resolved, warnings } = resolveDecisions(
      snapshot,
      decisions({ 'AC-1': { name: { kind: 'proposal' } } }),
    );
    assert.equal(resolved.get(1)?.name, 'better');
    assert.deepEqual(warnings, []);
  });
});

describe('a choice that cannot be honoured', () => {
  test("'proposal' with nothing proposed keeps the value and says so", () => {
    const { resolved, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({
        'AC-1': { description: { kind: 'proposal' } },
        'AU-1': { name: { kind: 'proposal' } },
      }),
    );

    assert.equal(resolved.get(1)?.description, 'La politique.', 'a null proposal is not an answer');
    assert.equal(resolved.get(2)?.name, 'Registres d audit', 'nor is a row with no proposals');
    assert.deepEqual(warnings, [
      "AC-1 · description: 'proposal' chosen but the reviewer proposed nothing here; " +
        'kept the value under review',
      "AU-1 · name: 'proposal' chosen but the reviewer proposed nothing here; " +
        'kept the value under review',
    ]);
  });

  // Reported as issue #1: the two branches were twenty lines apart and
  // disagreed about the same value, `proposal` writing `''` over the target
  // while `custom` refused it. The reported shape is the dangerous one - an
  // exporter defaulting a field's dropdown to `proposal` wherever the proposal
  // is non-null pre-selects the deletion, and `warnings` was empty.
  test("'proposal' of an empty string keeps the value and says so", () => {
    const snapshot = [
      item(
        1,
        'AC-1',
        { name: 'kept name', description: 'kept description' },
        {
          outcome: 'change_proposed',
          proposals: { name: 'proposed name', description: '' },
        },
      ),
    ];
    const { resolved, counts, warnings } = resolveDecisions(
      snapshot,
      decisions({
        'AC-1': { name: { kind: 'proposal' }, description: { kind: 'proposal' } },
      }),
    );

    assert.equal(resolved.get(1)?.name, 'proposed name', 'a real proposal is still taken');
    assert.equal(resolved.get(1)?.description, 'kept description', 'an empty one is not');
    assert.deepEqual(counts, { keep: 0, proposal: 2, custom: 0 }, 'both were chosen');
    assert.deepEqual(warnings, [
      "AC-1 · description: 'proposal' chosen but the reviewer proposed nothing here; " +
        'kept the value under review',
    ]);
  });

  // An empty rewrite reads as a cell somebody meant to fill in, not as "blank
  // this field". Reading it the other way would let a slip delete text with no
  // trace, which is the one outcome a resolution step must not have.
  test("'custom' with no rewrite keeps the value and says so, empty or absent", () => {
    const { resolved, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({
        'AC-1': { name: { kind: 'custom', custom: '' } },
        'AU-1': { name: { kind: 'custom' } },
      }),
    );

    assert.equal(resolved.get(1)?.name, 'Politique de controle');
    assert.equal(resolved.get(2)?.name, 'Registres d audit');
    assert.equal(warnings.length, 2);
    for (const warning of warnings) assert.match(warning, /no rewrite was supplied/);
  });

  test('an unrecognized decision keeps the value and says so', () => {
    // Typed out of reach, which is the case this exists for: these arrive as
    // text from a spreadsheet, where a type says nothing about what is in a cell.
    const mistyped = { kind: 'propsal' } as unknown as ReviewDecision;
    const { resolved, counts, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({ 'AC-1': { name: mistyped } }),
    );

    assert.equal(resolved.get(1)?.name, 'Politique de controle');
    assert.deepEqual(counts, { keep: 0, proposal: 0, custom: 0 }, 'it counts as nothing chosen');
    assert.deepEqual(warnings, [
      'AC-1 · name: unrecognized decision "propsal"; kept the value under review',
    ]);
  });

  test('an identifier this run does not have is ignored', () => {
    const { resolved, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({ 'XX-9': { name: { kind: 'custom', custom: 'from another corpus' } } }),
    );

    assert.equal(resolved.size, 2, 'it cannot invent a row it has no snapshot of');
    assert.deepEqual(warnings, ['XX-9: not a row of this review run; ignored']);
  });

  // One mistyped column header is one mistake. Reported per row it would be
  // 2,125 lines on the German corpus and would bury every real warning under
  // itself, so it is counted instead.
  test('a field this run does not have is reported once, not once per row', () => {
    const { resolved, counts, warnings } = resolveDecisions(
      SNAPSHOT,
      decisions({
        'AC-1': { descriptoin: { kind: 'custom', custom: 'typo' } },
        'AU-1': { descriptoin: { kind: 'custom', custom: 'typo' } },
      }),
    );

    assert.deepEqual(resolved.get(1), SNAPSHOT[0]?.target, 'nothing was written');
    assert.deepEqual(counts, { keep: 0, proposal: 0, custom: 0 });
    assert.deepEqual(warnings, [
      '"descriptoin" is not a field of this review run; ignored on 2 rows',
    ]);
  });

  // A field can be missing from one row's target and present in another's, so
  // "is this a field of the run" is only answerable over the whole snapshot.
  // Getting this wrong would refuse exactly the case a reviewer is for: a row
  // whose target never had the value the rest of the corpus has.
  test('a field one row lacks is still a field of the run', () => {
    const snapshot = [
      item(1, 'AC-1', { name: 'a', description: 'has one' }),
      item(2, 'AU-1', { name: 'b' }, { proposals: { description: 'proposed one' } }),
    ];
    const { resolved, warnings } = resolveDecisions(
      snapshot,
      decisions({ 'AU-1': { description: { kind: 'proposal' } } }),
    );

    assert.equal(resolved.get(2)?.description, 'proposed one');
    assert.deepEqual(warnings, []);
  });

  test('a choice that could not be honoured still counts as what was chosen', () => {
    const { counts } = resolveDecisions(
      SNAPSHOT,
      decisions({
        'AC-1': { description: { kind: 'proposal' } },
        'AU-1': { name: { kind: 'custom', custom: null } },
      }),
    );

    assert.deepEqual(
      counts,
      { keep: 0, proposal: 1, custom: 1 },
      'the tally says what the human did; the warnings say what came of it',
    );
  });

  test('refuses a snapshot with two rows under one identifier', () => {
    assert.throws(
      () =>
        resolveDecisions([item(1, 'AC-1', { name: 'a' }), item(2, 'AC-1', { name: 'b' })], NOTHING),
      /two rows identified 'AC-1'/,
    );
  });
});

describe('what it deliberately leaves alone', () => {
  test('a rewrite left beside another choice is not applied', () => {
    const { resolved } = resolveDecisions(
      SNAPSHOT,
      decisions({ 'AC-1': { name: { kind: 'keep', custom: 'an abandoned draft' } } }),
    );
    assert.equal(resolved.get(1)?.name, 'Politique de controle', 'the choice is the decision');
  });

  test('it reads nothing from the live corpus, so a stale snapshot resolves to itself', () => {
    const { resolved } = resolveDecisions(
      SNAPSHOT,
      decisions({ 'AU-1': { name: { kind: 'keep' } } }),
    );
    assert.equal(resolved.get(2)?.name, 'Registres d audit');
  });
});

// The unit cases above build their own rows. This one asks the same questions
// of what the store actually hands back, after a real pass.
describe('over a run that has been reviewed', () => {
  test('resolves the snapshot a pass produced, and writes a rewrite exactly as typed', async () => {
    // A normalizer that would be visible if it ran: `validateReview` applies it
    // to the reviewer's proposal, and nothing applies it to a human's rewrite.
    const job: ReviewJob = {
      ...REVIEW_TEST_JOB,
      translation: { ...TEST_JOB, normalize: (value) => value.replace(/'/g, '’') },
    };
    const rows: ReviewSourceRow[] = GOLDEN_CORPUS.map((row, i) => ({
      rowNumber: i + 1,
      identifier: row.identifier,
      inputHash: `in-${i + 1}`,
      source: { ...row.source },
      target: { ...row.target } as Fields,
      status: 'succeeded' as const,
    }));
    // Stray whitespace is the one defect the offline reviewer objects to.
    (rows[0] as { target: Fields }).target.name = "Politique  de controle d'acces";

    const scratch = scratchDir('review-decide');
    const store = sqliteStore(join(scratch.dir, 'registry.sqlite3'), { pathBase: scratch.dir });
    try {
      const init = await initializeReview(store.review, { job, corpus: rows });
      const review = store.review(init.runId);
      await runReview(review, job, await review.selectCandidates({}), {
        cwd: scratch.dir,
        provider: REVIEW_MOCK_PROVIDER_NAME,
        timeoutSeconds: 10,
        workDir: join(scratch.dir, 'work'),
        maxAttempts: 2,
        delaySeconds: 0,
      });

      const snapshot = await review.snapshot();
      const flagged = snapshot.find((row) => row.identifier === 'AC-1');
      assert.equal(
        flagged?.proposals?.name,
        'Politique de controle d’acces',
        'the reviewer proposal was normalized when it was accepted',
      );

      const { resolved, counts, warnings } = resolveDecisions(
        snapshot,
        decisions({
          'AC-1': { name: { kind: 'proposal' } },
          'AU-1': { name: { kind: 'custom', custom: "Journaux d'audit" } },
        }),
      );

      assert.deepEqual(warnings, []);
      assert.deepEqual(counts, { keep: 0, proposal: 1, custom: 1 });
      assert.equal(
        resolved.get(1)?.name,
        'Politique de controle d’acces',
        'taking the proposal takes it as the store holds it',
      );
      assert.equal(
        resolved.get(3)?.name,
        "Journaux d'audit",
        'a rewrite somebody typed is written as typed, straight apostrophe and all',
      );
      assert.equal(resolved.size, 4, 'and the rows nobody decided are still there');

      // Same run, same question, one asked of the run and one of a person.
      const chained = resolveRunOutput(snapshot);
      const asChained = resolveDecisions(
        snapshot,
        decisions({ 'AC-1': { name: { kind: 'proposal' } } }),
      );
      assert.deepEqual([...asChained.resolved], [...chained]);
    } finally {
      await store.close();
      scratch.remove();
    }
  });
});
