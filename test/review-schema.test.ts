// The reviewer's output schema, and the graded vocabularies it closes.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReviewJob } from '../src/review/job.ts';
import { DEFAULT_CONFIDENCE_LEVELS, DEFAULT_SEVERITY_LEVELS } from '../src/review/job.ts';
import { buildReviewSchema, writeReviewSchema } from '../src/review/schema.ts';
import { REVIEW_TEST_JOB } from './helpers/review-job.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

interface SchemaShape {
  properties: {
    verdict: { enum: string[] };
    severity: { enum: (string | null)[] };
    confidence: { enum: (string | null)[] };
    proposals: { properties: Record<string, unknown>; required: string[] };
  };
  required: string[];
}

const shapeOf = (job: ReviewJob): SchemaShape => buildReviewSchema(job).json as SchemaShape;

describe('buildReviewSchema', () => {
  test('matches the committed golden schema byte for byte', () => {
    const expected = readFileSync(join(GOLDEN, 'review-response.schema.json'), 'utf8');
    assert.equal(buildReviewSchema(REVIEW_TEST_JOB).text, expected);
  });

  test('asks for a proposal per reviewed field, every one of them nullable', () => {
    const shape = shapeOf(REVIEW_TEST_JOB);
    assert.deepEqual(shape.properties.proposals.required, ['name', 'description']);
    assert.deepEqual(shape.properties.proposals.properties.name, { type: ['string', 'null'] });
    assert.ok(!('type' in shape.properties.proposals.properties), 'passthrough is not reviewed');
  });

  test('closes the verdict to the two values everything downstream branches on', () => {
    assert.deepEqual(shapeOf(REVIEW_TEST_JOB).properties.verdict.enum, ['pass', 'change_proposed']);
  });

  test('the graded fields admit their levels and null, and nothing else', () => {
    const shape = shapeOf(REVIEW_TEST_JOB);
    assert.deepEqual(shape.properties.severity.enum, [...DEFAULT_SEVERITY_LEVELS, null]);
    assert.deepEqual(shape.properties.confidence.enum, [...DEFAULT_CONFIDENCE_LEVELS, null]);
  });

  test('the middle rungs are the ones that collided, and they stay apart', () => {
    // `moderate` grades a defect and `medium` grades a belief. An unconstrained
    // severity field drew both out of one model, which is the measurement these
    // two lists exist because of.
    assert.ok(DEFAULT_SEVERITY_LEVELS.includes('moderate'));
    assert.ok(DEFAULT_CONFIDENCE_LEVELS.includes('medium'));
    assert.ok(!(DEFAULT_SEVERITY_LEVELS as readonly string[]).includes('medium'));
    assert.ok(!(DEFAULT_CONFIDENCE_LEVELS as readonly string[]).includes('moderate'));
  });

  test('a job may override either scale', () => {
    const job: ReviewJob = { ...REVIEW_TEST_JOB, severityLevels: ['nit', 'blocker'] };
    assert.deepEqual(shapeOf(job).properties.severity.enum, ['nit', 'blocker', null]);
    assert.deepEqual(shapeOf(job).properties.confidence.enum, [...DEFAULT_CONFIDENCE_LEVELS, null]);
  });

  test('every top-level field is required, so a silent omission is a bad row', () => {
    assert.deepEqual(shapeOf(REVIEW_TEST_JOB).required, [
      'identifier',
      'verdict',
      'severity',
      'confidence',
      'proposals',
      'issues',
    ]);
  });
});

describe('the schema hash', () => {
  test('is taken over the compact form, not the bytes written to disk', () => {
    // Deliberate, and different from the translate side: the file is indented
    // for a human reading an attempt directory, and a review run's identity must
    // not move because of an indent. Run ids already derived this way.
    const built = buildReviewSchema(REVIEW_TEST_JOB);
    assert.equal(built.compact, JSON.stringify(built.json));
    assert.notEqual(built.compact, built.text);
    assert.equal(built.hash, sha256(built.compact));
    assert.notEqual(built.hash, sha256(built.text));
  });

  test('moves when the contract moves, and only then', () => {
    const base = buildReviewSchema(REVIEW_TEST_JOB).hash;
    assert.equal(buildReviewSchema({ ...REVIEW_TEST_JOB, id: 'other' }).hash, base);
    assert.equal(buildReviewSchema({ ...REVIEW_TEST_JOB, promptTemplate: 'X' }).hash, base);
    assert.notEqual(buildReviewSchema({ ...REVIEW_TEST_JOB, reviewFields: ['name'] }).hash, base);
    assert.notEqual(
      buildReviewSchema({ ...REVIEW_TEST_JOB, severityLevels: ['nit'] }).hash,
      base,
      'a changed vocabulary is a changed contract',
    );
  });
});

describe('writeReviewSchema', () => {
  test('writes the indented text under a name of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-schema-'));
    try {
      const path = writeReviewSchema(REVIEW_TEST_JOB, join(dir, 'nested'));
      assert.equal(path.endsWith('review-response.schema.json'), true);
      assert.equal(readFileSync(path, 'utf8'), buildReviewSchema(REVIEW_TEST_JOB).text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
