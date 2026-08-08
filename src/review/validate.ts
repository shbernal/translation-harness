// The reviewer's quality gate.
//
// Every failure here is structural and raises `TransientFailure`, which costs
// the row another attempt. That is the whole difference from the translation
// gate: `validateResponse` has a second category, because a translation can be
// well-formed and still worth a human's attention. A review *is* that attention,
// so there is nothing to downgrade a review to. Either the reviewer answered the
// contract or it did not.

import { TransientFailure } from '../errors.ts';
import type { Fields } from '../job.ts';
import {
  confidenceLevelsFor,
  normalizerFor,
  type ReviewJob,
  reviewedFields,
  severityLevelsFor,
} from './job.ts';

/** A reviewer answer, checked and normalized. */
export interface ReviewedResponse {
  verdict: 'pass' | 'change_proposed';
  severity: string | null;
  confidence: string | null;
  /** Per field: the proposed replacement, or `null` to keep the current value. */
  proposals: Fields;
  issues: string[];
}

/** A graded field is `null` or one of its levels; anything else is a bad row. */
function gradedLevel(name: string, levels: readonly string[], value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && levels.includes(value)) return value;
  throw new TransientFailure(
    'invalid_shape',
    `${name} must be null or one of ${levels.join('|')}, got ${JSON.stringify(value)}`,
  );
}

/**
 * Check and normalize one reviewer answer.
 *
 * The normalizer is the job's, and it runs here for the same reason
 * `validateResponse` runs it where it does: **a proposal is an accepted target
 * value the moment a human takes it**, so it has to be normalized at the one
 * line where it is accepted rather than at whatever renders it later. Doing it
 * in `validateResponse` alone is not enough - a clean corpus reviewed by a model
 * that writes a straight apostrophe comes back inconsistent, which is exactly
 * the corpus-wide defect the hook exists to prevent. The per-attempt response
 * file still holds the raw reviewer output, so the audit trail is unaffected.
 *
 * A proposal is normalized even on a `pass` verdict, on the grounds that a
 * verdict and a proposal are separate claims and the store keeps both.
 */
export function validateReview(
  job: ReviewJob,
  identifier: string,
  value: unknown,
): ReviewedResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TransientFailure('invalid_shape', 'Review response is not a JSON object');
  const v = value as Record<string, unknown>;

  if (v.identifier !== identifier) {
    throw new TransientFailure(
      'identifier_mismatch',
      `Returned identifier ${JSON.stringify(v.identifier)} differs`,
    );
  }
  if (v.verdict !== 'pass' && v.verdict !== 'change_proposed')
    throw new TransientFailure('invalid_shape', 'verdict must be pass|change_proposed');
  if (!Array.isArray(v.issues) || !v.issues.every((i) => typeof i === 'string'))
    throw new TransientFailure('invalid_shape', 'issues must be an array of strings');
  if (typeof v.proposals !== 'object' || v.proposals === null || Array.isArray(v.proposals))
    throw new TransientFailure('invalid_shape', 'proposals must be an object');

  const normalize = normalizerFor(job);
  const proposals: Fields = {};
  for (const field of reviewedFields(job)) {
    const proposed = (v.proposals as Record<string, unknown>)[field];
    if (proposed !== null && proposed !== undefined && typeof proposed !== 'string')
      throw new TransientFailure('invalid_shape', `proposal '${field}' must be string|null`);
    proposals[field] = typeof proposed === 'string' ? normalize(proposed) : null;
  }

  return {
    verdict: v.verdict,
    severity: gradedLevel('severity', severityLevelsFor(job), v.severity),
    confidence: gradedLevel('confidence', confidenceLevelsFor(job), v.confidence),
    proposals,
    issues: v.issues as string[],
  };
}
