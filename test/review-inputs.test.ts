// `extraInputs`: a host's own inputs reaching a derived run id.
//
// The case that matters most is the one that asserts nothing happens. A host
// that never sets the field must get the run ids it got before the field
// existed, which is only true while the empty digest is the empty string and
// the derivation appends rather than joins it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extraInputsDigest } from '../src/review/inputs.ts';
import { REVIEW_TEST_JOB } from './helpers/review-job.ts';

const digest = (extraInputs?: Record<string, string>): string =>
  extraInputsDigest({ ...REVIEW_TEST_JOB, extraInputs });

test('an absent bag digests to the empty string', () => {
  assert.equal(digest(undefined), '');
});

test('an empty bag digests to the empty string', () => {
  assert.equal(digest({}), '');
});

test('a populated bag digests to a sha256', () => {
  assert.match(digest({ termbase: 'abc123' }), /^[0-9a-f]{64}$/);
});

test('key insertion order does not reach the digest', () => {
  assert.equal(
    digest({ termbase: 'abc', styleGuide: 'def' }),
    digest({ styleGuide: 'def', termbase: 'abc' }),
  );
});

test('a different value is a different digest', () => {
  assert.notEqual(digest({ termbase: 'abc' }), digest({ termbase: 'abd' }));
});

test('an added key is a different digest', () => {
  assert.notEqual(digest({ termbase: 'abc' }), digest({ termbase: 'abc', styleGuide: '' }));
});

test('a key with an empty value is not the same as no key at all', () => {
  // The distinction the type system cannot make and the digest has to: a host
  // that declares an input and has nothing in it this time has still declared
  // it, and next time it will not be empty.
  assert.notEqual(digest({ termbase: '' }), digest({}));
  assert.notEqual(digest({ termbase: '' }), '');
});

test('a key whose name differs is a different digest', () => {
  assert.notEqual(digest({ a: 'x' }), digest({ b: 'x' }));
});

test('a non-string value is refused rather than dropped', () => {
  // JSON.stringify would drop an undefined value silently, which would make
  // two different sets of inputs agree on one id - the exact collision the
  // mechanism exists to prevent.
  for (const value of [undefined, 1, null, {}] as unknown[]) {
    assert.throws(
      () => extraInputsDigest({ ...REVIEW_TEST_JOB, extraInputs: { k: value } as never }),
      /extraInputs\['k'\] must be a string/,
    );
  }
});
