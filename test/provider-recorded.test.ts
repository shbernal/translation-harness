// The invokers against output a real agent actually produced.
//
// Everything else in the provider tests feeds the parsers something we wrote,
// which means it tests what we believe a CLI emits. These fixtures were
// captured from `codex` and `claude` once, scrubbed, and committed, so the
// parsers are held to the real shape: a Claude envelope with its whole
// `modelUsage` map, a Codex run whose answer arrives as a file and whose
// stdout is not JSON at all, and a refusal whose exact wording decides which
// failure category a row gets.
//
// No model is called. The recorded bytes are replayed by a fake CLI on PATH,
// and the invoker under test is the real one.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import { invokeClaude } from '../src/provider/claude.ts';
import { invokeCodex } from '../src/provider/codex.ts';
import type { ProviderOptions } from '../src/provider/types.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { recordedCase, recordedCases, recordedFile, replayRecorded } from './helpers/recorded.ts';

const options = (over: Partial<ProviderOptions> = {}): ProviderOptions => ({
  cwd: process.cwd(),
  provider: 'codex',
  timeoutSeconds: 30,
  ...over,
});

/** Run `fn` with the case's provider replaying on PATH, in a scratch dir. */
async function replaying<T>(
  label: string,
  fn: (paths: { response: string; schema: string }) => Promise<T>,
): Promise<T> {
  const c = recordedCase(label);
  const cli = replayRecorded(c);
  const scratch = scratchDir(`recorded-${label}`);
  const schema = join(scratch.dir, 'schema.json');
  writeFileSync(schema, '{"type":"object"}\n', 'utf8');
  try {
    return await fn({ response: join(scratch.dir, 'response.json'), schema });
  } finally {
    cli.restore();
    scratch.remove();
  }
}

test('every recorded case says what it is and where its payload came from', () => {
  const cases = recordedCases();
  assert.ok(cases.length >= 3, `only ${cases.length} recorded cases`);
  for (const c of cases) {
    assert.ok(c.meta.label.length > 0);
    assert.ok(['codex', 'claude'].includes(c.meta.provider), c.meta.provider);
    // The payload note is the audit trail for the one directory nobody
    // re-reads: it states that what was sent is committed fixture material.
    assert.match(c.meta.payload, /kubernetes-glossary/);
    assert.ok(c.files.includes('meta.json') && c.files.includes('prompt.txt'));
  }
});

test('no recorded file carries a path, a session id or an address', () => {
  // The scrubbing happened at capture time and is not re-runnable, so this is
  // the guard that keeps a future capture from landing unscrubbed beside these.
  const risks: [string, RegExp][] = [
    ['a Windows user path', /[A-Za-z]:[\\/]Users[\\/]/],
    ['a posix home path', /\/home\/[a-z]/i],
    ['a uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ['an api key', /sk-[A-Za-z0-9_-]{16,}/],
    ['a bearer token', /bearer\s+[A-Za-z0-9._-]{16,}/i],
    ['an email address', /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
  ];
  for (const c of recordedCases()) {
    for (const name of c.files) {
      const text = readFileSync(join(c.dir, name), 'utf8');
      for (const [label, pattern] of risks) {
        assert.equal(pattern.test(text), false, `${c.meta.label}/${name} contains ${label}`);
      }
    }
  }
});

test('codex: a real run parses, and the answer comes from the file not from stdout', async () => {
  await replaying('codex-success', async ({ response, schema }) => {
    const result = await invokeCodex({
      prompt: 'unused: the replay ignores stdin',
      responsePath: response,
      schemaPath: schema,
      options: options({ provider: 'codex', model: 'gpt-5.6-sol' }),
    });
    const value = result.value as {
      identifier: string;
      translations: { title: string; shortDescription: string };
    };
    assert.equal(value.identifier, 'pod');
    assert.equal(value.translations.title, 'Pod');
    assert.match(value.translations.shortDescription, /^Un Pod/);
    // Codex prints a human banner to stderr and the answer to both stdout and
    // the file. The invoker reads the file, which is the contract that lets it
    // ignore whatever the CLI decides to print.
    assert.match(result.stderr, /OpenAI Codex v/);
    assert.match(result.stderr, /reasoning effort: high/);
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(response));
  });
});

test('codex: an untrusted working directory is an exit_code failure, in its own words', async () => {
  // The constraint this case exists for: the invoker does not pass
  // `--skip-git-repo-check`, so `ProviderOptions.cwd` has to be a directory
  // Codex trusts. In the intended use it is the consumer's project root, which
  // is one; a scratch directory is not, and this is exactly what that looks
  // like when it happens on row one of a pass.
  await replaying('codex-untrusted-cwd', async ({ response, schema }) => {
    const error = await invokeCodex({
      prompt: 'x',
      responsePath: response,
      schemaPath: schema,
      options: options({ provider: 'codex' }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TransientFailure, 'expected a TransientFailure');
    assert.equal(error.category, 'exit_code', 'a refusal is not a quota failure');
    assert.match(error.message, /trusted directory/);
    assert.equal(error.exitCode, 1);
  });
});

test('claude: a real envelope parses, and the exact-model check reads modelUsage', async () => {
  await replaying('claude-success', async ({ response, schema }) => {
    const result = await invokeClaude({
      prompt: 'x',
      responsePath: response,
      schemaPath: schema,
      options: options({ provider: 'claude', model: 'claude-sonnet-5' }),
    });
    const value = result.value as { identifier: string };
    assert.equal(value.identifier, 'pod');
    // The envelope really does carry a second model: Claude Code bills its own
    // internal Haiku call in the same map. The check has to find the requested
    // one among them rather than expect it alone.
    const envelope = JSON.parse(recordedFile(recordedCase('claude-success'), 'stdout.log')) as {
      modelUsage: Record<string, unknown>;
    };
    assert.ok(Object.keys(envelope.modelUsage).length > 1, 'the fixture stopped being interesting');
    assert.ok('claude-sonnet-5' in envelope.modelUsage);
    // The invoker writes the parsed object out itself; Claude never touches the
    // response path.
    assert.ok(existsSync(response));
    assert.deepEqual(JSON.parse(readFileSync(response, 'utf8')), result.value);
  });
});

test('claude: a model that was not the one requested is refused', async () => {
  await replaying('claude-success', async ({ response, schema }) => {
    const error = await invokeClaude({
      prompt: 'x',
      responsePath: response,
      schemaPath: schema,
      options: options({ provider: 'claude', model: 'claude-opus-5' }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TransientFailure);
    assert.match(error.message, /instead of requested model claude-opus-5/);
  });
});

test('claude: a fenced answer with prose around it still yields the object', async () => {
  // The one no hand-written string can honestly stand in for: a real model
  // given a contrary instruction, wrapping its JSON in a ```json fence with a
  // sentence on either side. This is what extractJsonObject is for.
  const fenced = recordedCase('claude-fenced');
  const envelope = JSON.parse(recordedFile(fenced, 'stdout.log')) as { result: string };
  assert.match(envelope.result, /^```json/, 'the fixture is no longer a fenced answer');
  assert.match(envelope.result, /Voici/, 'the fixture no longer has prose after the fence');

  await replaying('claude-fenced', async ({ response, schema }) => {
    const result = await invokeClaude({
      prompt: 'x',
      responsePath: response,
      schemaPath: schema,
      options: options({ provider: 'claude', model: 'claude-sonnet-5' }),
    });
    const value = result.value as { identifier: string; warnings: unknown[] };
    assert.equal(value.identifier, 'pod');
    assert.deepEqual(value.warnings, []);
  });
});
