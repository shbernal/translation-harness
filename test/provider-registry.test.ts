// The open registry and the profile table. Both exist so a consumer never has
// to fork the package to name something this package has not heard of.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import { DEFAULT_PROFILES, resolveProfile } from '../src/provider/profiles.ts';
import {
  hasProvider,
  invokeProvider,
  providerNames,
  registerProvider,
} from '../src/provider/registry.ts';
import type { InvokeArgs, ProviderResult } from '../src/provider/types.ts';

const invocation = (provider: string): InvokeArgs => ({
  prompt: 'p',
  responsePath: 'r.json',
  schemaPath: 's.json',
  options: { cwd: '.', provider, timeoutSeconds: 1 },
});

const stub = (value: unknown) => async (): Promise<ProviderResult> => ({
  value,
  stdout: '',
  stderr: '',
  exitCode: 0,
  duration: 0,
});

describe('the provider registry', () => {
  test('the two built-in agent CLIs are registered on import', () => {
    assert.ok(hasProvider('codex'));
    assert.ok(hasProvider('claude'));
  });

  test('the mock provider is not here, because it knows what a translation is', () => {
    // It parses the prompt payload, which is contract knowledge, so it lives a
    // layer up and registers only when the host asks for it.
    assert.equal(hasProvider('mock'), false);
  });

  test('a consumer can register a provider this package has never heard of', async () => {
    registerProvider('my-http-backend', stub({ from: 'http' }));
    assert.ok(providerNames().includes('my-http-backend'));

    const result = await invokeProvider(invocation('my-http-backend'));
    assert.deepEqual(result.value, { from: 'http' });
  });

  test('re-registering a name replaces it, so a built-in can be overridden', async () => {
    registerProvider('replaceable', stub('first'));
    registerProvider('replaceable', stub('second'));
    const result = await invokeProvider(invocation('replaceable'));
    assert.equal(result.value, 'second');
  });

  test('an unknown name is a launcher failure, not a thrown Error', async () => {
    // It reaches a running batch the way a missing binary does: as one row that
    // could not start. The batch records it and carries on rather than dying
    // partway through with rows half-claimed.
    await assert.rejects(
      invokeProvider(invocation('nope')),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'launcher' &&
        /Unknown translation provider: nope/.test(error.message) &&
        /registered: /.test(error.message),
    );
  });
});

describe('model profiles', () => {
  test('no profile named is no profile, not an error', () => {
    assert.deepEqual(resolveProfile(undefined), { name: null, profile: null });
    assert.deepEqual(resolveProfile(''), { name: null, profile: null });
  });

  test('a known name resolves to an exact provider and model', () => {
    assert.deepEqual(resolveProfile('gpt-5-6-high'), {
      name: 'gpt-5-6-high',
      profile: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
  });

  test('an unknown name fails loudly and lists what there is', () => {
    assert.throws(
      () => resolveProfile('not-a-profile'),
      /Unknown model profile 'not-a-profile'\. Available: /,
    );
  });

  test('a caller can supply their own table without waiting on a release', () => {
    // The default table names specific model ids, and model ids age faster than
    // releases do. That is the whole reason the table is a parameter.
    const mine = { house: { provider: 'my-http-backend', model: 'm-1', reasoningEffort: null } };
    assert.deepEqual(resolveProfile('house', mine), { name: 'house', profile: mine.house });
    assert.throws(() => resolveProfile('gpt-5-6-high', mine), /Available: house/);
  });

  test('every default profile names a provider and is internally consistent', () => {
    for (const [name, profile] of Object.entries(DEFAULT_PROFILES)) {
      assert.ok(profile.provider, `${name} names no provider`);
      assert.ok(
        profile.model !== null || profile.reasoningEffort !== null,
        `${name} pins nothing, so it is the config-default hazard wearing a name`,
      );
    }
  });
});
