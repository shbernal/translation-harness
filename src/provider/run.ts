// Launching a provider and collecting what it produced. This is the layer that
// exists because a synchronous version of it failed: every behaviour restated
// by hand below was previously implicit in `spawnSync` and had to be rebuilt
// when the pipeline became concurrent.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import type { Platform, ProviderOptions, RunResult } from './types.ts';

/**
 * The platform this process is actually on.
 *
 * Every function here takes a `Platform` and defaults to this one rather than
 * reading `process.platform` where it is used. The Windows paths (the `.cmd`
 * launcher shim, the process-tree kill) are among the most valuable things in
 * this package and are exactly what a Linux-only test run would never reach,
 * so both branches have to be reachable from either host.
 */
export const HOST: Platform = { win32: process.platform === 'win32' };

/**
 * The output ceiling, per attempt, across both streams.
 *
 * There is no async equivalent of `spawnSync`'s `maxBuffer`, so it is enforced
 * by hand. Without it a provider stuck in a loop is an out-of-memory crash of
 * the whole batch rather than one failed row.
 */
export const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * How to invoke a globally installed agent CLI.
 *
 * On Windows an npm-installed CLI is a `.cmd` shim, which `spawn` cannot
 * execute directly, so it goes through the command interpreter:
 * `%COMSPEC% /d /c <name>.cmd`. `/d` skips AutoRun commands, which would
 * otherwise inject whatever the machine's registry has configured into every
 * single attempt. Everywhere else the name is the executable.
 */
export function launcher(name: string, platform: Platform = HOST): { cmd: string; pre: string[] } {
  if (platform.win32) {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return { cmd: comspec, pre: ['/d', '/c', `${name}.cmd`] };
  }
  return { cmd: name, pre: [] };
}

/**
 * The command that kills a whole process tree on this platform, or `null` where
 * killing the child is enough.
 *
 * Split out from `killTree` so the argv can be asserted on either host without
 * spawning anything. See `killTree` for why the tree, and not just the child.
 */
export function treeKillCommand(
  pid: number,
  platform: Platform = HOST,
): { cmd: string; args: string[] } | null {
  if (!platform.win32) return null;
  return { cmd: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
}

/**
 * Kill a provider and everything it started.
 *
 * On Windows the child is `%COMSPEC% /d /c <name>.cmd`, and killing the wrapper
 * leaves the CLI it launched running - the shim has already handed off. A
 * stranded agent would hold its quota slot and keep writing, so the whole tree
 * goes at once. `taskkill` is called synchronously on purpose: this runs on the
 * timeout path only, and the next row spawns a provider immediately, so the
 * tree must be gone before we resolve rather than eventually.
 */
export function killTree(child: ChildProcess, platform: Platform = HOST): void {
  const tree = child.pid === undefined ? null : treeKillCommand(child.pid, platform);
  if (tree) spawnSync(tree.cmd, tree.args, { stdio: 'ignore' });
  child.kill('SIGKILL');
}

/**
 * Launch a provider and collect its output without blocking the event loop.
 *
 * This is why the pipeline can be concurrent at all. `spawnSync` held the loop
 * for the entire subprocess, so N workers awaiting a provider would still have
 * executed strictly one at a time and a worker pool would have been a no-op.
 *
 * Everything `spawnSync` gave implicitly is restated here on purpose:
 * - the prompt goes to **stdin**, which is then closed;
 * - `cwd` is the caller's working directory;
 * - **timeout** is an explicit timer that kills the tree and classifies the
 *   result, where `spawnSync` surfaced it as `SIGTERM` / `ETIMEDOUT`;
 * - a **launch failure** arrives as an `error` event and stays distinct from a
 *   timeout, because they call for different failure categories;
 * - the 32 MiB **output cap** has no async equivalent, so it is enforced by hand.
 *   Without it a runaway provider is an out-of-memory crash rather than a failed
 *   row. Overflow kills the child and reports as a launch failure, which is what
 *   `spawnSync`'s own `maxBuffer` breach did (`ENOBUFS` in `res.error`).
 */
export function run(
  cmd: string,
  args: string[],
  prompt: string,
  options: ProviderOptions,
  platform: Platform = HOST,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let size = 0;
    let timedOut = false;
    let overflowed = false;
    let launchError: Error | null = null;
    let settled = false;

    const child = spawn(cmd, args, { cwd: options.cwd });

    const timer =
      options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child, platform);
          }, options.timeoutSeconds * 1000)
        : null;

    const collect = (sink: string[]) => (chunk: string) => {
      if (overflowed) return;
      const room = MAX_BUFFER - size;
      if (chunk.length >= room) {
        sink.push(chunk.slice(0, room));
        size = MAX_BUFFER;
        overflowed = true;
        killTree(child, platform);
        return;
      }
      sink.push(chunk);
      size += chunk.length;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    // A provider that exits before reading the whole prompt makes stdin emit
    // EPIPE. That is the child's exit code to report, not a runner crash.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const settle = (status: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: out.join(''),
        stderr: err.join(''),
        timedOut,
        launchError: timedOut
          ? null
          : (launchError ??
            (overflowed
              ? new Error(`provider output exceeded ${MAX_BUFFER} bytes and was killed`)
              : null)),
      });
    };

    child.on('error', (error) => {
      launchError = error;
      settle(null, null);
    });
    // `close` rather than `exit`: it fires once the stdio streams are drained, so
    // the last chunk of a provider's output cannot be lost to the race.
    child.on('close', (status, signal) => settle(status, signal));
  });
}
