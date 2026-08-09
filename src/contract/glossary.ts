// Binding a termbase to a translation job: the per-row block and the salt that
// records which pack produced it, derived together from one entry list.

import {
  glossaryBlock,
  selectTerms,
  type TermEntry,
  type TermMatcher,
  termsDigest,
} from '../glossary.ts';
import type { FieldSpec, Fields, TranslationJob } from '../job.ts';

/** What a termbase needs to know to fill a translation job's two hooks. */
export interface GlossaryHookOptions {
  /** The pack, in the order its entries should appear in a block. */
  readonly entries: readonly TermEntry[];
  /**
   * Introduces the injected block.
   *
   * Required, and it carries more weight than it looks. The entries reach the
   * model stripped of whatever argued for them in the pack, so the heading is
   * the only place left to say what they are and how binding they are. A block
   * of bare bullets in the middle of a prompt is guidance the model is free to
   * read as background.
   */
  readonly heading: string;
  /** How a form is looked for in a row. Defaults to `substringMatcher`. */
  readonly matcher?: TermMatcher;
  /**
   * The job's field list, which selects the row text entries are matched
   * against: the translatable fields, concatenated.
   *
   * Every translatable field rather than one, because a term introduced in a
   * title governs the description under it and the two are translated in the
   * same call. Passthrough fields are excluded - an identifier column is not
   * prose, and a term found in one is not a term the model is about to render.
   *
   * Omit it and every value in the row is read instead, sorted by key so the
   * text does not depend on how the host happened to build the object.
   */
  readonly fields?: readonly FieldSpec[];
  /**
   * An existing salt to keep.
   *
   * Spreading the result of this function over a job replaces `promptSalt`
   * outright, so a host that already salts on something else would lose it
   * silently. Pass it here and the two are concatenated instead. When the pack
   * is empty the digest is `''` and what comes back is exactly the salt handed
   * in.
   */
  readonly salt?: string;
}

/**
 * The row text entries are matched against: the translatable field values,
 * joined.
 *
 * Sorting the fallback key list matters for the same reason `hashInput` sorts:
 * an input to something a run's identity depends on must not vary with the
 * order a caller's object literal happened to be written in.
 */
function rowText(source: Readonly<Fields>, fields?: readonly FieldSpec[]): string {
  const keys = fields
    ? fields.filter((field) => field.translate).map((field) => field.key)
    : Object.keys(source).sort();
  const values: string[] = [];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) values.push(value);
  }
  return values.join('\n');
}

/**
 * The `promptExtras` and `promptSalt` pair for a termbase.
 *
 * ```ts
 * const job: TranslationJob = {
 *   ...rest,
 *   fields: FIELDS,
 *   ...glossaryHook({ entries, heading: GUIDANCE, fields: FIELDS }),
 * };
 * ```
 *
 * Returning both is the point. They answer two halves of one question - what
 * this row was shown, and which pack it was shown from - and a host that fills
 * them separately can get them out of step: inject from the pack it loaded,
 * salt from a digest computed somewhere else. Nothing reports that, and what it
 * costs is a resume that reuses answers produced under rules that no longer
 * apply. Derived from one entry list, the mismatch has nowhere to come from.
 *
 * **An empty pack reproduces the job that never had one.** `promptExtras`
 * answers `''` for every row, which `buildPrompt` composes identically to a job
 * with no hook, and `promptSalt` is whatever `salt` was (`''` when it was
 * absent), which leaves `jobPromptHash` where it was.
 *
 * There is no review-side counterpart to this. A reviewer is shown the standard
 * whole rather than per row, so the review job's two pack-shaped fields are
 * `glossaryBlock(entries, heading)` and `termsDigest(entries)` assigned
 * directly - two lines with nothing to derive, which is not enough of a
 * mechanism to be worth an adapter. Feeding them the list this hook was given
 * is what keeps the standard a row was translated under and the standard it is
 * later judged against from drifting apart.
 */
export function glossaryHook(
  options: GlossaryHookOptions,
): Pick<TranslationJob, 'promptExtras' | 'promptSalt'> {
  const { entries, heading, matcher, fields, salt } = options;
  return {
    promptExtras: (source: Readonly<Fields>): string =>
      glossaryBlock(selectTerms(entries, rowText(source, fields), matcher), heading),
    promptSalt: `${salt ?? ''}${termsDigest(entries)}`,
  };
}
