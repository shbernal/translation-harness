// The termbase framework: the shared core, and the adapter that binds it to a
// translation job.
//
// One property carries most of this file, and it is the one the feature exists
// for. **An empty pack is invisible.** Every path is asserted against the job
// that never had a termbase at all - the same prompt bytes, the same prompt
// hash. Adding a pack to a corpus already half translated has to be safe, and
// "safe" here means byte-identical rather than roughly equivalent.
//
// The review side has no adapter and so has nothing here beyond what the core's
// own cases already cover: it fills `terminology` from `glossaryBlock` and its
// host input from `termsDigest`, both tested above on their own terms.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { glossaryHook } from '../src/contract/glossary.ts';
import { buildPrompt, jobPromptHash, promptExtrasFor } from '../src/contract/prompt.ts';
import {
  glossaryBlock,
  selectTerms,
  substringMatcher,
  type TermEntry,
  type TermMatcher,
  termsDigest,
} from '../src/glossary.ts';
import type { Fields, TranslationJob } from '../src/job.ts';
import { GOLDEN_ROW, TEST_JOB } from './helpers/job.ts';

/**
 * A three-entry pack in the shape a host would author it: `render` already
 * carries the host's own labels and its own language, which is the boundary the
 * library is on the other side of.
 */
const PACK: TermEntry[] = [
  { match: ['access control'], render: '- access control -> controle d acces' },
  { match: ['policy', 'policies'], render: '- policy -> politique (eviter: police)' },
  { match: ['audit record'], render: '- audit record -> registre d audit' },
];

const HEADING = 'Termbase entries whose source term occurs in this row.';

