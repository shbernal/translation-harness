// Replaying real agent CLI output, so the parsers can be tested against bytes a
// model actually produced.
//
// The interesting half of a provider is not the spawn, it is what it does with
// what comes back: a Claude envelope with its `modelUsage` map and its
// `result` string, a Codex run whose answer arrives as a file rather than on
// stdout, a refusal whose wording decides which failure category a row gets.
// A hand-written string standing in for any of those tests our imagination.
//
// So the fixtures hold captured `stdout`, `stderr`, exit code and response
// file, and this installs a fake CLI that reproduces them byte for byte. The
// invoker under test is the real one, resolved off PATH through `launcher()`
// exactly as it resolves the real CLI. Nothing calls a model.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FakeCli, installFakeCli } from './fake-cli.ts';

const RECORDED = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'recorded');

export interface RecordedMeta {
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly captured: string;
  /** What was sent, so it is obvious no private material is in here. */
  readonly payload: string;
  readonly outcome: string;
  readonly exitCode?: number;
  readonly note?: string;
}

export interface RecordedCase {
  readonly dir: string;
  readonly meta: RecordedMeta;
  /** Files present, so a test can say what a case does and does not carry. */
  readonly files: readonly string[];
}

export function recordedCases(): RecordedCase[] {
  return readdirSync(RECORDED, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(RECORDED, e.name);
      return {
        dir,
        meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RecordedMeta,
        files: readdirSync(dir).sort(),
      };
    });
}

export function recordedCase(label: string): RecordedCase {
  const found = recordedCases().find((c) => c.meta.label === label);
  if (!found) throw new Error(`no recorded case '${label}'`);
  return found;
}

export function recordedFile(c: RecordedCase, name: string): string {
  return readFileSync(join(c.dir, name), 'utf8');
}

/**
 * Install the case's provider on PATH, replaying what it recorded.
 *
 * Codex writes its answer to the path it was handed in
 * `--output-last-message`, so the replay has to read its own argv and do the
 * same. Claude puts everything on stdout, so for that provider the copy never
 * happens - which is itself part of what makes the two invokers different and
 * worth testing separately.
 */
export function replayRecorded(c: RecordedCase): FakeCli {
  const has = (name: string): boolean => c.files.includes(name);
  const script = `
import { copyFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

const DIR = ${JSON.stringify(c.dir)};
const read = (name) => readFileSync(DIR + '/' + name, 'utf8');

process.stdout.write(${has('stdout.log') ? "read('stdout.log')" : "''"});
process.stderr.write(${has('stderr.log') ? "read('stderr.log')" : "''"});

${
  has('response.json')
    ? `const at = process.argv.indexOf('--output-last-message');
if (at !== -1 && process.argv[at + 1]) copyFileSync(DIR + '/response.json', process.argv[at + 1]);`
    : '// this case recorded no response file'
}

process.exit(${c.meta.exitCode ?? 0});
`;
  return installFakeCli(c.meta.provider, script);
}

/** Where the recorded fixtures live, for a test that wants to walk them. */
export function recordedRoot(): string {
  return RECORDED;
}

/** True when the fixtures directory exists at all. */
export function hasRecorded(): boolean {
  try {
    return statSync(RECORDED).isDirectory();
  } catch {
    return false;
  }
}
