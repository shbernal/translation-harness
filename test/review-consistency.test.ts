// The consistency analysis: what it finds, how it serializes, and the two
// per-row views taken off it.
//
// The serialization is tested harder than the finding, because the finding is
// only ever read by a human and the serialization is one of the run id's
// inputs. A change to what counts as an inconsistency shows up as a different
// set of proposals; a change to how the analysis is written down shows up as
// every review run in a registry having a different identity than it had
// yesterday.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Fields, TranslationJob } from '../src/job.ts';
import {
  buildConsistency,
  type ConsistencyRow,
  promptEvidence,
  recordedEvidence,
} from '../src/review/consistency.ts';
import type { ReviewJob } from '../src/review/job.ts';
import { buildReviewPrompt } from '../src/review/prompt.ts';
import { TEST_JOB } from './helpers/job.ts';
import {
  FULL_FRAME_TEST_JOB,
  GOLDEN_CORPUS,
  GOLDEN_EVIDENCE,
  GOLDEN_REVIEW_ROW,
  REVIEW_TEST_JOB,
} from './helpers/review-job.ts';

const golden = (name: string): string => readFileSync(`test/golden/${name}`, 'utf8');

/** A one-field review job, for the cases where two fields are just noise. */
function oneFieldJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  const translation: TranslationJob = {
    ...TEST_JOB,
    fields: [{ key: 'name', label: 'Name', translate: true, required: true }],
  };
  return { ...REVIEW_TEST_JOB, translation, ...overrides };
}

function rows(...pairs: [string, string | undefined][]): ConsistencyRow[] {
  return pairs.map(([source, target]): ConsistencyRow => {
    const targetFields: Fields = {};
    if (target !== undefined) targetFields.name = target;
    return { source: { name: source }, target: targetFields };
  });
}

test('the analysis serializes to its golden', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  assert.equal(analysis.text, golden('review-consistency.json'));
});

test('the hash is over the serialized text, trailing newline included', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  assert.equal(
    analysis.hash,
    createHash('sha256').update(analysis.text, 'utf8').digest('hex'),
    'the hash a run id is derived from must be over the bytes written to disk',
  );
  assert.ok(analysis.text.endsWith('}\n'), 'the serialization ends with a newline');
});

test('a source rendered one way produces no entry', () => {
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['Policy', 'Politique'], ['Policy', 'Politique']),
  );
  assert.deepEqual(analysis.corpusTerms.name, []);
});

test('a source rendered two ways produces one entry, with the renderings sorted', () => {
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['Policy', 'Regle'], ['Policy', 'Politique'], ['Policy', 'Regle']),
  );
  assert.deepEqual(analysis.corpusTerms.name, [
    { source: 'Policy', renderings: ['Politique', 'Regle'], count: 2 },
  ]);
});

test('count is the number of distinct renderings, not the number of rows', () => {
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['Policy', 'A'], ['Policy', 'B'], ['Policy', 'A'], ['Policy', 'B'], ['Policy', 'A']),
  );
  assert.equal(analysis.corpusTerms.name?.[0]?.count, 2);
});

test('a missing target value is a rendering, and it is the empty string', () => {
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['Policy', 'Politique'], ['Policy', undefined]),
  );
  assert.deepEqual(analysis.corpusTerms.name, [
    { source: 'Policy', renderings: ['', 'Politique'], count: 2 },
  ]);
});

test('a row with no source value contributes nothing to that field', () => {
  const analysis = buildConsistency(oneFieldJob(), [
    { source: { name: 'Policy' }, target: { name: 'Politique' } },
    { source: {}, target: { name: 'Regle' } },
  ]);
  assert.deepEqual(analysis.corpusTerms.name, [], 'the sourceless row must not invent a rendering');
});

test('every analysed field gets a key, even with nothing to report', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, []);
  assert.deepEqual(Object.keys(analysis.corpusTerms), ['name', 'description']);
  assert.deepEqual(analysis.corpusTerms.name, []);
  assert.deepEqual(analysis.corpusTerms.description, []);
});

test('the field list and the key order come from the job, not from the corpus', () => {
  // The corpus mentions `description` before `name`, and the serialization must
  // not follow it: the bytes are hashed, so they cannot depend on row order.
  const analysis = buildConsistency(REVIEW_TEST_JOB, [
    { source: { description: 'D' }, target: { description: 'X' } },
    { source: { description: 'D' }, target: { description: 'Y' } },
    { source: { name: 'N' }, target: { name: 'A' } },
    { source: { name: 'N' }, target: { name: 'B' } },
  ]);
  assert.deepEqual(analysis.fields, ['name', 'description']);
  assert.deepEqual(Object.keys(analysis.corpusTerms), ['name', 'description']);
});

