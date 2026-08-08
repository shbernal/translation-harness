// The three-way decision, and resolving it into a final value.
//
// A review run only ever proposes. Somebody then goes through it and decides,
// per field, one of exactly three things: keep the value that was reviewed, take
// the reviewer's proposal, or write something else. That much is universal, and
// so is turning those choices into the text the corpus should read. What is not
// universal is *where the choices come from* - a workbook column, a web form, a
// diff a human accepted at a terminal - so nothing here knows about any of them.
//
// This is the sibling of `resolveRunOutput` in `chain.ts`: both answer "what
// does this run say the corpus should read", and both answer it as a value
// rather than by writing anywhere. They differ in who is asked. `resolveRunOutput`
// asks the run - every `change_proposed` row contributes its proposals - which
// is what a *chained* run needs, because there is no human in that loop.
// `resolveDecisions` asks a person, so it can honour a proposal on a row the
// reviewer graded `pass` (the store keeps a verdict and a proposal separately,
// and a human reading both may well prefer the proposal), and it has somebody to
// report a nonsensical choice back to.

import type { Fields } from '../job.ts';

export const REVIEW_DECISION_KINDS = ['keep', 'proposal', 'custom'] as const;

/**
 * A row to decide about: what was under review, and what was proposed for it.
 *
 * Four fields rather than a `ReviewItem`, which satisfies this, because the
 * other caller does not have one. Decisions arrive from outside the run, and so
 * does the thing they were made about: a hand-validated workbook carries the
 * value under review and the proposal in its own columns, and those columns -
 * not the run as it stands today - are what the person was reading when they
 * chose. Asking that caller for a snapshot would let two inputs disagree with no
 * way to tell which one the decision was about; asking it for hashes it does not
 * have would be asking it to invent them.
 */
export interface ReviewDecisionRow {
  /**
   * This row's key in whatever the caller is resolving. A snapshot's row number
   * for a run; any stable number for a form. It is the key {@link
   * ReviewDecisionResult.resolved} comes back under and is never interpreted.
   */
  readonly rowNumber: number;
  readonly identifier: string;
  /** The value under review, per field. */
  readonly target: Readonly<Fields>;
  /** What the reviewer proposed, per field, `null` per field where nothing was. */
  readonly proposals?: Readonly<Fields> | null;
}

/**
 * What was decided about one field of one row.
 *
 * `keep` is the value under review: the accepted corpus target this run
 * snapshotted, or a base run's resolved output if this run chains. Named for
 * what it does rather than for where the value came from, because those are the
 * same thing only for an unchained run.
 */
export type ReviewDecisionKind = (typeof REVIEW_DECISION_KINDS)[number];

/** One field's decision, as two cells of a form: a choice and a rewrite. */
export interface ReviewDecision {
  readonly kind: ReviewDecisionKind;
  /**
   * The rewrite, when `kind` is `custom`. Ignored otherwise, deliberately: a
   * rewrite left behind next to a choice of something else is a draft somebody
   * abandoned, and the choice is the decision.
   */
  readonly custom?: string | null;
}

/**
 * Decisions by identifier, then by field.
 *
 * Keyed by identifier rather than by row number, which is the one asymmetry in
 * this file and is worth reading once. A decision comes from *outside* the run,
 * where the identifier is the only key that survives the round trip: a workbook
 * carries an identifier column, a human sorts and filters it, and a row number
 * within a review run is not a thing anybody is looking at. The value this
 * returns is in the run's own terms, so it is keyed the way the run keys itself.
 *
 * A row with no entry, or a field with no entry, is a `keep` that nobody had to
 * write down.
 */
export type ReviewDecisions = ReadonlyMap<string, Readonly<Record<string, ReviewDecision>>>;

/** What the decisions resolve to, and what could not be honoured. */
export interface ReviewDecisionResult {
  /**
   * The final value for **every** row of the run, by row number, whether or not
   * anybody decided anything about it. A review run is a fixed object covering a
   * whole corpus, so resolving it is resolving all of it; a caller who wants only
   * the rows a human touched has the decision map to filter by.
   */
  readonly resolved: Map<number, Fields>;
  /**
   * How many field decisions were *chosen* each way, counting only the ones
   * somebody wrote down. A choice that could not be honoured still counts under
   * what was chosen, and says so in a warning: the tally answers "what did the
   * human do", not "what did the text end up being".
   */
  readonly counts: Readonly<Record<ReviewDecisionKind, number>>;
  /**
   * Every choice that could not be honoured, in the order a reader would work
   * through them: row by row in snapshot order first, then the field names this
   * run does not have, then the identifiers it does not have.
   *
   * Warnings rather than refusals, because each one is a cell somebody filled in
   * wrong and the other ten thousand cells are still worth publishing. Every case
   * falls back to the value under review, which is the choice that changes
   * nothing.
   */
  readonly warnings: readonly string[];
}

