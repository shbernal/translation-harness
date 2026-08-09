// A termbase, as far as this library is concerned: an ordered list of entries,
// each carrying the forms that make it fire and the text it contributes.
//
// This is the framework, not a termbase. There are no term lists here, no
// folding tables, no determiners and no inflection rules, and there never should
// be: which words are canonical is a judgement about one language pair and one
// domain, and a library that shipped that judgement would be making it for every
// host. What is published is the mechanism that a host's own pack plugs into.
//
// The mechanism exists because the seams it uses are easy to wire up wrongly,
// and the failure is silent. A pack reaches a translation run twice - once as
// per-row text through `promptExtras`, once as a digest through `promptSalt` -
// and it reaches a review run twice again, as the `TERMINOLOGY` block and as an
// `extraInputs` entry. Those are four hooks over one input. A host that fills
// them from four places can inject one pack and record the identity of another,
// and what that buys is a resume reusing answers produced under rules nobody can
// still name. Hand all four the same entry list and that state cannot be
// constructed.
//
// Nothing here is translation-specific, which is why it sits at the bottom of
// the layer stack with no imports at all. Only the translation side has an
// adapter, `contract/glossary.ts`, because only it has something to derive: a
// per-row selection and a salt. A review job is shown the standard whole, so it
// assigns `glossaryBlock` and `termsDigest` to two of its own fields and there
// is no third file.

import { createHash } from 'node:crypto';

/**
 * One entry of a host's termbase.
 *
 * The split between the two fields is the whole design. `match` is data the
 * library compares; `render` is text the library only ever copies. That is what
 * keeps every language-policy decision - which label marks a banned form, what
 * separates a source term from its target, whether any of it is in English -
 * on the host's side of the boundary, where it belongs. A library that rendered
 * entries would be choosing those words for every host that ever used it.
 *
 * `render` is a string rather than a callback so that {@link termsDigest} is
 * provably a digest of exactly what gets injected. With a callback the two
 * could disagree and nothing would report it.
 */
export interface TermEntry {
  /**
   * Source forms that make this entry fire on a row. Any one of them matching
   * is enough.
   *
   * An empty list is legitimate rather than a mistake: an entry that never
   * fires per-row still belongs in the standing pack a reviewer is shown.
   */
  readonly match: readonly string[];
  /** The line this entry contributes when it fires. Rendered by the host. */
  readonly render: string;
}

/**
 * Whether `term` occurs in `text`.
 *
 * Deliberately a function and not a table. A profile of folding rules,
 * determiners and inflection suffixes is one matching strategy, and an
 * opinionated one; a predicate is the seam that presumes nothing. A regex
 * profile satisfies it, and so do a stemmer, a lemmatizer, an ICU collator and
 * plain substring search. The library never composes a pattern, so it never
 * needs to know what a determiner is - which is exactly why no language pack
 * has to exist here for the mechanism to ship.
 *
 * It must be a pure function of its two arguments. It runs once per entry per
 * row, and its answers are what {@link glossaryBlock} turns into prompt bytes;
 * a matcher that consults a clock or a locale makes a run unreproducible.
 */
export type TermMatcher = (text: string, term: string) => boolean;

/**
 * The default matcher: case-insensitive substring search.
 *
 * Honestly naive, and named so a stack trace says which one ran. It is right
 * for a pack of proper nouns or product names and wrong for anything inflected -
 * it will not match `Maßnahmen` from `Maßnahme`, and it fires `art` inside
 * `start`. A host whose corpus needs better brings its own; the point of the
 * default is that the floor is zero rather than a language pack.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the locale-sensitive one would
 * make a run's prompts depend on the machine that composed them.
 */
export const substringMatcher: TermMatcher = (text, term) =>
  text.toLowerCase().includes(term.toLowerCase());

/**
 * The entries whose source form occurs in `text`, in entry order.
 *
 * Order is the pack's, not the order they matched in, so the injected block is
 * a function of the pack rather than of the row's word order.
 *
 * Empty `match` forms are skipped rather than matched. Under the default
 * matcher `''` is a substring of everything, so an entry that lost its forms to
 * a bad parse would otherwise fire on every row in the corpus.
 */
export function selectTerms(
  entries: readonly TermEntry[],
  text: string,
  matcher: TermMatcher = substringMatcher,
): TermEntry[] {
  if (!text.trim()) return [];
  return entries.filter((entry) => entry.match.some((term) => term !== '' && matcher(text, term)));
}

/**
 * Render entries as a prompt block, or `''` when there are none.
 *
 * **The empty case is a contract term.** An empty block makes `promptExtras`
 * return `''`, which `buildPrompt` treats as a job with no hook at all, and
 * makes `terminology` empty, which `buildReviewPrompt` treats as a job with no
 * `TERMINOLOGY` block. So a pack that matched nothing on this row, and a pack
 * that is empty entirely, both compose the prompt they would have composed
 * before any of this existed. That is what makes adding a termbase to a corpus
 * already half translated safe.
 *
 * `heading` is optional because the two callers need different things. A
 * per-row block needs one, since the entries arrive with no argument for
 * themselves; the reviewer's standing pack does not, because the prompt frame
 * already labels it.
 */
export function glossaryBlock(entries: readonly TermEntry[], heading?: string): string {
  if (!entries.length) return '';
  const lines = entries.map((entry) => entry.render);
  return heading ? [heading, '', ...lines].join('\n') : lines.join('\n');
}

/**
 * A stable digest of an entry list, or `''` when it is empty.
 *
 * This is the value that goes into `promptSalt` and into `extraInputs`, and it
 * covers **both** fields of every entry rather than just the text. Covering
 * `render` alone would leave a real edit invisible: adding a form to `match`
 * changes nothing a reviewer is shown and changes the per-row block on every
 * row that form occurs in, so a digest over the rendered text would report two
 * materially different runs as one.
 *
 * Order-sensitive, because the entry order is the block's line order and a
 * reordered pack produces different prompt bytes.
 *
 * **Empty digests to the empty string**, and that is the same contract term
 * `extraInputsDigest` and `promptSalt` already carry: a mechanism a host can
 * decline to use must cost nothing to the hosts declining it. Both adapters
 * depend on it to leave hashes and run ids exactly where they were.
 */
export function termsDigest(entries: readonly TermEntry[]): string {
  if (!entries.length) return '';
  const material = JSON.stringify(entries.map((entry) => [[...entry.match], entry.render]));
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
