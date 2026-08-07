// The subprocess layer, exercised against `node -e` rather than a real provider:
// offline, free, and it pins the behaviour that used to be implicit in
// `spawnSync` and is now written out by hand. Nothing here calls a model.

import assert from 'node:assert/strict';
import process from 'node:process';
import { describe, test } from 'node:test';
import { HOST, launcher, MAX_BUFFER, run, treeKillCommand } from '../src/provider/run.ts';
import type { ProviderOptions } from '../src/provider/types.ts';

const NODE = process.execPath;

const opts = (over: Partial<ProviderOptions> = {}): ProviderOptions => ({
  cwd: process.cwd(),
  provider: 'codex',
  timeoutSeconds: 30,
  ...over,
});

describe('run()', () => {
  test('the prompt goes in on stdin and stdout, stderr and exit code come back', async () => {
    const res = await run(
      NODE,
      [
        '-e',
        "let s='';process.stdin.on('data',c=>{s+=c});process.stdin.on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('warned');process.exit(3)})",
      ],
      'hello prompt',
      opts(),
    );
    assert.equal(res.stdout, 'HELLO PROMPT', 'stdin was delivered and then closed');
    assert.equal(res.stderr, 'warned');
    assert.equal(res.status, 3);
    assert.equal(res.timedOut, false);
    assert.equal(res.launchError, null);
  });

  test('the child runs in the requested working directory', async () => {
    const res = await run(NODE, ['-e', 'process.stdout.write(process.cwd())'], '', opts());
    assert.equal(res.stdout, process.cwd());
  });

  test('a timeout kills the child, resolves promptly, and is not a launch failure', async () => {
    const started = Date.now();
    const res = await run(
      NODE,
      ['-e', 'setTimeout(()=>{},60000)'],
      '',
      opts({ timeoutSeconds: 0.25 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(res.timedOut, true);
    assert.equal(res.launchError, null, 'the two classify differently and must not be confused');
    assert.ok(elapsed < 20_000, `resolved in ${elapsed}ms, so the tree kill did not hang`);
  });

  test('a binary that does not exist is a launch failure, not a timeout', async () => {
    const res = await run('definitely-not-a-real-binary-xyz', [], '', opts());
    assert.ok(res.launchError, 'the error event surfaces as a launch failure');
    assert.equal(res.timedOut, false);
    assert.equal(res.status, null);
  });

  test('a timeout and a launch failure stay distinguishable', async () => {
    const timeout = await run(
      NODE,
      ['-e', 'setTimeout(()=>{},60000)'],
      '',
      opts({ timeoutSeconds: 0.25 }),
    );
    const launch = await run('definitely-not-a-real-binary-xyz', [], '', opts());

    assert.deepEqual(
      [timeout.timedOut, timeout.launchError === null],
      [true, true],
      'a timeout reports only as a timeout',
    );
    assert.deepEqual(
      [launch.timedOut, launch.launchError === null],
      [false, false],
      'a launch failure reports only as a launch failure',
    );
  });

  test('output larger than one chunk is reassembled intact', async () => {
    // The accumulator is hand-written now that `maxBuffer` is gone, so a payload
    // well past a single pipe read has to come back whole.
    const size = 2 * 1024 * 1024;
    const res = await run(NODE, ['-e', `process.stdout.write('x'.repeat(${size}))`], '', opts());
    assert.equal(res.stdout.length, size);
    assert.equal(res.status, 0);
  });

  test('output past the cap kills the child and reports as a launch failure', async () => {
    // What `spawnSync`'s own `maxBuffer` breach did (ENOBUFS in `res.error`),
    // restated by hand, because there is no async equivalent to inherit.
    const chunk = 4 * 1024 * 1024;
    const chunks = Math.ceil(MAX_BUFFER / chunk) + 2;
    const res = await run(
      NODE,
      [
        '-e',
        `const s='x'.repeat(${chunk});let n=0;const w=()=>{while(n<${chunks}){n++;if(!process.stdout.write(s))return process.stdout.once('drain',w)}};w();setTimeout(()=>{},60000)`,
      ],
      '',
      opts(),
    );
    assert.ok(res.launchError, 'overflow surfaces the way a launch failure does');
    assert.match(String(res.launchError?.message), /exceeded 33554432 bytes and was killed/);
    assert.equal(res.timedOut, false, 'the cap fired, not the timer');
    assert.ok(res.stdout.length <= MAX_BUFFER, 'the accumulator stopped at the cap');
  });

  test('a child that exits without reading the prompt does not crash the runner', async () => {
    // stdin emits EPIPE; what matters is the child's own exit code, not the write.
    const res = await run(NODE, ['-e', 'process.exit(7)'], 'x'.repeat(1024 * 1024), opts());
    assert.equal(res.status, 7);
    assert.equal(res.launchError, null);
  });

  test('a timeout of zero disables the timer rather than firing immediately', async () => {
    const res = await run(
      NODE,
      ['-e', 'setTimeout(()=>process.stdout.write("slept"),300)'],
      '',
      opts({ timeoutSeconds: 0 }),
    );
    assert.equal(res.timedOut, false);
    assert.equal(res.stdout, 'slept');
  });
});

// Both branches of every platform-dependent decision, from either host. This is
// the whole reason the platform is a parameter instead of a module-scope
// `process.platform` read: on the private version of this code these two paths
// were the parts most worth publishing and the parts CI never touched.
describe('platform-dependent argv, from either host', () => {
  const WIN = { win32: true } as const;
  const POSIX = { win32: false } as const;

  test('on Windows a CLI is reached through the command interpreter', () => {
    const previous = process.env.COMSPEC;
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    try {
      assert.deepEqual(launcher('codex', WIN), {
        cmd: 'C:\\Windows\\System32\\cmd.exe',
        pre: ['/d', '/c', 'codex.cmd'],
      });
    } finally {
      if (previous === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = previous;
    }
  });

  test('on Windows the interpreter falls back to cmd.exe when COMSPEC is unset', () => {
    const previous = process.env.COMSPEC;
    delete process.env.COMSPEC;
    try {
      assert.equal(launcher('claude', WIN).cmd, 'cmd.exe');
    } finally {
      if (previous !== undefined) process.env.COMSPEC = previous;
    }
  });

  test('everywhere else the name is the executable', () => {
    assert.deepEqual(launcher('codex', POSIX), { cmd: 'codex', pre: [] });
  });

  test('only Windows has a process tree to kill separately', () => {
    assert.deepEqual(treeKillCommand(4321, WIN), {
      cmd: 'taskkill',
      args: ['/pid', '4321', '/T', '/F'],
    });
    assert.equal(treeKillCommand(4321, POSIX), null, 'elsewhere killing the child is enough');
  });

  test('the default platform is the real one', () => {
    assert.equal(HOST.win32, process.platform === 'win32');
    assert.deepEqual(launcher('codex'), launcher('codex', HOST));
  });
});
