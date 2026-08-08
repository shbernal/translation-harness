// The consistency analysis: where one source string is rendered more than one
// way, and which rows are affected.
//
// This is the only reference material in a review run that the library derives
// rather than receives. It has to be here rather than in the host, because its
// output hash is one of the run id's inputs: a corpus analysis a host computed
// its own way would make two hosts disagree about what run they are looking at,
// which is the one thing a derived run id exists to prevent.
//
// It is deterministic and language agnostic. It knows nothing about words,
// morphology or segmentation - only that the same source string came back as
// two different target strings somewhere in the same corpus, which is a fact
// about the corpus and not a judgement about either rendering.

import { createHash } from 'node:crypto';
import type { Fields } from '../job.ts';
import { type ReviewJob, reviewedFields } from './job.ts';
import type { RowEvidence } from './prompt.ts';

/** One source string the corpus renders more than one way, in one field. */
export interface ConsistencyEntry {
  /** The source value that is rendered inconsistently. */
  readonly source: string;
  /** Every distinct target rendering of it, sorted. */
  readonly renderings: readonly string[];
  /** How many distinct renderings there are. Not how many rows use them. */
  readonly count: number;
}

/**
 * The whole analysis, plus the exact bytes a run's identity is derived from.
 *
 * `text` is what gets written to the run directory and `hash` is over `text`,
 * including its trailing newline. A file a human can `cat` and a hash a run id
 * is built from should not be two different serializations of one thing.
 */
export interface ConsistencyAnalysis {
  /** The fields analysed, in job order. */
  readonly fields: readonly string[];
  /** Inconsistent sources by field. Every analysed field has a key, possibly empty. */
  readonly corpusTerms: Readonly<Record<string, readonly ConsistencyEntry[]>>;
  /** The serialized analysis, exactly as written to disk. */
  readonly text: string;
  /** sha256 of `text`. One of the run id's inputs. */
  readonly hash: string;
}

/** What a row's evidence looks like on the record, as opposed to in the prompt. */
export type RecordedEvidence = Readonly<
  Record<string, { readonly source: string; readonly renderings: readonly string[] }>
>;

/** Anything the analysis needs from a corpus row. `ReviewRow` satisfies it. */
export interface ConsistencyRow {
  readonly source: Readonly<Fields>;
  readonly target: Readonly<Fields>;
}

/**
 * Order the entries of one field.
 *
 * Codepoint order, explicitly, and this is load bearing rather than a style
 * choice. `localeCompare` with no locale argument reads the runtime's default
 * locale, so the same corpus analysed on two machines can serialize in two
 * orders and hash to two different run ids - which turns a derived identity
 * into an accident of where it was computed. A collator pinned to one locale
 * fixes the machine but not the decade, because collation data moves with ICU.
 * Codepoint order is the only comparison that is the same everywhere and stays
 * the same, and the ordering has no reader who cares what it means: this file
 * is an input to a hash, and the things a human reads are built from the
 * per-row lookups below.
 */
function byCodepoint(a: ConsistencyEntry, b: ConsistencyEntry): number {
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

/**
 * Find every source string the corpus renders more than one way, per field.
 *
 * A row that has no source value for a field contributes nothing to that field.
 * A row that has a source value and no target value contributes the empty
 * string as a rendering, which is deliberate: a field present in some rows and
 * absent in others is exactly the kind of inconsistency worth showing a
 * reviewer, and silently dropping it would hide it.
 */
export function buildConsistency(
  job: ReviewJob,
  rows: Iterable<ConsistencyRow>,
): ConsistencyAnalysis {
  const fields = reviewedFields(job);
  const perField = new Map<string, Map<string, Set<string>>>();
  for (const field of fields) perField.set(field, new Map());

  for (const { source, target } of rows) {
    for (const field of fields) {
      const src = source[field];
      if (src == null) continue;
      const renderings = perField.get(field) as Map<string, Set<string>>;
      let seen = renderings.get(src);
      if (!seen) {
        seen = new Set();
        renderings.set(src, seen);
      }
      seen.add(target[field] ?? '');
    }
  }

  const corpusTerms: Record<string, ConsistencyEntry[]> = {};
  for (const field of fields) {
    const entries: ConsistencyEntry[] = [];
    for (const [source, renderings] of perField.get(field) as Map<string, Set<string>>) {
      if (renderings.size > 1)
        entries.push({ source, renderings: [...renderings].sort(), count: renderings.size });
    }
    entries.sort(byCodepoint);
    corpusTerms[field] = entries;
  }

  const text = `${JSON.stringify({ fields, corpusTerms })}\n`;
  return {
    fields,
    corpusTerms,
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

// A corpus of any size is analysed once and then asked about per row, so the
// linear scan an entry list would need per row per field is a scan nobody has
// to do. Keyed weakly off the analysis so it costs nothing once the analysis is
// dropped, and off the analysis rather than off the job because the analysis is
// what the answer depends on.
const lookups = new WeakMap<ConsistencyAnalysis, Map<string, Map<string, readonly string[]>>>();

function lookupFor(analysis: ConsistencyAnalysis): Map<string, Map<string, readonly string[]>> {
  const cached = lookups.get(analysis);
  if (cached) return cached;
  const built = new Map<string, Map<string, readonly string[]>>();
  for (const field of analysis.fields) {
    const bySource = new Map<string, readonly string[]>();
    for (const entry of analysis.corpusTerms[field] ?? [])
      bySource.set(entry.source, entry.renderings);
    built.set(field, bySource);
  }
  lookups.set(analysis, built);
  return built;
}

/**
 * The evidence one row's prompt carries: the other renderings, by field.
 *
 * `{}` when the row's source values are all rendered consistently, which is
 * most rows in most corpora - and `{}` is what makes the evidence block vanish
 * from the prompt entirely rather than appear empty. That property is what lets
 * a corpus with no inconsistencies compose the prompts it would have composed
 * before this analysis existed.
 */
export function promptEvidence(
  analysis: ConsistencyAnalysis,
  source: Readonly<Fields>,
): RowEvidence {
  const lookup = lookupFor(analysis);
  const evidence: Record<string, readonly string[]> = {};
  for (const field of analysis.fields) {
    const src = source[field];
    if (src == null) continue;
    const renderings = lookup.get(field)?.get(src);
    if (renderings) evidence[field] = renderings;
  }
  return evidence;
}

/**
 * The evidence one row is recorded with, and whose hash goes in the snapshot.
 *
 * The same finding as {@link promptEvidence} plus the source string it is about.
 * The prompt does not need it - the row's own snapshot already shows the source
 * next to the current rendering - but a stored row is read back long after the
 * corpus has moved, and evidence that does not say what it is evidence about is
 * a list of strings.
 */
export function recordedEvidence(
  analysis: ConsistencyAnalysis,
  source: Readonly<Fields>,
): RecordedEvidence {
  const lookup = lookupFor(analysis);
  const evidence: Record<string, { source: string; renderings: readonly string[] }> = {};
  for (const field of analysis.fields) {
    const src = source[field];
    if (src == null) continue;
    const renderings = lookup.get(field)?.get(src);
    if (renderings) evidence[field] = { source: src, renderings };
  }
  return evidence;
}
