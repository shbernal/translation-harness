// What a translation job is, as far as this library is concerned.
//
// The engine is written once against these types and a job is data: a language
// pair, a set of fields, a prompt, a few validators. Nothing here says where
// the rows come from. The version this was extracted from carried a workbook
// path, a sheet name and a 1-based column index per field, and that single
// assumption was what made the engine unpublishable. The host reads its own
// rows and hands them over as `SourceRecord`s.

/** A translatable or passthrough value carried through the pipeline. */
export type FieldValue = string | null;

/** A row's values, by field key. */
export type Fields = Record<string, FieldValue>;

/** One field of a source record, mapped to a stable key. */
export interface FieldSpec {
  /** Stable identifier used in the prompt payload, the schema, and the store. */
  readonly key: string;
  /** Human-facing label. The model sees this, so it is part of the prompt. */
  readonly label: string;
  /** Whether the model translates this field. `false` means carried through. */
  readonly translate: boolean;
  /** Whether the source value must be non-empty. Enforced by the host at read time. */
  readonly required: boolean;
}

/** Context handed to each validator. */
export interface ValidationContext {
  readonly identifier: string;
  /** All source fields (translatable and passthrough), by key. */
  readonly source: Readonly<Fields>;
  /** Model output for translatable fields, by key. */
  readonly translated: Readonly<Fields>;
}

/**
 * A non-fatal quality check. Returns human-readable review reasons; an empty
 * array means the row passed. Validators never throw for content problems -
 * they downgrade a row to review, they do not fail it. That distinction is what
 * keeps a run from burning retries on rows whose only problem is that they need
 * a human to look.
 */
export type Validator = (ctx: ValidationContext) => string[];

/** Bounds for the generic length-ratio check. */
export interface GuardrailThresholds {
  /** Below this, the translation is suspiciously short. */
  readonly minLengthRatio: number;
  /** Above this, suspiciously long. */
  readonly maxLengthRatio: number;
}

/**
 * The shipped defaults, and an honest account of where they come from.
 *
 * These were calibrated on one language pair over one private corpus of
 * long-form technical prose. They are a reasonable starting point for material
 * of that shape and they are wrong for other shapes: a corpus of two-word
 * interface strings will trip the lower bound on almost every row, because a
 * three-character difference is a large ratio when the string is six characters
 * long. Override them per job rather than living with the noise.
 */
export const DEFAULT_THRESHOLDS: GuardrailThresholds = {
  minLengthRatio: 0.45,
  maxLengthRatio: 2.25,
};

/** Everything the engine needs to run one translation pass. */
export interface TranslationJob {
  readonly id: string;

  /**
   * The language the source is in, as the model should be told it.
   *
   * A free string on purpose. A host with language-specific tables (term
   * folding, determiners, orthotypography) is right to close this to a union in
   * its own code, because a typo there silently selects the wrong table. The
   * library has no such tables, so it has nothing to be wrong about, and
   * closing the union here would only stop somebody translating a language
   * nobody thought to add. Do not "fix" this by narrowing it.
   */
  readonly sourceLang: string;
  readonly targetLang: string;

  /** Every field, translatable and passthrough, in the order the model sees them. */
  readonly fields: readonly FieldSpec[];

  /**
   * The domain guidance, as text. Not a path: resolving one is the host's
   * business, and a library that reads files from a directory it was handed has
   * quietly taken ownership of the host's layout.
   */
  readonly promptTemplate: string;

  /**
   * Optional escape hatch for rows whose translation is knowable without the
   * model - a tombstone, a fixed placeholder, any value the source repeats
   * verbatim. Return the translatable fields to commit, or `null` to send the
   * row to the provider as usual. The engine puts the returned fields through
   * the same guardrails a model answer faces, so a precomputed row is held to
   * the identical contract; it just costs no subprocess. Keep the predicate
   * exact (match the whole source value, not a prefix) so a row that merely
   * resembles the pattern still reaches the model.
   */
  readonly precomputed?: (source: Readonly<Fields>) => Fields | null;

  /** Extra guardrails beyond the structural and generic checks. */
  readonly validators: readonly Validator[];

  /**
   * Applied to every accepted translation before it is checked or stored.
   *
   * The intended use is orthotypography: a target language whose conventions
   * differ from what a model emits by default. It runs at the one line where an
   * accepted value is written, so what is checked is what is stored and the
   * guardrails, the store and the host's output cannot disagree.
   */
  readonly normalize?: (value: string) => string;

  /**
   * Per-row text inserted into the prompt between the template and the output
   * contract. A glossary, a set of prior decisions, anything that depends on
   * what this particular row says.
   *
   * Returning `''` produces byte-identical output to a job with no hook at all,
   * which is what makes adding one to an existing corpus safe.
   */
  readonly promptExtras?: (source: Readonly<Fields>) => string;

  /**
   * Folded into the prompt hash without appearing in the prompt.
   *
   * A row's prompt identity has to cover everything that shaped it, including
   * inputs that only sometimes produce text. A glossary pack that matched
   * nothing on this row still changes what the run means, and a resume that
   * cannot see the difference will reuse an answer produced under different
   * rules. An empty salt leaves the hash exactly where it was.
   */
  readonly promptSalt?: string;

  /** Overrides for the generic length-ratio check. See {@link DEFAULT_THRESHOLDS}. */
  readonly thresholds?: Partial<GuardrailThresholds>;
}

/**
 * One row of the host's corpus, ready to translate.
 *
 * The host produces these however it likes. The library only requires that
 * `rowNumber` is stable across re-reads of the same corpus, because it is the
 * primary key everything else hangs off.
 */
export interface SourceRecord {
  /** Stable primary key. What it means is the host's business. */
  readonly rowNumber: number;
  readonly identifier: string;
  readonly source: Readonly<Fields>;
  /** Pre-existing translations, where the corpus already carries them. */
  readonly target?: Readonly<Fields>;
  /** True when the row arrives already translated and should seed as succeeded. */
  readonly seedSucceeded: boolean;
  /** From this library's `hashInput()`. Detects source drift on re-read. */
  readonly inputHash: string;
}

/** The fields the model is asked to translate. */
export function translatableFields(job: TranslationJob): FieldSpec[] {
  return job.fields.filter((f) => f.translate);
}

/** A job's effective guardrail thresholds. */
export function thresholdsFor(job: TranslationJob): GuardrailThresholds {
  return { ...DEFAULT_THRESHOLDS, ...job.thresholds };
}
