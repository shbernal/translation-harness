// The JSON output schema, generated from the job's field specs.
//
// Generated rather than written so it cannot drift from the prompt: both come
// from the same list, so a field added to the job is a field the model is asked
// for and a field the schema requires, in one edit.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TranslationJob, translatableFields } from '../job.ts';

export interface ResponseSchema {
  json: unknown;
  text: string;
  hash: string;
}

/** Build the uniform JSON output schema for a job's translatable fields. */
export function buildResponseSchema(job: TranslationJob): ResponseSchema {
  const fields = translatableFields(job);
  const translationProps: Record<string, unknown> = {};
  for (const field of fields) {
    // A field with a blank source must translate to null, so every field is nullable.
    translationProps[field.key] = { type: ['string', 'null'] };
  }
  const json = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      identifier: { type: 'string' },
      translations: {
        type: 'object',
        additionalProperties: false,
        properties: translationProps,
        required: fields.map((f) => f.key),
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['identifier', 'translations', 'warnings'],
  };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  return { json, text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/**
 * Persist the generated schema and return its path.
 *
 * On disk rather than in memory because that is what the agent CLIs take: Codex
 * wants `--output-schema <path>` and the Claude invoker reads the file to embed
 * it in the system prompt. `dir` is wherever the caller keeps a run's working
 * files; the library has no opinion beyond creating it.
 */
export function writeResponseSchema(job: TranslationJob, dir: string): string {
  const path = join(dir, 'translation-response.schema.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildResponseSchema(job).text, 'utf8');
  return path;
}
