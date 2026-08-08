// What a review job is: a translation job, seen from the other side.
//
// A review pass judges an existing rendering rather than producing one, so it
// needs everything the translation job already says (the language pair, the
// fields, the target-language normalizer) plus its own guidance and its own
// vocabularies. It carries the `TranslationJob` rather than restating it,
// because a review whose idea of the fields differs from the pass that produced
// them is reviewing a corpus that does not exist.

import type { Fields, TranslationJob } from '../job.ts';
import { translatableFields } from '../job.ts';

/**
 * The severity scale, and why it is a closed list.
 *
 * A run over 2,125 German rows left `severity` unconstrained and the model
 * answered with four words for three levels - `minor` 413, `major` 25, `medium`
 * 7, `moderate` 2 - so anything sorting or filtering by severity saw one level
 * split across two names, silently, in the direction that hides defects. The
 * middle rung is the one that collided, and each scale keeps the word that
 * belongs to it: **`moderate` grades a defect, `medium` grades a belief.**
 *
 * The lists are overridable per job. What is not optional is that they are
 * lists: a graded field the model may fill freely is a graded field with no
 * grades in it.
 */
export const DEFAULT_SEVERITY_LEVELS = ['minor', 'moderate', 'major'] as const;

/** The confidence scale. See {@link DEFAULT_SEVERITY_LEVELS} for why it is closed. */
export const DEFAULT_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

/** Everything the library needs to compose and check one reviewer call. */
export interface ReviewJob {
  readonly id: string;

  /**
   * The pass whose output is under review. Supplies the language pair, the
   * fields and `normalize`; `precomputed` is what a caller can settle a row by
   * without a model call.
   */
  readonly translation: TranslationJob;

  /**
   * Which fields the reviewer judges. Defaults to the job's translatable
   * fields, which is the whole of what a pass produced.
   *
   * Narrower than translatable is a real case and not an oversight: a corpus
   * whose long prose field is worth a reviewer's attention and whose short
   * label field is not costs less to review and produces fewer proposals nobody
   * asked for.
   */
  readonly reviewFields?: readonly string[];

  /** The reviewer's standing guidance, as text. A path is the host's business. */
  readonly promptTemplate: string;

  /**
   * Whether the reviewer sees the source.
   *
   * `false` is a monolingual pass: the snapshot carries only the current target
   * value and the framing asks for a coherence judgement rather than a fidelity
   * one. The two are different jobs rather than a flag on one job, because they
   * need different guidance to be worth running - and because a review run's id
   * is derived from its inputs, so the distinction has to be visible to
   * whatever hashes them.
   */
  readonly showSource: boolean;

  /**
   * Standing reference material - a termbase, a house style sheet - rendered as
   * the prompt's `TERMINOLOGY` block. Empty or absent emits no block at all, so
   * a job that has none produces the prompt it would have produced without the
   * field.
   *
   * Text, not a structure. What a term entry looks like is a judgement about
   * one language pair and one domain, and a library that parsed one would be
   * making that judgement for every host.
   */
  readonly terminology?: string;

  /** Overrides the severity scale. See {@link DEFAULT_SEVERITY_LEVELS}. */
  readonly severityLevels?: readonly string[];
  /** Overrides the confidence scale. See {@link DEFAULT_SEVERITY_LEVELS}. */
  readonly confidenceLevels?: readonly string[];
}

/** The field keys the reviewer judges, in the order the model sees them. */
export function reviewedFields(job: ReviewJob): string[] {
  if (job.reviewFields) return [...job.reviewFields];
  return translatableFields(job.translation).map((f) => f.key);
}

/** A job's effective severity scale. */
export function severityLevelsFor(job: ReviewJob): readonly string[] {
  return job.severityLevels ?? DEFAULT_SEVERITY_LEVELS;
}

/** A job's effective confidence scale. */
export function confidenceLevelsFor(job: ReviewJob): readonly string[] {
  return job.confidenceLevels ?? DEFAULT_CONFIDENCE_LEVELS;
}

/** A job's target-language normalizer, or the identity when it has none. */
export function normalizerFor(job: ReviewJob): (value: string) => string {
  return job.translation.normalize ?? ((value: string) => value);
}

/** One row as the reviewer is shown it: what it said, and what it says now. */
export interface ReviewRow {
  readonly identifier: string;
  /** The source values. Withheld from the prompt when `showSource` is false. */
  readonly source: Readonly<Fields>;
  /** The value under review: the accepted corpus target, or a chained run's output. */
  readonly target: Readonly<Fields>;
}
