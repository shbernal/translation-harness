// A stand-in agent CLI, installed on PATH under the name the invokers look for.
//
// The point is to exercise `launcher()` for real rather than around it: on
// Windows the invoker spawns `%COMSPEC% /d /c <name>.cmd` and the interpreter
// resolves the shim from PATH, and on POSIX `spawn` resolves the executable
// itself. Both paths are the thing most worth testing and both are skipped
// entirely if the test calls the invoker with an absolute path instead.
//
// Nothing here launches a model. The fake CLI is `node` running a script the
// test wrote.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';

const IS_WIN = process.platform === 'win32';

export interface FakeCli {
  /** Directory holding the shim; already prepended to PATH. */
  readonly dir: string;
  /** Undo the PATH change and delete the directory. */
  restore(): void;
}

/**
 * Install `name` on PATH as a shim that runs `script` under this Node.
 *
 * The script is an ordinary Node program: it may read stdin, write stdout and
 * stderr, and set an exit code. It receives the CLI's argv after the shim's
 * own, so a test can assert what the invoker passed.
 */
export function installFakeCli(name: string, script: string): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), `harness-fake-${name}-`));
  const implPath = join(dir, `${name}-impl.mjs`);
  writeFileSync(implPath, script, 'utf8');

  if (IS_WIN) {
    // `%*` forwards the CLI's arguments; `@echo off` keeps the shim's own
    // echoing out of the stdout the invoker is about to parse as JSON.
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${implPath}" %*\r\n`,
      'utf8',
    );
  } else {
    const shim = join(dir, name);
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`, 'utf8');
    chmodSync(shim, 0o755);
  }

  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${delimiter}${previous}`;

  return {
    dir,
    restore(): void {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A scratch directory for response and schema files, and its cleanup. */
export function scratchDir(label: string): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), `harness-${label}-`));
  return {
    dir,
    remove(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
