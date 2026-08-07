// The Codex invoker, driven through a stand-in CLI on PATH. No model is called.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { TransientFailure } from '../src/errors.ts';
import { CODEX_CONTEXT_TRIMS, codexTrimsFor, invokeCodex } from '../src/provider/codex.ts';
import type { InvokeArgs, ProviderOptions } from '../src/provider/types.ts';
import { type FakeCli, installFakeCli, scratchDir } from './helpers/fake-cli.ts';

const scratch = scratchDir('codex');
const SCHEMA_PATH = join(scratch.dir, 'schema.json');
/** Where the fake CLI dumps the argv it was handed, for the argv assertions. */
const ARGV_PATH = join(scratch.dir, 'argv.json');

/**
 * A fake `codex` that records its argv, then does whatever `body` says.
 * `body` is JS source evaluated in the child with `argv` in scope.
 */
function fakeCodex(body: string, exitCode = 0): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(ARGV_PATH)}, JSON.stringify(argv), 'utf8');`,
    "let prompt='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { prompt += c; });",
    "process.stdin.on('end', () => {",
    `  ${body}`,
    `  process.exit(${exitCode});`,
    '});',
  ].join('\n');
}

/** The value the CLI is told to write its answer to. */
const OUTPUT_FLAG = '--output-last-message';

const options = (over: Partial<ProviderOptions> = {}): ProviderOptions => ({
  cwd: scratch.dir,
  provider: 'codex',
  timeoutSeconds: 30,
  ...over,
});

const args = (name: string, over: Partial<ProviderOptions> = {}): InvokeArgs => ({
  prompt: 'translate this',
  responsePath: join(scratch.dir, `${name}.json`),
  schemaPath: SCHEMA_PATH,
  options: options(over),
});

const recordedArgv = (): string[] => JSON.parse(readFileSync(ARGV_PATH, 'utf8')) as string[];

/** The `--config` values in a recorded argv, in order. */
const configValues = (argv: string[]): string[] =>
  argv.flatMap((value, i) => (argv[i - 1] === '--config' ? [value] : []));

before(() => {
  writeFileSync(SCHEMA_PATH, '{"type":"object"}', 'utf8');
});
after(() => {
  scratch.remove();
});

describe('codexTrimsFor', () => {
  test('defaults to the measured list', () => {
    assert.equal(codexTrimsFor(undefined), CODEX_CONTEXT_TRIMS);
    assert.equal(codexTrimsFor('default'), CODEX_CONTEXT_TRIMS);
  });

  test('the project doc is silenced first, because nothing else covers it', () => {
    // `--ignore-rules` skips execpolicy files only, so without this entry every
    // row carries whatever agent instructions live in the working directory.
    assert.equal(CODEX_CONTEXT_TRIMS[0], 'project_doc_max_bytes=0');
  });

  test('every trim is a config assignment, never a --disable flag', () => {
    // `--disable` rejects a name the running build does not know and exits 1,
    // so a Codex upgrade that retired one entry would fail every row of a pass.
    // The config path ignores unknown keys, which is what a batch runner wants.
    for (const trim of CODEX_CONTEXT_TRIMS) {
      assert.match(trim, /^[\w.]+=\S+$/, `${trim} is not a config assignment`);
    }
  });

  test('can be turned off entirely, or replaced outright', () => {
    assert.deepEqual(codexTrimsFor('none'), []);
    assert.deepEqual(codexTrimsFor(['features.whatever=false']), ['features.whatever=false']);
  });
});

describe('invokeCodex', () => {
  let cli: FakeCli | null = null;
  after(() => cli?.restore());

  const withFake = (script: string): void => {
    cli?.restore();
    cli = installFakeCli('codex', script);
  };

  /** The CLI's contract: write the answer to the path it was given. */
  const writesAnswer = (json: string): string =>
    fakeCodex(
      `const out = argv[argv.indexOf(${JSON.stringify(OUTPUT_FLAG)}) + 1];` +
        `writeFileSync(out, ${JSON.stringify(json)}, 'utf8');`,
    );

  test('reads the answer back from the file the CLI was told to write', async () => {
    withFake(writesAnswer('{"identifier":"R-1","translations":{"a":"b"}}'));
    const result = await invokeCodex(args('happy'));
    assert.deepEqual(result.value, { identifier: 'R-1', translations: { a: 'b' } });
    assert.equal(result.exitCode, 0);
  });

  test('the schema and the response path are passed through as given', async () => {
    withFake(writesAnswer('{}'));
    const invocation = args('passthrough');
    await invokeCodex(invocation);

    const argv = recordedArgv();
    assert.equal(argv[argv.indexOf('--output-schema') + 1], SCHEMA_PATH);
    assert.equal(argv[argv.indexOf(OUTPUT_FLAG) + 1], invocation.responsePath);
    assert.equal(argv.at(-1), '-', 'the prompt arrives on stdin, not as an argument');
    assert.ok(argv.includes('--ephemeral'));
    assert.deepEqual(
      [argv.includes('--sandbox'), argv[argv.indexOf('--sandbox') + 1]],
      [true, 'read-only'],
      'a translation row has no business writing to the filesystem',
    );
  });

  test('the trims are sent as --config, and extras append after them', async () => {
    withFake(writesAnswer('{}'));
    await invokeCodex(args('trims', { codexConfig: ['features.mine=false'] }));

    assert.deepEqual(configValues(recordedArgv()), [...CODEX_CONTEXT_TRIMS, 'features.mine=false']);
  });

  test('reasoning effort is quoted the way the config parser wants it', async () => {
    withFake(writesAnswer('{}'));
    await invokeCodex(args('effort', { model: 'gpt-5.6-sol', reasoningEffort: 'high' }));

    const argv = recordedArgv();
    assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-5.6-sol');
    assert.ok(configValues(argv).includes('model_reasoning_effort="high"'));
  });

  test('turning the trims off sends none of them', async () => {
    withFake(writesAnswer('{}'));
    await invokeCodex(args('no-trims', { codexTrims: 'none' }));
    assert.deepEqual(configValues(recordedArgv()), []);
  });

  test('exiting cleanly without writing the file is missing_output', async () => {
    withFake(fakeCodex('void prompt;'));
    await assert.rejects(
      invokeCodex(args('silent')),
      (error: unknown) => error instanceof TransientFailure && error.category === 'missing_output',
    );
  });

  test('a file that is not JSON is invalid_json', async () => {
    withFake(writesAnswer('this is not json'));
    await assert.rejects(
      invokeCodex(args('garbage')),
      (error: unknown) => error instanceof TransientFailure && error.category === 'invalid_json',
    );
  });

  test('quota wording on a failed exit becomes quota, and keeps the useful line', async () => {
    withFake(
      fakeCodex(
        "process.stderr.write('some noise\\nYou have hit your usage limit. Try again at 18:00.\\n');",
        1,
      ),
    );
    await assert.rejects(
      invokeCodex(args('quota')),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'quota' &&
        error.message === 'You have hit your usage limit. Try again at 18:00.',
    );
  });

  test('an ordinary failed exit is exit_code and carries the status', async () => {
    withFake(fakeCodex("process.stderr.write('bad flag');", 2));
    await assert.rejects(
      invokeCodex(args('failed')),
      (error: unknown) =>
        error instanceof TransientFailure &&
        error.category === 'exit_code' &&
        error.exitCode === 2 &&
        error.message === 'bad flag',
    );
  });

  test('a failed exit with no diagnostics still says something', async () => {
    withFake(fakeCodex('void prompt;', 1));
    await assert.rejects(
      invokeCodex(args('mute')),
      (error: unknown) =>
        error instanceof TransientFailure && error.message === 'Codex exited without diagnostics',
    );
  });

  test('a stale response file from a previous attempt is removed first', async () => {
    withFake(fakeCodex('void prompt;'));
    const invocation = args('stale');
    writeFileSync(invocation.responsePath, '{"from":"an earlier attempt"}', 'utf8');

    await assert.rejects(
      invokeCodex(invocation),
      (error: unknown) => error instanceof TransientFailure && error.category === 'missing_output',
      'the stale file must not be mistaken for this attempt answering',
    );
    assert.equal(existsSync(invocation.responsePath), false);
  });

  test('the prompt reaches the CLI on stdin', async () => {
    withFake(
      fakeCodex(
        `const out = argv[argv.indexOf(${JSON.stringify(OUTPUT_FLAG)}) + 1];` +
          "writeFileSync(out, JSON.stringify({ echoed: prompt }), 'utf8');",
      ),
    );
    const result = await invokeCodex(args('stdin'));
    assert.deepEqual(result.value, { echoed: 'translate this' });
  });
});
