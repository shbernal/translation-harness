// The offline provider: the whole loop, free and instant. It is what makes the
// difference between a library you can try and one you can only read about, so
// it gets tested like a shipped feature rather than like a test double.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { invokeMock, MOCK_PROVIDER_NAME, registerMockProvider } from '../src/contract/mock.ts';
import { buildPrompt } from '../src/contract/prompt.ts';
import { validateResponse } from '../src/contract/validate.ts';
import { TransientFailure } from '../src/errors.ts';
import type { Fields } from '../src/job.ts';
import { hasProvider, invokeProvider } from '../src/provider/registry.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { TEST_JOB } from './helpers/job.ts';

async function invoke(source: Fields, prompt?: string): Promise<unknown> {
  const scratch = scratchDir('mock');
  const responsePath = join(scratch.dir, 'out.json');
  try {
    const { value } = await invokeMock({
      prompt: prompt ?? buildPrompt(TEST_JOB, 'AC-1', source),
      responsePath,
      schemaPath: 'unused.json',
      options: { cwd: scratch.dir, provider: 'mock', timeoutSeconds: 1 },
    });
    // The parsed value and the file on disk must agree, because the pipeline
    // keeps the file as evidence and uses the value.
    assert.deepEqual(value, JSON.parse(readFileSync(responsePath, 'utf8')));
    return value;
  } finally {
    scratch.remove();
  }
}

describe('invokeMock', () => {
  test('echoes the identifier and translatable fields, preserving null', async () => {
    const value = await invoke({
      name: 'Access Control Policy',
      type: 'passthrough',
      description: null,
    });
    assert.deepEqual(value, {
      identifier: 'AC-1',
      translations: { name: 'mock: Access Control Policy', description: null },
      warnings: [],
    });
  });

  test('its output validates as succeeded for a well-formed row', async () => {
    const source = { name: 'Access Control Policy', type: 'x', description: 'A long description.' };
    const value = await invoke(source);
    const { translations, reviewReasons } = validateResponse(TEST_JOB, source, 'AC-1', value);
    assert.deepEqual(reviewReasons, []);
    assert.equal(translations.name, 'mock: Access Control Policy');
  });

  test('brackets and references survive, so the guardrails see a realistic row', async () => {
    const source = { name: 'See AC-2 [Assignment: value]', type: 'x', description: 'Also AC-3.' };
    const value = await invoke(source);
    const { reviewReasons } = validateResponse(TEST_JOB, source, 'AC-1', value);
    assert.deepEqual(reviewReasons, []);
  });

  test('launches no subprocess, so a whole batch of it is instant', async () => {
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 50 }, () => invoke({ name: 'x', type: 'y', description: 'z' })),
    );
    assert.ok(Date.now() - started < 5_000, 'fifty rows should not take seconds');
  });

  test('a prompt with no payload marker is a failure, not a fabricated answer', async () => {
    await assert.rejects(
      invoke({}, 'just some text with no marker'),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'missing_output' &&
        /no source payload/.test(error.message),
    );
  });

  test('a malformed payload is invalid_json', async () => {
    await assert.rejects(
      invoke({}, 'SOURCE ROW JSON:\n{not json}'),
      (error: unknown) => error instanceof TransientFailure && error.category === 'invalid_json',
    );
  });

  test('the last marker wins, so guidance quoting the marker cannot confuse it', async () => {
    const source = { name: 'Policy', type: 'x', description: 'd' };
    const prompt = `SOURCE ROW JSON:\n{"identifier":"DECOY"}\n${buildPrompt(TEST_JOB, 'AC-1', source)}`;
    const value = (await invoke(source, prompt)) as { identifier: string };
    assert.equal(value.identifier, 'AC-1');
  });
});

describe('registerMockProvider', () => {
  test('is opt-in, and lands under a name of the caller choosing', async () => {
    // A provider that fabricates plausible-looking translations must never be
    // one typo away from a production run, which is why it is not registered
    // on import the way codex and claude are.
    assert.equal(hasProvider('offline-for-tests'), false);
    registerMockProvider('offline-for-tests');
    assert.ok(hasProvider('offline-for-tests'));

    registerMockProvider();
    assert.ok(hasProvider(MOCK_PROVIDER_NAME));

    const scratch = scratchDir('mock-registry');
    try {
      const result = await invokeProvider({
        prompt: buildPrompt(TEST_JOB, 'AC-1', { name: 'Policy', description: 'd' }),
        responsePath: join(scratch.dir, 'out.json'),
        schemaPath: 'unused.json',
        options: { cwd: scratch.dir, provider: MOCK_PROVIDER_NAME, timeoutSeconds: 1 },
      });
      assert.deepEqual(result.value, {
        identifier: 'AC-1',
        translations: { name: 'mock: Policy', description: 'mock: d' },
        warnings: [],
      });
    } finally {
      scratch.remove();
    }
  });
});
