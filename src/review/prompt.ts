// The reviewer prompt: standing guidance, the direction, the reference blocks,
// the output contract, and the row.
//
// The frame is fixed and the material is the job's, which is the same division
// `buildPrompt` makes for translation. What differs is that a reviewer is shown
// two values per field rather than one, and that a block may be absent: a job
// with no terminology and a row with no consistency evidence produce a prompt
// byte-identical to one composed by a caller that has neither.

import type { Fields } from '../job.ts';
import { type ReviewJob, reviewedFields } from './job.ts';

/** Marker that precedes the row-snapshot JSON payload in every reviewer prompt. */
export const ROW_SNAPSHOT_MARKER = 'ROW SNAPSHOT:';

/**
 * Other renderings this row's source values have elsewhere in the corpus, by
 * field. Produced by the consistency analysis; `{}` when a row has none, which
 * is most rows in most corpora.
 */
export type RowEvidence = Readonly<Record<string, readonly string[]>>;

/**
 * Compose the full per-row reviewer prompt.
 *
 * The row snapshot is last and follows {@link ROW_SNAPSHOT_MARKER}, so a parser
 * (the offline provider, a capture harness) can find the payload without
 * knowing anything about the guidance above it.
 *
 * In a monolingual pass the source is withheld: the snapshot carries only the
 * current target value. Consistency evidence is still keyed by source
 * internally, but only the target renderings reach the model, so it stays
 * useful without leaking the thing the pass is meant to hide.
 */
export function buildReviewPrompt(
  job: ReviewJob,
  identifier: string,
  source: Readonly<Fields>,
  target: Readonly<Fields>,
  evidence: RowEvidence = {},
): string {
  const fields = reviewedFields(job);
  const { sourceLang, targetLang } = job.translation;
  const snapshot = Object.fromEntries(
    fields.map((f) =>
      job.showSource
        ? [f, { source: source[f] ?? null, current: target[f] ?? null }]
        : [f, { current: target[f] ?? null }],
    ),
  );

  // Ordered by the job's field list rather than by whatever order the caller
  // built its evidence object in, so the prompt bytes do not depend on that.
  const rowEvidence: Record<string, readonly string[]> = {};
  for (const f of fields) {
    const renderings = evidence[f];
    if (renderings?.length) rowEvidence[f] = renderings;
  }

  const parts = [
    job.promptTemplate.trimEnd(),
    job.showSource
      ? `\nReview these fields translated from ${sourceLang} into ${targetLang}: ${fields.join(', ')}.`
      : `\nReview the coherence and correctness of these ${targetLang} fields on their own terms: ${fields.join(', ')}.`,
  ];
  const terminology = job.terminology ?? '';
  if (terminology.trim()) parts.push(`\nTERMINOLOGY:\n${terminology.trim()}`);
  if (Object.keys(rowEvidence).length) {
    parts.push(
      `\nCONSISTENCY EVIDENCE (other target renderings of the same source in this corpus):\n${JSON.stringify(rowEvidence)}`,
    );
  }
  parts.push(
    `\nReply with EXACTLY ONE JSON object matching the review output schema and nothing else.\n\n${ROW_SNAPSHOT_MARKER}\n${JSON.stringify({ identifier, fields: snapshot })}`,
  );
  return parts.join('\n');
}
