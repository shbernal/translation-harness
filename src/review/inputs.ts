// Host-specific inputs, folded into a run's identity without the library
// knowing what any of them are.
//
// A review run id is derived from every input, which is the property that makes
// init idempotent and makes "the prompt changed" indistinguishable from "this is
// a different run". A host with an input of its own - a termbase digest, a style
// guide revision, the version of some upstream analysis - has to be able to
// reach that derivation, or its runs collide: two materially different reviews
// resolving to one id, the second one recognised as the first and never
// executed.
//
// This is the same problem `promptSalt` solved on the translate side, and it is
// solved the same way: the library takes opaque strings, hashes them, and never
// asks what they mean.

import { createHash } from 'node:crypto';
import type { ReviewJob } from './job.ts';

/**
 * Digest a job's `extraInputs`, in sorted key order.
 *
 * **An empty or absent bag digests to the empty string**, and that is a
 * contract term rather than an implementation detail. The derivation appends
 * this digest to its input string rather than joining it in with the rest, so a
 * job that sets nothing produces exactly the run id it would have produced
 * before `extraInputs` existed. `promptSalt` earns the same guarantee the same
 * way, and for the same reason: a mechanism a host can decline to use must cost
 * nothing to the hosts declining it.
 *
 * Keys are sorted by codepoint, not by locale, so the digest is a property of
 * the bag and not of the machine that hashed it.
 */
export function extraInputsDigest(job: ReviewJob): string {
  const extra = job.extraInputs;
  if (!extra) return '';
  const keys = Object.keys(extra).sort();
  if (!keys.length) return '';
  const canonical: Record<string, string> = {};
  for (const key of keys) {
    const value = extra[key];
    // A missing value would vanish from the serialization and digest as though
    // the key were not there, which is the one failure this whole mechanism
    // exists to prevent - two different sets of inputs agreeing on an id.
    if (typeof value !== 'string')
      throw new Error(
        `extraInputs['${key}'] must be a string, got ${value === undefined ? 'undefined' : typeof value}`,
      );
    canonical[key] = value;
  }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