const KINDS = new Set<string>(REVIEW_DECISION_KINDS);

/**
 * Apply a human's decisions to a review run's snapshot.
 *
 * Nothing is normalized. The proposals in the snapshot were normalized when
 * `validateReview` accepted them, so they arrive here already in the target
 * language's typography; a rewrite a person typed is written exactly as typed,
 * because a library that silently retypes somebody's quotation marks is editing
 * a decision it was asked to record. That is also why this needs no `ReviewJob`.
 *
 * Nothing is read from the live corpus either, for the same reason
 * `resolveRunOutput` does not: a run resolves to what it says today and what it
 * will say in a year.
 */
export function resolveDecisions(
  snapshot: Iterable<ReviewDecisionRow>,
  decisions: ReviewDecisions,
): ReviewDecisionResult {
  const rows = [...snapshot];

  // The one thing this refuses. `deriveReviewRun` already rejects a corpus with
  // two rows under one identifier, so a real snapshot cannot get here - but the
  // decision map is keyed by identifier, so if one did there would be no answer
  // to which row a decision meant, and guessing is worse than stopping.
  const byIdentifier = new Set<string>();
  for (const row of rows) {
    if (byIdentifier.has(row.identifier))
      throw new Error(
        `The snapshot has two rows identified '${row.identifier}'; a decision names a row by ` +
          'identifier, so there is no answer to which of them it was about',
      );
    byIdentifier.add(row.identifier);
  }

  // Which field names this run is about, taken from the run rather than from a
  // job. A field can be absent from one row's target and present in another's
  // (a row whose target never had that value), so the question is only
  // answerable over the whole snapshot.
  const known = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row.target)) known.add(field);
    if (row.proposals) for (const field of Object.keys(row.proposals)) known.add(field);
  }

  const resolved = new Map<number, Fields>();
  const counts: Record<ReviewDecisionKind, number> = { keep: 0, proposal: 0, custom: 0 };
  const warnings: string[] = [];
  // Counted rather than reported per row. One mistyped column header is one
  // mistake, and a run of 2,125 rows would otherwise report it 2,125 times and
  // bury everything else.
  const unknownFields = new Map<string, number>();

  for (const row of rows) {
    const target: Fields = { ...row.target };
    // The caller's own field order, which is the order their columns were in.
    for (const [field, decision] of Object.entries(decisions.get(row.identifier) ?? {})) {
      const where = `${row.identifier} · ${field}`;
      if (!known.has(field)) {
        unknownFields.set(field, (unknownFields.get(field) ?? 0) + 1);
        continue;
      }
      if (!KINDS.has(decision.kind)) {
        warnings.push(
          `${where}: unrecognized decision ${JSON.stringify(decision.kind)}; ` +
            'kept the value under review',
        );
        continue;
      }
      switch (decision.kind) {
        case 'keep':
          counts.keep += 1;
          break;
        case 'proposal': {
          counts.proposal += 1;
          const proposed = row.proposals?.[field];
          if (proposed == null) {
            warnings.push(
              `${where}: 'proposal' chosen but the reviewer proposed nothing here; ` +
                'kept the value under review',
            );
            break;
          }
          target[field] = proposed;
          break;
        }
        case 'custom': {
          counts.custom += 1;
          // An empty rewrite is a cell somebody meant to fill in. Reading it as
          // "blank this field" would let a slip delete text silently, and the
          // way to blank a field is to say so in a rewrite of one space.
          if (decision.custom == null || decision.custom === '') {
            warnings.push(
              `${where}: 'custom' chosen but no rewrite was supplied; kept the value under review`,
            );
            break;
          }
          target[field] = decision.custom;
          break;
        }
      }
    }
    resolved.set(row.rowNumber, target);
  }

  for (const [field, count] of unknownFields)
    warnings.push(
      `${JSON.stringify(field)} is not a field of this review run; ` +
        `ignored on ${count} row${count === 1 ? '' : 's'}`,
    );
  for (const identifier of decisions.keys())
    if (!byIdentifier.has(identifier))
      warnings.push(`${identifier}: not a row of this review run; ignored`);

  return { resolved, counts, warnings };
}
