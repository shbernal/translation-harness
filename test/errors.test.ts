// The failure vocabulary. Small, and load-bearing: a batch that misreads a
// quota refusal as a retryable error spends the rest of its allowance
// rediscovering the same refusal, once per row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isQuotaError, QuotaExceeded, TransientFailure } from '../src/errors.ts';

describe('TransientFailure', () => {
  test('carries the category and the exit code the caller has to act on', () => {
    const error = new TransientFailure('timeout', 'too slow', 124);
    assert.equal(error.category, 'timeout');
    assert.equal(error.exitCode, 124);
    assert.equal(error.name, 'TransientFailure');
    assert.equal(error.message, 'too slow');
    assert.ok(error instanceof Error);
  });

  test('an exit code is optional, because not every failure has a process', () => {
    assert.equal(new TransientFailure('invalid_shape', 'missing field').exitCode, null);
  });
});

describe('QuotaExceeded', () => {
  test('is an Error, and is about the run rather than about one row', () => {
    const error = new QuotaExceeded('allowance gone');
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'allowance gone');
  });
});

describe('isQuotaError', () => {
  test('recognises the wordings the agent CLIs actually produce', () => {
    for (const message of [
      'You have hit your usage limit. Try again at 18:00.',
      'Claude usage limit reached',
      'rate limit exceeded, please retry',
      'Session limit reached for this account',
    ]) {
      assert.ok(isQuotaError(message), `${message} should read as a quota refusal`);
    }
  });

  test('is case-insensitive, because the wording is not stable across builds', () => {
    assert.ok(isQuotaError('USAGE LIMIT REACHED'));
    assert.ok(isQuotaError('Rate Limit'));
  });

  test('a 429 counts even with no recognisable wording', () => {
    assert.ok(isQuotaError('Too Many Requests', 429));
  });

  test('an ordinary failure is not a quota refusal', () => {
    // The cost of a false positive is a batch that stops with allowance left;
    // the cost of a false negative is spending the rest of it on retries.
    for (const message of [
      'bad flag',
      'Codex exited without diagnostics',
      'the prompt was rejected',
      'ENOENT: no such file or directory',
    ]) {
      assert.equal(isQuotaError(message), false, `${message} should not read as quota`);
    }
    assert.equal(isQuotaError('server error', 500), false);
  });
});
