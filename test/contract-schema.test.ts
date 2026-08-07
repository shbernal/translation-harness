// The generated output schema. Its whole reason for being generated is that it
// and the prompt come from one list, so they cannot drift.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../src/contract/prompt.ts';
import { buildResponseSchema, writeResponseSchema } from '../src/contract/schema.ts';
import type { TranslationJob } from '../src/job.ts';
import { scratchDir } from './helpers/fake-cli.ts';
import { TEST_JOB } from './helpers/job.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

type Schema = {
  additionalProperties: boolean;
  required: string[];
  properties: {
    translations: {
      additionalProperties: boolean;
      properties: Record<string, { type: string[] }>;
      required: string[];
    };
  };
};

describe('buildResponseSchema', () => {
  test('matches the committed golden schema byte for byte', () => {
    assert.equal(
      buildResponseSchema(TEST_JOB).text,
      readFileSync(join(GOLDEN, 'response.schema.json'), 'utf8'),
    );
  });

  test('requires exactly the translatable fields, in job order', () => {
    const schema = buildResponseSchema(TEST_JOB).json as Schema;
    assert.deepEqual(schema.properties.translations.required, ['name', 'description']);
    assert.deepEqual(Object.keys(schema.properties.translations.properties), [
      'name',
      'description',
    ]);
  });

  test('every field is nullable, because a blank source must translate to null', () => {
    const schema = buildResponseSchema(TEST_JOB).json as Schema;
    for (const [key, spec] of Object.entries(schema.properties.translations.properties)) {
      assert.deepEqual(spec.type, ['string', 'null'], `${key} must be nullable`);
    }
  });

  test('nothing extra is allowed at either level', () => {
    // Without this the model is free to add commentary keys, and a structured
    // output mode has no reason to stop it.
    const schema = buildResponseSchema(TEST_JOB).json as Schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.translations.additionalProperties, false);
    assert.deepEqual(schema.required, ['identifier', 'translations', 'warnings']);
  });

  test('the schema and the prompt cannot disagree about which fields exist', () => {
    // The one invariant that justifies generating it at all.
    const job: TranslationJob = {
      ...TEST_JOB,
      fields: [
        ...TEST_JOB.fields,
        { key: 'guidance', label: 'Guidance', translate: true, required: false },
      ],
    };
    const schema = buildResponseSchema(job).json as Schema;
    const prompt = buildPrompt(job, 'X', {});
    for (const key of schema.properties.translations.required) {
      assert.ok(prompt.includes(`- ${key}: `), `${key} is required but never asked for`);
    }
  });

  test('the hash tracks the text', () => {
    const a = buildResponseSchema(TEST_JOB);
    const b = buildResponseSchema({ ...TEST_JOB, id: 'renamed' });
    assert.equal(a.hash, b.hash, 'the job id is not part of the contract');

    const changed = buildResponseSchema({
      ...TEST_JOB,
      fields: [{ key: 'only', label: 'Only', translate: true, required: true }],
    });
    assert.notEqual(changed.hash, a.hash);
  });
});

describe('writeResponseSchema', () => {
  test('writes the schema text and returns the path the invokers need', () => {
    const scratch = scratchDir('schema');
    try {
      const path = writeResponseSchema(TEST_JOB, scratch.dir);
      assert.equal(readFileSync(path, 'utf8'), buildResponseSchema(TEST_JOB).text);
    } finally {
      scratch.remove();
    }
  });

  test('creates the directory rather than requiring the caller to', () => {
    const scratch = scratchDir('schema-nested');
    try {
      const nested = join(scratch.dir, 'runs', 'r1', 'work');
      const path = writeResponseSchema(TEST_JOB, nested);
      assert.ok(readFileSync(path, 'utf8').startsWith('{'));
    } finally {
      scratch.remove();
    }
  });
});
