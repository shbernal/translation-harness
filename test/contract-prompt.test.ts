// Prompt assembly and the two hashes. The golden files here are the local half
// of the extraction's acceptance gate: they were generated from this code and
// verified byte-for-byte against the implementation it was extracted from, so a
// diff on them is a diff on what every model in every run is asked.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPrompt,
  hashInput,
  jobPromptHash,
  promptExtrasFor,
  promptHash,
  SOURCE_ROW_MARKER,
} from '../src/contract/prompt.ts';
import type { Fields, TranslationJob } from '../src/job.ts';
import { GOLDEN_ROW, TEST_JOB } from './helpers/job.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

describe('buildPrompt', () => {
  test('matches the committed golden prompt byte for byte', () => {
    // Regenerate deliberately if the prompt is meant to change, and treat the
    // diff as the review. Nothing else in the suite would notice a stray space.
    const expected = readFileSync(join(GOLDEN, 'prompt.txt'), 'utf8');
    assert.equal(buildPrompt(TEST_JOB, GOLDEN_ROW.identifier, GOLDEN_ROW.source), expected);
  });

  test('lists the translatable fields and only their source values', () => {
    const prompt = buildPrompt(TEST_JOB, 'AC-1', {
      name: 'Policy',
      type: 'B',
      description: null,
    });
    assert.match(prompt, /DOMAIN GUIDANCE/);
    assert.match(prompt, /name: Name/);
    assert.match(prompt, /description: Description/);
    assert.doesNotMatch(prompt, /type: Type/, 'a passthrough field is not translated');
    assert.match(prompt, /"name":"Policy"/);
    assert.match(prompt, /"description":null/);
    assert.doesNotMatch(prompt, /"type":/, 'and its value is not sent either');
  });

  test('names the language pair the way the job states it', () => {
    const job: TranslationJob = { ...TEST_JOB, sourceLang: 'Deutsch', targetLang: 'Italiano' };
    assert.match(buildPrompt(job, 'X', {}), /Translate from Deutsch into Italiano\./);
  });

  test('the payload is the last thing after the marker, so a parser can find it', () => {
    const prompt = buildPrompt(TEST_JOB, 'AC-1', { name: 'Policy', description: 'D' });
    const payload = prompt.slice(prompt.lastIndexOf(SOURCE_ROW_MARKER) + SOURCE_ROW_MARKER.length);
    assert.deepEqual(JSON.parse(payload.trim()), {
      identifier: 'AC-1',
      fields: { name: 'Policy', description: 'D' },
    });
  });

  test('trailing whitespace in the template does not reach the prompt', () => {
    const job: TranslationJob = { ...TEST_JOB, promptTemplate: 'GUIDANCE\n\n\n   ' };
    assert.match(buildPrompt(job, 'X', {}), /^GUIDANCE\n\nTranslate from/);
  });
});

describe('per-row prompt extras', () => {
  const row: Fields = { name: 'Policy', type: 'B', description: null };

  test('no extras is byte-identical to a job that has no hook at all', () => {
    // This is what makes adding a glossary to a half-translated corpus safe: a
    // row that matches nothing keeps the prompt, and therefore the answer, it
    // would have had.
    const bare = buildPrompt(TEST_JOB, 'AC-1', row);
    assert.equal(buildPrompt(TEST_JOB, 'AC-1', row, ''), bare);

    const withHook: TranslationJob = { ...TEST_JOB, promptExtras: () => '' };
    assert.equal(buildPrompt(withHook, 'AC-1', row, promptExtrasFor(withHook, row)), bare);
  });

  test('extras sit between the guidance and the output contract', () => {
    const prompt = buildPrompt(TEST_JOB, 'AC-1', row, '- policy -> politique');
    assert.match(prompt, /DOMAIN GUIDANCE\n\n- policy -> politique\n\nTranslate from English/);
  });

  test('the hook sees the row, so extras can depend on what it says', () => {
    const job: TranslationJob = {
      ...TEST_JOB,
      promptExtras: (source) => (source.name === 'Policy' ? 'MATCHED' : ''),
    };
    assert.equal(promptExtrasFor(job, row), 'MATCHED');
    assert.equal(promptExtrasFor(job, { name: 'Other' }), '');
  });
});