describe('selectTerms', () => {
  test('keeps pack order rather than the order the forms matched in', () => {
    // `policy` occurs before `access control` in the text and after it in the
    // pack. The block is a function of the pack, not of the row's word order.
    const selected = selectTerms(PACK, 'The policy governs access control.');
    assert.deepEqual(
      selected.map((entry) => entry.render),
      [PACK[0]?.render, PACK[1]?.render],
    );
  });

  test('fires an entry on any one of its forms', () => {
    assert.equal(selectTerms(PACK, 'These policies apply.').length, 1);
  });

  test('answers nothing for blank text', () => {
    assert.deepEqual(selectTerms(PACK, '   \n  '), []);
  });

  test('never fires on an empty form, which would otherwise match every row', () => {
    // What a bad parse looks like: an entry whose forms were dropped. Under the
    // default matcher '' is a substring of everything, so the entry would
    // attach itself to the whole corpus rather than to nothing.
    const broken: TermEntry[] = [{ match: [''], render: '- ghost' }];
    assert.deepEqual(selectTerms(broken, 'any text at all'), []);
    assert.deepEqual(selectTerms([{ match: [], render: '- ghost' }], 'any text at all'), []);
  });

  test('uses the matcher it is given, and the library composes no pattern of its own', () => {
    // The seam that means no language pack has to exist here: a host whose
    // corpus needs inflection supplies the rule, and nothing in the library
    // knows what it did.
    // A determiner the text inserts and the citation form does not carry, which
    // is the shape of the rule a real pack needs and the default cannot express.
    const withoutDeterminers: TermMatcher = (text, term) => {
      const strip = (s: string): string =>
        s
          .toLowerCase()
          .replace(/\b(?:des|du|de|les|le|la)\b/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      return strip(text).includes(strip(term));
    };
    const pack: TermEntry[] = [
      { match: ['analyse de vulnerabilites'], render: '- analyse de vulnerabilites' },
    ];
    const row = 'Une analyse des vulnerabilites est requise.';
    assert.deepEqual(selectTerms(pack, row), []);
    assert.deepEqual(selectTerms(pack, row, withoutDeterminers), pack);
  });
});

describe('substringMatcher', () => {
  test('is case-insensitive in both directions', () => {
    assert.ok(substringMatcher('The POLICY applies', 'policy'));
    assert.ok(substringMatcher('the policy applies', 'POLICY'));
  });

  test('is honestly naive, and the default is documented as such', () => {
    // Pinned rather than fixed. A host that cannot live with either answer
    // brings its own matcher, which is the design; changing these two here
    // would be shipping a language opinion in the default.
    // The direction that bites: a pack authored with the attested plural finds
    // nothing in a row carrying the singular.
    assert.ok(!substringMatcher('Die Massnahme greift', 'Massnahmen'), 'no inflection');
    assert.ok(substringMatcher('restart the service', 'art'), 'no word boundary');
  });
});

describe('glossaryBlock', () => {
  test('is empty for no entries, which is what every vanishing property rests on', () => {
    assert.equal(glossaryBlock([], HEADING), '');
    assert.equal(glossaryBlock([]), '');
  });

  test('separates the heading from the entries with a blank line', () => {
    assert.equal(
      glossaryBlock(PACK.slice(0, 2), HEADING),
      `${HEADING}\n\n${PACK[0]?.render}\n${PACK[1]?.render}`,
    );
  });

  test('emits the entries alone when there is no heading', () => {
    assert.equal(glossaryBlock(PACK.slice(0, 1)), PACK[0]?.render);
  });

  test('copies render verbatim, so the host owns every word the model sees', () => {
    const entry: TermEntry = { match: ['x'], render: '  * X === Y  (SPECIAL) ' };
    assert.equal(glossaryBlock([entry]), '  * X === Y  (SPECIAL) ');
  });
});

describe('termsDigest', () => {
  test('is the empty string for an empty pack', () => {
    assert.equal(termsDigest([]), '');
  });

  test('is stable for the same list', () => {
    assert.equal(termsDigest(PACK), termsDigest([...PACK]));
    assert.match(termsDigest(PACK), /^[0-9a-f]{64}$/);
  });

  test('moves when a match form is added, though nothing rendered changes', () => {
    // The reason the digest covers both fields. This edit changes the per-row
    // block on every row containing the new form and changes no rendered text
    // anywhere, so a digest over the rendering alone would call two materially
    // different runs one run.
    const widened = PACK.map((entry, i) =>
      i === 0 ? { ...entry, match: [...entry.match, 'access controls'] } : entry,
    );
    assert.equal(
      glossaryBlock(widened),
      glossaryBlock(PACK),
      'the rendered pack is unchanged, which is the point',
    );
    assert.notEqual(termsDigest(widened), termsDigest(PACK));
  });

  test('moves when rendered text changes', () => {
    const edited = PACK.map((entry, i) =>
      i === 1 ? { ...entry, render: `${entry.render} [ANSSI]` } : entry,
    );
    assert.notEqual(termsDigest(edited), termsDigest(PACK));
  });

  test('moves when the entries are reordered, because the block does', () => {
    const reordered = [PACK[1], PACK[0], PACK[2]] as TermEntry[];
    assert.notEqual(termsDigest(reordered), termsDigest(PACK));
  });
});

describe('glossaryHook', () => {
  const hook = glossaryHook({ entries: PACK, heading: HEADING, fields: TEST_JOB.fields });
  const job: TranslationJob = { ...TEST_JOB, ...hook };

  test('injects the entries the row contains, under the heading', () => {
    const extras = promptExtrasFor(job, GOLDEN_ROW.source);
    assert.equal(extras, `${HEADING}\n\n${PACK[0]?.render}\n${PACK[1]?.render}`);
  });

  test('injects nothing for a row that contains no term', () => {
    assert.equal(promptExtrasFor(job, { name: 'Nothing here', type: null, description: null }), '');
  });

  test('reads the translatable fields, not the passthrough ones', () => {
    // A term found in an identifier column is not a term the model is about to
    // render, and a hook that read one would inject guidance for a value nobody
    // is translating.
    const source: Fields = { name: 'Unrelated', type: 'audit record', description: null };
    assert.equal(promptExtrasFor(job, source), '');
  });

  test('reads every value when no field list is given', () => {
    const loose = glossaryHook({ entries: PACK, heading: HEADING });
    const source: Fields = { name: 'Unrelated', type: 'audit record', description: null };
    assert.equal(loose.promptExtras?.(source), `${HEADING}\n\n${PACK[2]?.render}`);
  });

  test('does not depend on the order the host built the row object in', () => {
    const loose = glossaryHook({ entries: PACK, heading: HEADING });
    const a: Fields = { name: 'Access control policy', description: 'Audit record kept.' };
    const b: Fields = { description: 'Audit record kept.', name: 'Access control policy' };
    assert.equal(loose.promptExtras?.(a), loose.promptExtras?.(b));
  });

  test('salts on the pack digest, so a pack edit is visible on a row it did not touch', () => {
    assert.equal(hook.promptSalt, termsDigest(PACK));
    const edited = glossaryHook({
      entries: [...PACK, { match: ['zzz'], render: '- zzz -> zzz' }],
      heading: HEADING,
      fields: TEST_JOB.fields,
    });
    assert.notEqual(
      jobPromptHash({ ...TEST_JOB, ...edited }),
      jobPromptHash(job),
      'a row that matched nothing new still belongs to a different run',
    );
  });

  test('keeps a salt the host already had, instead of replacing it silently', () => {
    const salted = glossaryHook({ entries: PACK, heading: HEADING, salt: 'style-guide-v4' });
    assert.equal(salted.promptSalt, `style-guide-v4${termsDigest(PACK)}`);
  });

  describe('an empty pack reproduces the job that never had one', () => {
    const empty = glossaryHook({ entries: [], heading: HEADING, fields: TEST_JOB.fields });
    const emptyJob: TranslationJob = { ...TEST_JOB, ...empty };

    test('composes byte-identical prompts', () => {
      assert.equal(
        buildPrompt(
          emptyJob,
          GOLDEN_ROW.identifier,
          GOLDEN_ROW.source,
          promptExtrasFor(emptyJob, GOLDEN_ROW.source),
        ),
        buildPrompt(TEST_JOB, GOLDEN_ROW.identifier, GOLDEN_ROW.source),
      );
    });

    test('leaves the prompt hash exactly where it was', () => {
      assert.equal(jobPromptHash(emptyJob), jobPromptHash(TEST_JOB));
    });

    test('gives back only the salt it was handed', () => {
      assert.equal(glossaryHook({ entries: [], heading: HEADING, salt: 's' }).promptSalt, 's');
    });
  });
});
