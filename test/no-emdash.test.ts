// The em-dash rule is a lint script, but lint is easy to skip and easy to
// forget when the offending character arrives through a model-written patch.
// Importing the scanner here means `pnpm test` enforces it too.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanForEmDashes } from '../scripts/check-no-emdash.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('no em dashes', () => {
  it('finds none anywhere in the repo', () => {
    const hits = scanForEmDashes(ROOT);
    const rendered = hits.map((h) => `${h.file}:${h.line}:${h.column}  ${h.text}`);
    assert.deepEqual(rendered, [], `em dashes (U+2014) found:\n  ${rendered.join('\n  ')}`);
  });
});