describe('promptHash and jobPromptHash', () => {
  test('a job with no salt hashes exactly its template', () => {
    assert.equal(jobPromptHash(TEST_JOB), promptHash('DOMAIN GUIDANCE'));
    assert.equal(jobPromptHash({ ...TEST_JOB, promptSalt: '' }), promptHash('DOMAIN GUIDANCE'));
  });

  test('a salt changes the identity without changing the prompt', () => {
    // The point of the salt: an input that shaped the run without appearing in
    // this row's text still has to count, or a resume reuses answers produced
    // under different rules.
    const salted: TranslationJob = { ...TEST_JOB, promptSalt: 'termbase-v2' };
    assert.notEqual(jobPromptHash(salted), jobPromptHash(TEST_JOB));
    assert.equal(buildPrompt(salted, 'AC-1', {}), buildPrompt(TEST_JOB, 'AC-1', {}));
  });

  test('a changed template changes the hash', () => {
    assert.notEqual(
      jobPromptHash({ ...TEST_JOB, promptTemplate: 'OTHER' }),
      jobPromptHash(TEST_JOB),
    );
  });
});

describe('hashInput', () => {
  test('is stable against the order the host happened to read its fields in', () => {
    const a = hashInput('AC-1', { b: '2', a: '1', c: null });
    const b = hashInput('AC-1', { c: null, a: '1', b: '2' });
    assert.equal(a, b);
  });

  test('a field that is absent is a different row from one that is null', () => {
    // Worth knowing rather than assuming: the canonical form lists the keys it
    // was given, so dropping a column from the host's reader changes every hash
    // in the corpus even where the value was empty either way. That is the
    // correct behaviour (the row really is being read differently now) but it
    // means a schema change invalidates a half-finished run, by design.
    assert.notEqual(hashInput('AC-1', { a: '1' }), hashInput('AC-1', { a: '1', b: null }));
  });

  test('a changed value or a changed identifier changes the hash', () => {
    const base = hashInput('AC-1', { a: '1' });
    assert.notEqual(hashInput('AC-1', { a: '2' }), base);
    assert.notEqual(hashInput('AC-2', { a: '1' }), base);
    assert.notEqual(hashInput('AC-1', { a: '1', b: '' }), base, 'a new blank field is still new');
  });
});

describe('unicode survives the round trip', () => {
  // Every one of these is a character an encoding mistake mangles quietly:
  // the row still translates, and the damage shows up in the deliverable.
  const SAMPLES: Record<string, string> = {
    french: 'Il s’agit d’une exigence : voir « journal ».',
    german: 'Die Schlüssel müssen getrennt aufbewahrt werden, gemäß §1.',
    spanish: '¿Quién revisa el registro? ¡Debe hacerse año tras año!',
    italian: 'L’accesso all’area è già tracciato: perciò va verificato.',
  };

  test('reaches the payload unchanged, character for character', () => {
    const job: TranslationJob = {
      ...TEST_JOB,
      fields: Object.keys(SAMPLES).map((key) => ({
        key,
        label: key,
        translate: true,
        required: false,
      })),
    };
    const prompt = buildPrompt(job, 'U-1', SAMPLES);
    const payload = JSON.parse(
      prompt.slice(prompt.lastIndexOf(SOURCE_ROW_MARKER) + SOURCE_ROW_MARKER.length).trim(),
    ) as { fields: Record<string, string> };
    assert.deepEqual(payload.fields, SAMPLES);
  });

  test('the French non-breaking space is preserved rather than collapsed', () => {
    const nbsp = ' ';
    const prompt = buildPrompt(TEST_JOB, 'U-2', { name: `exigence${nbsp}: voir` });
    assert.ok(prompt.includes(`exigence${nbsp}: voir`), 'U+00A0 must not become U+0020');
  });

  test('the hash distinguishes characters that look alike', () => {
    // A straight apostrophe and a typographic one are different bytes and must
    // be a different row, or a corpus normalized in one place silently reuses
    // answers produced from the other.
    assert.notEqual(hashInput('X', { a: "l'acces" }), hashInput('X', { a: 'l’acces' }));
    assert.notEqual(hashInput('X', { a: 'a b' }), hashInput('X', { a: 'a b' }));
  });
});
