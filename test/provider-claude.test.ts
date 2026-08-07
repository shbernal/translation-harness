// The Claude invoker, driven through a stand-in CLI on PATH so the launcher
// shim is exercised rather than bypassed. No model is ever called.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import { extractJsonObject, invokeClaude } from '../src/provider/claude.ts';
import type { InvokeArgs, ProviderOptions } from '../src/provider/types.ts';
import { type FakeCli, installFakeCli, scratchDir } from './helpers/fake-cli.ts';

const scratch = scratchDir('claude');
const SCHEMA_PATH = join(scratch.dir, 'schema.json');

/**
 * A fake `claude` that prints one envelope and exits. `envelope` is JS source
 * evaluated in the child, so a test can build the reply from the prompt it was
 * given.
 */
function fakeClaude(envelope: string, exitCode = 0): string {
  return [
    "let prompt='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { prompt += c; });",
    "process.stdin.on('end', () => {",
    '  const argv = process.argv.slice(2);',
    `  const envelope = ${envelope};`,
    '  process.stdout.write(JSON.stringify(envelope));',
    `  process.exit(${exitCode});`,
    '});',
  ].join('\n');
}

const options = (over: Partial<ProviderOptions> = {}): ProviderOptions => ({
  cwd: scratch.dir,
  provider: 'claude',
  timeoutSeconds: 30,
  ...over,
});

const args = (name: string, over: Partial<ProviderOptions> = {}): InvokeArgs => ({
  prompt: 'translate this',
  responsePath: join(scratch.dir, `${name}.json`),
  schemaPath: SCHEMA_PATH,
  options: options(over),
});

before(() => {
  writeFileSync(SCHEMA_PATH, '{"type":"object"}', 'utf8');
});
after(() => {
  scratch.remove();
});

