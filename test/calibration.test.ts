// What the shipped guardrail thresholds actually do to human translations.
//
// `DEFAULT_THRESHOLDS` is a claim about how translated text behaves, and until
// this test existed it was folklore: two numbers calibrated on one language
// pair in one private corpus, published as a library default. This measures
// them against committed, human-translated material and states the result as
// what it is - measured over these pairs, on this material. A pair the corpus
// does not contain is unmeasured, not blessed.
//
// **This test is allowed to fail loudly when the corpus changes.** That is its
// job. If a new source pushes a pair past the bound, the answer is to look at
// the flagged rows and find out whether the threshold or the material is
// wrong - not to raise the bound until it is green again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { genericReviewReasons } from '../src/contract/validate.ts';
import { DEFAULT_THRESHOLDS } from '../src/job.ts';
import { concatenated, fieldKeys, loadCorpus, type Pair, pairs } from './helpers/fixtures.ts';

const corpus = loadCorpus();
const keysOf = new Map(corpus.map((s) => [s.meta.id, fieldKeys(s)]));

/**
 * The share of a pair's rows the length check would send to review.
 *
 * Only the ratio reason: the bracket and identical-output checks are exact
 * rather than tuned, so folding them in would blur the one number this test is
 * about.
 */
function ratioFlagRate(pair: Pair): { flagged: number; total: number; rows: string[] } {
  const keys = keysOf.get(pair.sourceId)!;
  const rows: string[] = [];
  for (const row of pair.rows) {
    const [source, target] = concatenated(row, keys);
    const reasons = genericReviewReasons(source, target, DEFAULT_THRESHOLDS);
    if (reasons.some((r) => r.startsWith('suspicious combined length ratio'))) {
      rows.push(row.identifier);
    }
  }
  return { flagged: rows.length, total: pair.rows.length, rows };
}

const measured = pairs(corpus);

test('the corpus yields enough pairs to be worth calling a calibration', () => {
  assert.ok(measured.length >= 8, `${measured.length} pairs is not a distribution`);
});

// The bound. Chosen from the measurement rather than the other way round: at
// the time of writing the worst pair sits at 5.6% and the great majority are
// under 3%, so 10% leaves room for an ordinary contribution to shift the
// picture while still catching a threshold that has stopped meaning anything.
const MAX_FLAG_RATE = 0.1;

for (const pair of measured) {
  test(`${pair.sourceId} ${pair.from} -> ${pair.to}: the length check stays quiet`, () => {
    const { flagged, total, rows } = ratioFlagRate(pair);
    const rate = flagged / total;
    assert.ok(
      rate <= MAX_FLAG_RATE,
      `${(100 * rate).toFixed(1)}% of ${total} human-translated rows flagged ` +
        `(bound ${100 * MAX_FLAG_RATE}%): ${rows.slice(0, 10).join(', ')}`,
    );
  });
}

test('the defaults are not so wide that they would miss a dropped translation', () => {
  // The mirror of every test above. A threshold pair of 0 and Infinity would
  // pass all of them, so the calibration has to show the check still fires on
  // the thing it exists for: an answer that lost most of its content.
  const pair = measured[0]!;
  const keys = keysOf.get(pair.sourceId)!;
  const [source] = concatenated(pair.rows[0]!, keys);
  const truncated = source.slice(0, Math.floor(source.length * 0.2));
  const reasons = genericReviewReasons(source, truncated, DEFAULT_THRESHOLDS);
  assert.ok(
    reasons.some((r) => r.startsWith('suspicious combined length ratio')),
    'a translation missing four fifths of its source passed the length check',
  );
});

test('short interface labels do not trip the lower bound the way the docs feared', () => {
  // Worth pinning, because the shipped guidance used to assert the opposite.
  // The Godot rows are 3 to 60 characters and the shortest tail of them still
  // sits inside the defaults, so the failure mode is real but needs strings
  // far shorter than a real interface has.
  const godot = corpus.find((s) => s.meta.id === 'godot-editor-ui');
  if (!godot) return; // the corpus is discovered, so this source may be gone
  const short = measured.filter((p) => p.sourceId === 'godot-editor-ui');
  assert.ok(short.length > 0);
  for (const pair of short) {
    const { flagged, total } = ratioFlagRate(pair);
    assert.ok(
      flagged / total <= 0.05,
      `${pair.from} -> ${pair.to}: ${flagged}/${total} short labels flagged`,
    );
  }
});
