// The reviewer's quality gate. Every rejection here is structural and costs the
// row an attempt, which is the difference from `validateResponse`: a review is
// already the human-attention step, so there is nothing to downgrade one to.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import type { ReviewJob } from '../src/review/job.ts';
import { validateReview } from '../src/review/validate.ts';
import { REVIEW_TEST_JOB } from './helpers/review-job.ts';

/** A well-formed answer, for a test to spoil one field of. */
const ANSWER = {
  identifier: 'AC-1',
  verdict: 'change_proposed',
  severity: 'major',
  confidence: 'high',
  proposals: { name: 'Politique de controle des acces', description: null },
  issues: ['the heading drifts from the source'],
};

const parse = (value: unknown, job: ReviewJob = REVIEW_TEST_JOB) =>
  validateReview(job, 'AC-1', value);

/** Assert that a spoiled answer is refused, and refused transiently. */
function refuses(patch: Record<string, unknown>, match: RegExp, job = REVIEW_TEST_JOB): void {
  assert.throws(
    () => validateReview(job, 'AC-1', { ...ANSWER, ...patch }),
    (error: unknown) => {
      assert.ok(
        error instanceof TransientFailure,
        'a bad reviewer answer is worth another attempt',
      );
      assert.match(error.message, match);
      return true;
    },
  );
}

describe('validateReview', () => {
  test('accepts a well-formed answer and hands back exactly what it said', () => {
    assert.deepEqual(parse(ANSWER), {
      verdict: 'change_proposed',
      severity: 'major',
      confidence: 'high',
      proposals: { name: 'Politique de controle des acces', description: null },
      issues: ['the heading drifts from the source'],
    });
  });

  test('a pass with no grades is well-formed', () => {
    // The common answer, and the one an over-strict schema would reject: a
    // reviewer that found nothing has no severity to report.
    const parsed = parse({
      ...ANSWER,
      verdict: 'pass',
      severity: null,
      confidence: null,
      proposals: { name: null, description: null },
      issues: [],
    });
    assert.equal(parsed.severity, null);
    assert.equal(parsed.confidence, null);
  });

  test('refuses an answer about a different row', () => {
    refuses({ identifier: 'AC-2' }, /identifier .*differs/);
  });

  test('refuses a verdict outside the two it may return', () => {
    refuses({ verdict: 'needs_work' }, /verdict must be pass\|change_proposed/);
    refuses({ verdict: null }, /verdict must be/);
  });

  test('refuses a level outside the scale, naming the scale', () => {
    // The measured failure: an unconstrained severity drew four words for three
    // levels out of one model, so the validator has to be the thing that stops
    // it rather than the thing that reports it afterwards.
    refuses({ severity: 'medium' }, /severity must be null or one of minor\|moderate\|major/);
    refuses({ severity: 'moderate ' }, /severity must be null/);
    refuses({ confidence: 'moderate' }, /confidence must be null or one of low\|medium\|high/);
  });

  test('honours a job that overrode a scale', () => {
    const job: ReviewJob = { ...REVIEW_TEST_JOB, severityLevels: ['nit', 'blocker'] };
    assert.equal(parse({ ...ANSWER, severity: 'blocker' }, job).severity, 'blocker');
    refuses({ severity: 'major' }, /one of nit\|blocker/, job);
  });

  test('refuses a malformed shape rather than reading around it', () => {
    assert.throws(() => parse(null), TransientFailure);
    assert.throws(() => parse([ANSWER]), TransientFailure);
    assert.throws(() => parse('{}'), TransientFailure);
    refuses({ issues: 'one issue' }, /issues must be an array of strings/);
    refuses({ issues: [1] }, /issues must be an array of strings/);
    refuses({ proposals: null }, /proposals must be an object/);
    refuses({ proposals: ['x'] }, /proposals must be an object/);
    refuses({ proposals: { name: 7, description: null } }, /proposal 'name' must be string\|null/);
  });

  test('a missing proposal is null rather than an error', () => {
    // The one shape the gate is lenient about, and deliberately: `null` and
    // absent both mean "keep what is there", and the schema already requires
    // the key, so a model that omits it has said the same thing twice.
    assert.deepEqual(parse({ ...ANSWER, proposals: {} }).proposals, {
      name: null,
      description: null,
    });
  });

  test('drops a proposal for a field the job does not review', () => {
    const parsed = parse({ ...ANSWER, proposals: { ...ANSWER.proposals, type: 'passthrough' } });
    assert.deepEqual(Object.keys(parsed.proposals), ['name', 'description']);
  });
});

describe('normalization', () => {
  const job: ReviewJob = {
    ...REVIEW_TEST_JOB,
    translation: { ...REVIEW_TEST_JOB.translation, normalize: (v) => v.replace(/'/g, '’') },
  };

  test('a proposal is normalized here, because here is where it is accepted', () => {
    // A proposal becomes a corpus value the moment a human takes it, so a clean
    // corpus reviewed by a model that writes a straight apostrophe must not come
    // back inconsistent. `validateResponse` doing it for translations is not
    // enough to cover that path.
    const parsed = validateReview(job, 'AC-1', {
      ...ANSWER,
      proposals: { name: "Politique d'acces", description: null },
    });
    assert.equal(parsed.proposals.name, 'Politique d’acces');
  });

  test('runs on a pass verdict too, since a verdict and a proposal are separate claims', () => {
    const parsed = validateReview(job, 'AC-1', {
      ...ANSWER,
      verdict: 'pass',
      proposals: { name: "l'acces", description: null },
    });
    assert.equal(parsed.proposals.name, 'l’acces');
  });

  test('leaves nulls alone', () => {
    assert.equal(validateReview(job, 'AC-1', ANSWER).proposals.description, null);
  });
});