describe('extractJsonObject', () => {
  test('takes the object out of a bare reply', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  test('survives a code fence, which is what the instruction not to use one gets', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 });
  });

  test('survives prose on either side', () => {
    assert.deepEqual(extractJsonObject('Sure, here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  });

  test('a reply with no object at all is invalid_json, not a crash', () => {
    assert.throws(
      () => extractJsonObject('I would rather not.'),
      (error: unknown) => error instanceof TransientFailure && error.category === 'invalid_json',
    );
  });

  test('an object that will not parse is invalid_json', () => {
    assert.throws(
      () => extractJsonObject('{"a": }'),
      (error: unknown) => error instanceof TransientFailure && error.category === 'invalid_json',
    );
  });
});

describe('invokeClaude', () => {
  let cli: FakeCli | null = null;
  after(() => cli?.restore());

  const withFake = (script: string): void => {
    cli?.restore();
    cli = installFakeCli('claude', script);
  };

  test('a success envelope yields the parsed result and writes it to responsePath', async () => {
    withFake(
      fakeClaude(
        '{ subtype: "success", is_error: false, result: JSON.stringify({ ok: true, echoed: prompt }) }',
      ),
    );
    const invocation = args('success');
    const result = await invokeClaude(invocation);

    assert.deepEqual(result.value, { ok: true, echoed: 'translate this' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(invocation.responsePath, 'utf8')), result.value);
  });

  test('the system prompt is written beside the response as audit evidence', async () => {
    withFake(fakeClaude('{ subtype: "success", is_error: false, result: "{}" }'));
    const invocation = args('audit');
    await invokeClaude(invocation);

    const sidecar = invocation.responsePath.replace(/\.json$/, '') + '.system-prompt.txt';
    assert.ok(existsSync(sidecar), 'the exact system prompt that produced the answer is kept');
    const text = readFileSync(sidecar, 'utf8');
    assert.match(text, /non-interactive translation function/);
    assert.match(text, /OUTPUT SCHEMA:\n\{"type":"object"\}/, 'the schema is embedded verbatim');
  });

  test('a substituted model is refused rather than silently accepted', async () => {
    // The CLI reports what it actually used, and a batch whose provenance says
    // one model while another did the work is worse than a batch that stopped.
    withFake(
      fakeClaude(
        '{ subtype: "success", is_error: false, result: "{}", modelUsage: { "claude-haiku-4-5": {} } }',
      ),
    );
    await assert.rejects(
      invokeClaude(args('substituted', { model: 'claude-opus-5' })),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'exit_code' &&
        /used claude-haiku-4-5 instead of requested model claude-opus-5/.test(error.message),
    );
  });

  test('the id-with-suffix form the envelope sometimes carries counts as a match', async () => {
    withFake(
      fakeClaude(
        '{ subtype: "success", is_error: false, result: "{}", modelUsage: { "claude-opus-5[1m]": {} } }',
      ),
    );
    const result = await invokeClaude(args('suffixed', { model: 'claude-opus-5' }));
    assert.deepEqual(result.value, {});
  });

  test('an unreported model is refused too', async () => {
    withFake(fakeClaude('{ subtype: "success", is_error: false, result: "{}" }'));
    await assert.rejects(
      invokeClaude(args('unreported', { model: 'claude-opus-5' })),
      (error: unknown) =>
        error instanceof TransientFailure && /an unreported model/.test(error.message),
    );
  });

  test('a non-claude model id skips the check rather than failing it', async () => {
    withFake(fakeClaude('{ subtype: "success", is_error: false, result: "{}" }'));
    const result = await invokeClaude(args('other-model', { model: 'some-other-model' }));
    assert.deepEqual(result.value, {});
  });

  test('quota wording in an error envelope becomes a quota failure, not exit_code', async () => {
    withFake(
      fakeClaude(
        '{ subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached. Resets at 6pm." }',
      ),
    );
    await assert.rejects(
      invokeClaude(args('quota')),
      (error: unknown) => error instanceof TransientFailure && error.category === 'quota',
    );
  });

  test('a 429 with no quota wording is still a quota failure', async () => {
    withFake(
      fakeClaude(
        '{ subtype: "error_during_execution", is_error: true, result: "Too Many Requests", api_error_status: 429 }',
      ),
    );
    await assert.rejects(
      invokeClaude(args('status-429')),
      (error: unknown) => error instanceof TransientFailure && error.category === 'quota',
    );
  });

  test('an ordinary error envelope is exit_code', async () => {
    withFake(
      fakeClaude(
        '{ subtype: "error_during_execution", is_error: true, result: "the prompt was rejected" }',
      ),
    );
    await assert.rejects(
      invokeClaude(args('errored')),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'exit_code' &&
        error.message === 'the prompt was rejected',
    );
  });

  test('a non-JSON envelope is reported as such, not as a bad answer', async () => {
    // The distinction matters: the envelope is the CLI's, the result is the
    // model's, and a broken envelope means the CLI misbehaved.
    withFake("process.stdout.write('not json at all');");
    await assert.rejects(
      invokeClaude(args('bad-envelope')),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'invalid_json' &&
        /Claude envelope was not JSON/.test(error.message),
    );
  });

  test('a non-zero exit is classified from whatever the CLI said', async () => {
    withFake(fakeClaude('{ subtype: "success" }', 9));
    await assert.rejects(
      invokeClaude(args('exit-9')),
      (error: unknown) => error instanceof TransientFailure && error.exitCode === 9,
    );
  });

  test('a stale response file from a previous attempt is removed first', async () => {
    withFake(fakeClaude('{ subtype: "error_during_execution", is_error: true, result: "nope" }'));
    const invocation = args('stale');
    writeFileSync(invocation.responsePath, '{"from":"an earlier attempt"}', 'utf8');

    await assert.rejects(invokeClaude(invocation));
    assert.equal(
      existsSync(invocation.responsePath),
      false,
      'a failed attempt must not leave the previous answer looking like this one',
    );
  });
});
