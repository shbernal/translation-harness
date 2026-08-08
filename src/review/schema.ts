// The reviewer's JSON output schema, generated from the job.
//
// Generated for the same reason the translation schema is: the prompt and the
// schema come from one field list, so a field the reviewer is asked about is a
// field the schema requires, in one edit. The graded vocabularies reach the
// schema as enums, which is what makes them a contract the provider can enforce
// rather than a preference the validator complains about afterwards.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { confidenceLevelsFor, type ReviewJob, reviewedFields, severityLevelsFor } from './job.ts';

export interface ReviewResponseSchema {
  json: unknown;
  /** The bytes {@link writeReviewSchema} puts on disk: indented, newline-terminated. */
  text: string;
  /** The bytes {@link ReviewResponseSchema.hash} is taken over. See below. */
  compact: string;
  hash: string;
}

/**
 * Build the reviewer's output schema.
 *
 * `verdict` is closed to two values because it is the field everything
 * downstream branches on. `severity` and `confidence` admit `null` as well as
 * their levels: a reviewer that found nothing has no severity to report, and
 * forcing a level there would make `pass` rows carry a grade nobody assigned.
 * Every proposal is nullable for the mirror-image reason - `null` is how the
 * reviewer says "keep what is there", and it is the value that keeps a `pass`
 * row from re-emitting text it is not changing.
 *
 * **The hash is over `compact`, not over `text`.** The file the provider is
 * handed is indented for a human reading an attempt directory; the identity a
 * review run is derived from must not move because someone reformatted it. The
 * translate side hashes its indented text, so this is a real difference between
 * the two and it is deliberate: run ids already published were derived this way.
 */
export function buildReviewSchema(job: ReviewJob): ReviewResponseSchema {
  const fields = reviewedFields(job);
  const proposalProps = Object.fromEntries(fields.map((f) => [f, { type: ['string', 'null'] }]));
  const json = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      identifier: { type: 'string' },
      verdict: { enum: ['pass', 'change_proposed'] },
      severity: { enum: [...severityLevelsFor(job), null] },
      confidence: { enum: [...confidenceLevelsFor(job), null] },
      proposals: {
        type: 'object',
        additionalProperties: false,
        properties: proposalProps,
        required: fields,
      },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['identifier', 'verdict', 'severity', 'confidence', 'proposals', 'issues'],
  };
  const compact = JSON.stringify(json);
  return {
    json,
    text: `${JSON.stringify(json, null, 2)}\n`,
    compact,
    hash: createHash('sha256').update(compact, 'utf8').digest('hex'),
  };
}

/**
 * Persist the reviewer schema and return its path.
 *
 * On disk because that is what the agent CLIs take, exactly as
 * `writeResponseSchema` is. The file name differs from the translation one so
 * both can live in the same working directory without either overwriting the
 * other, which happens the moment a host reviews the corpus it just translated.
 */
export function writeReviewSchema(job: ReviewJob, dir: string): string {
  const path = join(dir, 'review-response.schema.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildReviewSchema(job).text, 'utf8');
  return path;
}
