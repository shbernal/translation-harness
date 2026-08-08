// Reviewer prompt assembly. The golden files are what every reviewer in every
// run is actually asked, so a diff on them is the review.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReviewJob } from '../src/review/job.ts';
import { buildReviewPrompt, ROW_SNAPSHOT_MARKER } from '../src/review/prompt.ts';
import {
  FULL_FRAME_TEST_JOB,
  GOLDEN_EVIDENCE,
  GOLDEN_REVIEW_ROW,
  MONOLINGUAL_TEST_JOB,
  REVIEW_TEST_JOB,
} from './helpers/review-job.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const { identifier, source, target } = GOLDEN_REVIEW_ROW;

describe('buildReviewPrompt', () => {
  test('matches the committed golden prompt byte for byte', () => {
    const expected = readFileSync(join(GOLDEN, 'review-prompt.txt'), 'utf8');
    assert.equal(
      buildReviewPrompt(FULL_FRAME_TEST_JOB, identifier, source, target, GOLDEN_EVIDENCE),
      expected,
    );
  });

  test('matches the committed golden monolingual prompt byte for byte', () => {
    const expected = readFileSync(join(GOLDEN, 'review-prompt-monolingual.txt'), 'utf8');
    assert.equal(buildReviewPrompt(MONOLINGUAL_TEST_JOB, identifier, source, target), expected);
  });

  test('shows the reviewer both values per field, and only the reviewed fields', () => {
    const prompt = buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target);
    assert.match(
      prompt,
      /Review these fields translated from English into French: name, description\./,
    );
    assert.doesNotMatch(prompt, /"type"/, 'a passthrough field is not reviewed');
    const payload = snapshotOf(prompt);
    assert.deepEqual(payload.fields.name, {
      source: 'Access Control Policy',
      current: "Politique de controle d'acces",
    });
  });

  test('a monolingual pass withholds the source entirely', () => {
    const prompt = buildReviewPrompt(MONOLINGUAL_TEST_JOB, identifier, source, target);
    assert.match(prompt, /coherence and correctness of these French fields on their own terms/);
    assert.doesNotMatch(prompt, /Access Control Policy/, 'the English must not reach the model');
    assert.deepEqual(snapshotOf(prompt).fields.name, { current: "Politique de controle d'acces" });
  });

  test('the payload is the last thing after the marker, so a parser can find it', () => {
    const prompt = buildReviewPrompt(FULL_FRAME_TEST_JOB, identifier, source, target);
    const payload = prompt.slice(
      prompt.lastIndexOf(ROW_SNAPSHOT_MARKER) + ROW_SNAPSHOT_MARKER.length,
    );
    assert.equal((JSON.parse(payload.trim()) as { identifier: string }).identifier, 'AC-1');
  });

  test('a field the corpus left blank is null on both sides rather than absent', () => {
    const prompt = buildReviewPrompt(REVIEW_TEST_JOB, 'AC-2', { name: 'X' }, { name: 'Y' });
    assert.deepEqual(snapshotOf(prompt).fields.description, { source: null, current: null });
  });
});

describe('the optional blocks', () => {
  test('no terminology and no evidence is byte-identical to a job that has neither', () => {
    // The same property `promptExtras` has on the translate side, and it is what
    // makes adding a termbase to a corpus mid-review a visible change rather
    // than a silent one: a run that gains a block gains a different run id.
    const bare = buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target);
    assert.equal(buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target, {}), bare);
    const blank: ReviewJob = { ...REVIEW_TEST_JOB, terminology: '   \n\n' };
    assert.equal(buildReviewPrompt(blank, identifier, source, target), bare);
    assert.equal(
      buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target, { name: [] }),
      bare,
      'a field with no alternatives is not evidence',
    );
  });

  test('terminology is trimmed and labelled, and sits before the evidence', () => {
    const prompt = buildReviewPrompt(
      FULL_FRAME_TEST_JOB,
      identifier,
      source,
      target,
      GOLDEN_EVIDENCE,
    );
    assert.ok(prompt.indexOf('TERMINOLOGY:') < prompt.indexOf('CONSISTENCY EVIDENCE'));
    assert.match(prompt, /TERMINOLOGY:\npolicy -> politique/);
    assert.doesNotMatch(prompt, /acces\n\n\nCONSISTENCY/, 'the trailing newline was trimmed');
  });

  test('evidence follows the job field order, not the order it was handed in', () => {
    // Otherwise the prompt bytes - and so the run this row was reviewed under -
    // depend on how the caller happened to build one object.
    const forwards = buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target, {
      name: ['a'],
      description: ['b'],
    });
    const backwards = buildReviewPrompt(REVIEW_TEST_JOB, identifier, source, target, {
      description: ['b'],
      name: ['a'],
    });
    assert.equal(forwards, backwards);
    assert.match(forwards, /\{"name":\["a"\],"description":\["b"\]\}/);
  });

  test('evidence reaches a monolingual prompt, which is why it is worth keeping', () => {
    // Keyed by source internally, but only the target renderings are printed, so
    // a coherence pass still learns that the corpus says this two ways.
    const prompt = buildReviewPrompt(MONOLINGUAL_TEST_JOB, identifier, source, target, {
      name: ['Politique A', 'Politique B'],
    });
    assert.match(prompt, /CONSISTENCY EVIDENCE .*\n\{"name":\["Politique A","Politique B"\]\}/);
  });
});

describe('the frame', () => {
  test('trailing whitespace in the guidance does not reach the prompt', () => {
    const job: ReviewJob = { ...REVIEW_TEST_JOB, promptTemplate: 'GUIDANCE\n\n\n   ' };
    assert.match(buildReviewPrompt(job, 'X', {}, {}), /^GUIDANCE\n\nReview these fields/);
  });

  test('names the language pair the way the translation job states it', () => {
    const job: ReviewJob = {
      ...REVIEW_TEST_JOB,
      translation: {
        ...REVIEW_TEST_JOB.translation,
        sourceLang: 'Deutsch',
        targetLang: 'Italiano',
      },
    };
    assert.match(buildReviewPrompt(job, 'X', {}, {}), /translated from Deutsch into Italiano:/);
  });

  test('a narrower reviewFields list narrows the prompt and the snapshot together', () => {
    const job: ReviewJob = { ...REVIEW_TEST_JOB, reviewFields: ['description'] };
    const prompt = buildReviewPrompt(job, identifier, source, target);
    assert.match(prompt, /: description\.\n/);
    assert.deepEqual(Object.keys(snapshotOf(prompt).fields), ['description']);
  });
});

/** The row-snapshot payload a prompt ends with. */
function snapshotOf(prompt: string): {
  identifier: string;
  fields: Record<string, Record<string, string | null>>;
} {
  const at = prompt.lastIndexOf(ROW_SNAPSHOT_MARKER);
  assert.notEqual(at, -1, 'every reviewer prompt carries a row snapshot');
  return JSON.parse(prompt.slice(at + ROW_SNAPSHOT_MARKER.length).trim());
}
