// Runs chain: what a finished review run actually says the corpus should read.
//
// A review run does not mutate anything, so "the output of run 1" is not a
// place - it is a computation over run 1's snapshot and its proposals. Two
// callers need it and they must agree: a chained run snapshots it as its own
// target, and an exporter renders it as the stage's result. Two halves of one
// database each deciding what a resolved run means is the split that forced
// `tx` and `parseFields` into this library during the pilot, so this ships once.

import type { Fields } from '../job.ts';
import type { ReviewItem } from '../store/review-types.ts';

/**
 * A review run's resolved output, by row number: the target it snapshotted,
 * with each accepted proposal written over it.
 *
 * Only a `change_proposed` row contributes a rewrite, and only for the fields
 * whose proposal is non-null - `null` is how a reviewer says "keep what is
 * there", per field, so a row that changed one field of three leaves the other
 * two exactly as they were. A `pass` row resolves to its snapshot unchanged,
 * and so does a row that never got an answer: the run's own outcome column is
 * where "this row was not reviewed" is recorded, not here.
 *
 * Nothing is read from the live corpus. That is the property chaining depends
 * on - a run resolves to what it says today and what it will say in a year,
 * whatever happens to the rows it was taken from.
 */
export function resolveRunOutput(snapshot: Iterable<ReviewItem>): Map<number, Fields> {
  const resolved = new Map<number, Fields>();
  for (const item of snapshot) {
    const target: Fields = { ...item.target };
    if (item.outcome === 'change_proposed' && item.proposals) {
      for (const [key, value] of Object.entries(item.proposals)) {
        if (value != null) target[key] = value;
      }
    }
    resolved.set(item.rowNumber, target);
  }
  return resolved;
}
