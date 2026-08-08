// The offline reviewer, on its own.
//
// The assertion that matters most is the round trip: whatever the mock answers
// has to satisfy `validateReview` for the job whose prompt it was handed. A
// mock whose answers its own library rejects is a mock that can only be used
// with the one job it was written against.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fields } from '../src/job.ts';
import { invokeProvider } from '../src/provider/registry.ts';
import type { ReviewJob } from '../src/review/job.ts';
import {
  invokeReviewMock,
  REVIEW_MOCK_PROVIDER_NAME,
  registerReviewMockProvider,
} from '../src/review/mock.ts';
import { buildReviewPrompt } from '../src/review/prompt.ts';
import { writeReviewSchema } from '../src/review/schema.ts';
import { validateReview } from '../src/review/validate.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { GOLDEN_REVIEW_ROW, REVIEW_TEST_JOB } from './helpers/review-job.ts';

interface Answer {
  identifier: string;
  verdict: string;
  severity: string | null;
  confidence: string | null;
  proposals: Record<string, string | null>;
  issues: string[];
}

/** Review one row offline, exactly as the runner would, and read the answer. */
async function review(
  target: Fields,
  job: ReviewJob = REVIEW_TEST_JOB,
  schemaDir?: string,
): Promise<{ answer: Answer; responsePath: string; dir: string; remove(): void }> {
  const scratch = scratchDir('review-mock');
  const schemaPath =
    schemaDir === undefined
      ? writeReviewSchema(job, scratch.dir)
      : join(scratch.dir, 'absent.schema.json');
  const responsePath = join(scratch.dir, 'response.json');
  const result = await invokeReviewMock({
    prompt: buildReviewPrompt(job, GOLDEN_REVIEW_ROW.identifier, GOLDEN_REVIEW_ROW.source, target),
    responsePath,
    schemaPath,
    options: { cwd: scratch.dir, provider: REVIEW_MOCK_PROVIDER_NAME, timeoutSeconds: 5 },
  });
  return { answer: result.value as Answer, responsePath, dir: scratch.dir, remove: scratch.remove };
}

describe('the offline reviewer', () => {
  test('passes a row it has nothing to say about', async () => {
    const { answer, remove } = await review({ name: 'Politique', description: 'Une phrase.' });
    assert.equal(answer.verdict, 'pass');
    assert.equal(answer.severity, null);
    assert.equal(answer.confidence, null);
    assert.deepEqual(answer.issues, []);
    assert.deepEqual(answer.proposals, { name: null, description: null });
    remove();
  });

  test('proposes the collapsed form, and says which field it is about', async () => {
    const { answer, remove } = await review({
      name: '  Politique  de   controle ',
      description: 'Une phrase.',
    });
    assert.equal(answer.verdict, 'change_proposed');
    assert.equal(answer.proposals.name, 'Politique de controle');
    assert.equal(answer.proposals.description, null);
    assert.deepEqual(answer.issues, ['name: stray whitespace']);
    assert.equal(answer.severity, 'minor');
    assert.equal(answer.confidence, 'high');
    remove();
  });

  test('answers something its own validator accepts', async () => {
    const { answer, remove } = await review({ name: 'Politique  double', description: 'Une.' });
    const validated = validateReview(REVIEW_TEST_JOB, GOLDEN_REVIEW_ROW.identifier, answer);
    assert.equal(validated.verdict, 'change_proposed');
    assert.equal(validated.proposals.name, 'Politique double');
    remove();
  });

  test('grades with the vocabularies the schema allows, not with its favourites', async () => {
    const job: ReviewJob = {
      ...REVIEW_TEST_JOB,
      severityLevels: ['nit', 'blocker'],
      confidenceLevels: ['unsure', 'sure'],
    };
    const { answer, remove } = await review({ name: 'Politique  double' }, job);
    assert.equal(answer.severity, 'nit', 'the mildest level the job declares');
    assert.equal(answer.confidence, 'sure', 'the highest');
    assert.doesNotThrow(() => validateReview(job, GOLDEN_REVIEW_ROW.identifier, answer));
    remove();
  });

  test('is ungraded rather than wrong when it cannot read the schema', async () => {
    const { answer, remove } = await review({ name: 'Politique  double' }, REVIEW_TEST_JOB, 'gone');
    assert.equal(answer.verdict, 'change_proposed');
    assert.equal(answer.severity, null);
    assert.equal(answer.confidence, null);
    assert.doesNotThrow(() =>
      validateReview(REVIEW_TEST_JOB, GOLDEN_REVIEW_ROW.identifier, answer),
    );
    remove();
  });

  test('leaves its answer on disk, which is the audit trail', async () => {
    const { answer, responsePath, remove } = await review({ name: 'Politique' });
    assert.deepEqual(JSON.parse(readFileSync(responsePath, 'utf8')), answer);
    remove();
  });

  test('refuses a prompt that carries no row', async () => {
    const scratch = scratchDir('review-mock');
    await assert.rejects(
      invokeReviewMock({
        prompt: 'REVIEWER GUIDANCE, and nothing to review',
        responsePath: join(scratch.dir, 'response.json'),
        schemaPath: join(scratch.dir, 'schema.json'),
        options: { cwd: scratch.dir, provider: REVIEW_MOCK_PROVIDER_NAME, timeoutSeconds: 5 },
      }),
      /no row snapshot/,
    );
    scratch.remove();
  });
});

describe('registerReviewMockProvider', () => {
  test('registers under a name of its own, so both mocks can coexist', async () => {
    registerReviewMockProvider();
    registerReviewMockProvider('offline-reviewer-for-tests');
    const scratch = scratchDir('review-mock');
    const schemaPath = writeReviewSchema(REVIEW_TEST_JOB, scratch.dir);
    for (const provider of [REVIEW_MOCK_PROVIDER_NAME, 'offline-reviewer-for-tests']) {
      const result = await invokeProvider({
        prompt: buildReviewPrompt(REVIEW_TEST_JOB, 'AC-1', GOLDEN_REVIEW_ROW.source, {
          name: 'Politique',
        }),
        responsePath: join(scratch.dir, `${provider}.json`),
        schemaPath,
        options: { cwd: scratch.dir, provider, timeoutSeconds: 5 },
      });
      assert.equal((result.value as Answer).verdict, 'pass');
    }
    scratch.remove();
  });
});