test('row order does not change the analysis', () => {
  const forwards = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  const backwards = buildConsistency(REVIEW_TEST_JOB, [...GOLDEN_CORPUS].reverse());
  assert.equal(backwards.hash, forwards.hash);
});

test('entries are ordered by codepoint, not by locale', () => {
  // 'Zebra' before 'apple' is codepoint order; every locale collation this
  // library could pick up puts them the other way round. Pinning it here is
  // what stops the analysis - and therefore a run id - from depending on the
  // machine that computed it.
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['apple', 'A'], ['apple', 'B'], ['Zebra', 'C'], ['Zebra', 'D']),
  );
  assert.deepEqual(
    (analysis.corpusTerms.name ?? []).map((e) => e.source),
    ['Zebra', 'apple'],
  );
  assert.notEqual(
    ['Zebra', 'apple'].join(),
    ['Zebra', 'apple'].sort((a, b) => a.localeCompare(b)).join(),
    'the case is only worth anything while the two orders actually disagree',
  );
});

test('narrowing reviewFields narrows the analysis', () => {
  const analysis = buildConsistency(
    { ...REVIEW_TEST_JOB, reviewFields: ['description'] },
    GOLDEN_CORPUS,
  );
  assert.deepEqual(analysis.fields, ['description']);
  assert.deepEqual(Object.keys(analysis.corpusTerms), ['description']);
});

test('prompt evidence is the renderings, by field', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  assert.deepEqual(promptEvidence(analysis, GOLDEN_REVIEW_ROW.source), GOLDEN_EVIDENCE);
});

test('prompt evidence is empty for a row whose renderings are all consistent', () => {
  const analysis = buildConsistency(
    oneFieldJob(),
    rows(['Policy', 'Politique'], ['Policy', 'Politique']),
  );
  assert.deepEqual(promptEvidence(analysis, { name: 'Policy' }), {});
});

test('a row the corpus does not mention gets no evidence', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  assert.deepEqual(promptEvidence(analysis, { name: 'Something Else' }), {});
});

test('empty evidence composes the prompt a caller with no analysis composes', () => {
  // The property the whole optional block rests on, from the producing end: a
  // corpus with nothing to report must not put an empty object in the prompt.
  const analysis = buildConsistency(oneFieldJob(), rows(['Policy', 'Politique']));
  const evidence = promptEvidence(analysis, { name: 'Policy' });
  const job = oneFieldJob();
  assert.equal(
    buildReviewPrompt(job, 'AC-1', { name: 'Policy' }, { name: 'Politique' }, evidence),
    buildReviewPrompt(job, 'AC-1', { name: 'Policy' }, { name: 'Politique' }),
  );
});

test('the bilingual golden prompt is composed from the golden corpus', () => {
  // Ties the two goldens together: the evidence in the step-7 prompt golden is
  // what this analysis produces over this corpus, not a value typed by hand.
  const analysis = buildConsistency(FULL_FRAME_TEST_JOB, GOLDEN_CORPUS);
  const prompt = buildReviewPrompt(
    FULL_FRAME_TEST_JOB,
    GOLDEN_REVIEW_ROW.identifier,
    GOLDEN_REVIEW_ROW.source,
    GOLDEN_REVIEW_ROW.target,
    promptEvidence(analysis, GOLDEN_REVIEW_ROW.source),
  );
  assert.equal(prompt, golden('review-prompt.txt'));
});

test('recorded evidence carries the source the renderings are about', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  assert.deepEqual(recordedEvidence(analysis, GOLDEN_REVIEW_ROW.source), {
    name: {
      source: 'Access Control Policy',
      renderings: ["Politique de controle d'acces", 'Politique de gestion des acces'],
    },
  });
});

test('the two views agree about which fields have evidence', () => {
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  for (const row of GOLDEN_CORPUS) {
    assert.deepEqual(
      Object.keys(recordedEvidence(analysis, row.source)),
      Object.keys(promptEvidence(analysis, row.source)),
      `row ${row.identifier}`,
    );
  }
});

test('recorded evidence is empty for a consistent row, so its hash is stable', () => {
  const analysis = buildConsistency(oneFieldJob(), rows(['Policy', 'Politique']));
  assert.equal(JSON.stringify(recordedEvidence(analysis, { name: 'Policy' })), '{}');
});

test('an analysis can be asked about a row more than once', () => {
  // The lookup is memoized off the analysis; the second answer must be the
  // first one, not a stale or a mutated one.
  const analysis = buildConsistency(REVIEW_TEST_JOB, GOLDEN_CORPUS);
  const first = promptEvidence(analysis, GOLDEN_REVIEW_ROW.source);
  const second = promptEvidence(analysis, GOLDEN_REVIEW_ROW.source);
  assert.deepEqual(second, first);
  assert.notEqual(second, first, 'each call returns its own object');
});
