// The quality gate. Structural problems (wrong shape, identifier mismatch, blank
// contract) raise TransientFailure and cost the row another attempt; content
// concerns (bracket drift, suspicious length, identical output, plus the job's
// own validators) become non-fatal review reasons that downgrade a row rather
// than failing it.

import { TransientFailure } from '../errors.ts';
import {
  type Fields,
  type FieldValue,
  type GuardrailThresholds,
  type TranslationJob,
  thresholdsFor,
  translatableFields,
  type ValidationContext,
} from '../job.ts';

export interface ValidatedResponse {
  translations: Fields;
  warnings: string[];
  reviewReasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Generic, job-independent content checks over the concatenated fields.
 *
 * Three of them are cheap heuristics that catch the failure modes a model
 * produces when it is not quite doing the task: dropping a bracketed reference,
 * answering with a summary instead of a translation, or echoing the source back.
 * None of them is evidence of a defect on its own, which is why they produce
 * review reasons rather than failures.
 *
 * The fourth, `no translatable content`, is not about the model at all. The row
 * had nothing to ask about, so nothing it got back can be suspicious; the reason
 * exists because a row that is entirely empty is worth a human glance, and it
 * takes the place of the ratio rather than sitting alongside it.
 */
export function genericReviewReasons(
  source: string,
  translated: string,
  thresholds: GuardrailThresholds,
): string[] {
  const reasons: string[] = [];
  const open = (s: string) => (s.match(/\[/g) ?? []).length;
  const close = (s: string) => (s.match(/\]/g) ?? []).length;
  if (open(source) !== open(translated) || close(source) !== close(translated)) {
    reasons.push('square-bracket count differs from source');
  }
  // Blankness is asked first and on its own, because it is a different question
  // from the ratio and it used to be answered by accident. A row with nothing to
  // translate has no ratio worth taking: the check below then reports whichever
  // side of the bounds the arithmetic happened to land on, and where the fields
  // are joined that arithmetic is decided by the separators. One translatable
  // field concatenates to `''`, so `0 / max(0, 1)` is 0 and the row was flagged;
  // two or more concatenate to `'\n'` on both sides, so the ratio is exactly
  // 1.00 and the same row passed. Sending an all-blank row to review is
  // deliberate - a row with nothing to translate is worth a human glance - and
  // it is now true of every job rather than of single-field jobs only.
  if (!source.trim()) {
    reasons.push('no translatable content');
  } else {
    const ratio = translated.length / source.length;
    if (ratio < thresholds.minLengthRatio || ratio > thresholds.maxLengthRatio) {
      reasons.push(`suspicious combined length ratio: ${ratio.toFixed(2)}`);
    }
  }
  if (translated.trim() === source.trim() && source.trim().length > 0) {
    reasons.push('translation is identical to source');
  }
  return reasons;
}

export function validateResponse(
  job: TranslationJob,
  source: Readonly<Fields>,
  identifier: string,
  value: unknown,
): ValidatedResponse {
  if (!isRecord(value))
    throw new TransientFailure('invalid_shape', 'Response is not a JSON object');
  const keys = new Set(Object.keys(value));
  for (const required of ['identifier', 'translations', 'warnings']) {
    if (!keys.has(required))
      throw new TransientFailure('invalid_shape', `Response is missing '${required}'`);
  }
  if (value.identifier !== identifier) {
    throw new TransientFailure(
      'identifier_mismatch',
      `Returned identifier ${JSON.stringify(value.identifier)} differs`,
    );
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((w) => typeof w === 'string')) {
    throw new TransientFailure('invalid_shape', 'warnings must be an array of strings');
  }
  if (!isRecord(value.translations))
    throw new TransientFailure('invalid_shape', 'translations must be an object');

  const fields = translatableFields(job);
  const translations: Fields = {};
  // Normalization runs here, at the one line where an accepted value is written,
  // and before the content checks below - so what is checked is what is stored,
  // and the guardrails, the store and whatever the host renders cannot disagree.
  // A `precomputed` row routes through this same function, so it inherits the
  // rule with no second code path, while a row seeded as already-succeeded never
  // enters here and so a finished, human-validated corpus is untouched by
  // construction. The per-attempt response file still holds the raw model
  // output, so the audit trail survives.
  const normalize = job.normalize ?? ((v: string) => v);
  for (const field of fields) {
    const provided = (value.translations as Record<string, unknown>)[field.key];
    const sourceBlank = source[field.key] === null || source[field.key] === undefined;
    if (sourceBlank) {
      if (provided !== null && provided !== undefined) {
        throw new TransientFailure(
          'blank_contract',
          `Blank source '${field.key}' must translate to null`,
        );
      }
      translations[field.key] = null;
    } else {
      if (typeof provided !== 'string' || !provided.trim()) {
        throw new TransientFailure(
          'invalid_shape',
          `Field '${field.key}' needs a non-empty translation`,
        );
      }
      translations[field.key] = normalize(provided);
    }
  }

  const warnings = value.warnings as string[];
  const reviewReasons = warnings.map((w) => `model warning: ${w}`);

  const sourceConcat = fields.map((f) => source[f.key] ?? '').join('\n');
  const translatedConcat = fields.map((f) => translations[f.key] ?? '').join('\n');
  reviewReasons.push(...genericReviewReasons(sourceConcat, translatedConcat, thresholdsFor(job)));

  const ctx: ValidationContext = { identifier, source, translated: translations };
  for (const validator of job.validators) reviewReasons.push(...validator(ctx));

  return { translations, warnings, reviewReasons };
}

/**
 * One normative level: what marks it in the source language and what marks it in
 * the target. The counting loop is shared mechanism; a table of these is a
 * linguistic judgement about one language pair and belongs with the job that
 * makes it, next to that job's prompt.
 */
export interface ModalLevel {
  readonly level: string;
  readonly source: RegExp;
  readonly target: RegExp;
}

/**
 * The same pattern, guaranteed to count every match rather than the first.
 *
 * `String.match` on a regex without `g` returns a match object, whose `length`
 * is one plus the number of capture groups - so a level table spelled `/shall/i`
 * counted 1 wherever the word occurred at all, and a pattern with two groups
 * counted 3 for a single hit. Silent both ways, which is what makes it worth
 * normalizing rather than checking.
 *
 * Normalized rather than refused. A validator throws inside `validateResponse`,
 * and a throw there that is not a `TransientFailure` is fatal to the whole run:
 * far too much to charge for a missing flag. `missingReferences` gets to be
 * strict about the same mistake only because `matchAll` refuses a non-global
 * pattern on its own behalf.
 */
const asGlobal = (re: RegExp): RegExp => (re.global ? re : new RegExp(re.source, `${re.flags}g`));

/**
 * Helper for a job's validators: normative modal force that did not survive.
 *
 * A requirement is binding because of its modal, and nothing else in the
 * pipeline looks at one. Idiom in the target language can pull an impersonal
 * construction (`it MUST be considered`, `care SHOULD be taken to`) toward a
 * phrasing that carries no modal verb at all, which is good prose: so a MUST
 * becomes advisory while the row stays structurally valid, passes every other
 * check, and exports clean. Counting per level rather than in total also catches
 * a MUST rendered at the SHOULD level, which an equal total would hide.
 *
 * Counts, not alignment: a translation legitimately splits and merges sentences,
 * so a difference is a review lead and not proof of a defect. Both directions
 * are reported, because a surplus in the target can mean a lowercase source
 * modal was promoted into a scannable requirement. Only fields the job actually
 * translates are compared, so a passthrough field cannot contribute a phantom
 * source modal.
 *
 * The level table is a parameter, the way `missingReferences` takes its pattern:
 * the four design points above are the mechanism and are shared, while which
 * words mark which level is a judgement about one language pair.
 *
 * A level's regexes are counted globally whether or not they carry `g`, so a
 * table spelled `/shall/i` reports real counts rather than 1.
 */
export function modalForceShiftsFor(
  levels: readonly ModalLevel[],
  ctx: ValidationContext,
): string[] {
  const keys = Object.keys(ctx.translated);
  const text = (values: Readonly<Fields>) => keys.map((k) => values[k] ?? '').join('\n');
  const source = text(ctx.source);
  const translated = text(ctx.translated);
  const count = (s: string, re: RegExp) => s.match(asGlobal(re))?.length ?? 0;

  const shifts = levels
    .map(({ level, source: from, target: to }) => {
      const want = count(source, from);
      const got = count(translated, to);
      return want === got ? null : `${level} ${want} -> ${got}`;
    })
    .filter((s): s is string => s !== null);

  return shifts.length ? [`modal force differs: ${shifts.join(', ')}`] : [];
}

/** Helper for a job's validators: reference tokens present in source but dropped. */
export function missingReferences(pattern: RegExp, ctx: ValidationContext): string[] {
  const collect = (values: Readonly<Fields>): Set<string> => {
    const found = new Set<string>();
    for (const v of Object.values(values) as FieldValue[]) {
      if (!v) continue;
      for (const m of v.matchAll(pattern)) found.add(m[0]);
    }
    return found;
  };
  const inSource = collect(ctx.source);
  const inTranslated = collect(ctx.translated);
  const missing = [...inSource].filter((ref) => !inTranslated.has(ref)).sort();
  return missing.length ? [`missing references: ${missing.join(', ')}`] : [];
}
