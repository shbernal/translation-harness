// The quality gate: what fails a row, what merely flags it, and the line
// between the two.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  genericReviewReasons,
  type ModalLevel,
  missingReferences,
  modalForceShiftsFor,
  validateResponse,
} from '../src/contract/validate.ts';
import { TransientFailure } from '../src/errors.ts';
import { DEFAULT_THRESHOLDS, type TranslationJob, type ValidationContext } from '../src/job.ts';

const REF = /\b[A-Z]{2}-\d+(?:\(\d+\))?\b/g;

const job: TranslationJob = {
  id: 'test',
  sourceLang: 'English',
  targetLang: 'French',
  fields: [
    { key: 'name', label: 'Name', translate: true, required: true },
    { key: 'description', label: 'Description', translate: true, required: false },
  ],
  promptTemplate: 'GUIDANCE',
  validators: [(ctx) => missingReferences(REF, ctx)],
};

const goodValue = {
  identifier: 'AC-1',
  translations: { name: 'Politique', description: 'Voir AC-2 et AC-3.' },
  warnings: [],
};

describe('validateResponse: structural failures', () => {
  test('a clean response yields no review reasons', () => {
    const source = { name: 'Policy', description: 'See AC-2 and AC-3.' };
    const result = validateResponse(job, source, 'AC-1', goodValue);
    assert.deepEqual(result.translations, { name: 'Politique', description: 'Voir AC-2 et AC-3.' });
    assert.deepEqual(result.reviewReasons, []);
  });

  test('a response that is not an object at all', () => {
    for (const value of ['a string', 42, null, ['an', 'array']]) {
      assert.throws(
        () => validateResponse(job, {}, 'AC-1', value),
        (error: unknown) => error instanceof TransientFailure && error.category === 'invalid_shape',
        `${JSON.stringify(value)} should not pass as a response`,
      );
    }
  });

  test('a missing top-level key names the key', () => {
    assert.throws(
      () => validateResponse(job, {}, 'AC-1', { identifier: 'AC-1', translations: {} }),
      /missing 'warnings'/,
    );
  });

  test('identifier mismatch is a hard failure with its own category', () => {
    // It means the model answered about a different row, which no retry policy
    // should treat as an ordinary bad answer.
    assert.throws(
      () => validateResponse(job, { name: 'Policy', description: 'x' }, 'AC-9', goodValue),
      (error: unknown) =>
        error instanceof TransientFailure && error.category === 'identifier_mismatch',
    );
  });

  test('warnings must be an array of strings', () => {
    const source = { name: 'Policy', description: 'x' };
    assert.throws(
      () => validateResponse(job, source, 'AC-1', { ...goodValue, warnings: 'oops' }),
      /warnings must be an array of strings/,
    );
    assert.throws(
      () => validateResponse(job, source, 'AC-1', { ...goodValue, warnings: [1, 2] }),
      /warnings must be an array of strings/,
    );
  });

  test('a blank source field must translate to null', () => {
    const value = {
      identifier: 'AC-1',
      translations: { name: 'Politique', description: 'oops' },
      warnings: [],
    };
    assert.throws(
      () => validateResponse(job, { name: 'Policy', description: null }, 'AC-1', value),
      (error: unknown) => error instanceof TransientFailure && error.category === 'blank_contract',
    );
  });

  test('an absent source field counts as blank, not as missing', () => {
    const result = validateResponse(job, { name: 'Policy' }, 'AC-1', {
      identifier: 'AC-1',
      translations: { name: 'Politique', description: null },
      warnings: [],
    });
    assert.equal(result.translations.description, null);
  });

  test('a non-blank source needs a non-empty translation', () => {
    for (const description of ['', '   ', null, 42]) {
      assert.throws(
        () =>
          validateResponse(job, { name: 'Policy', description: 'text' }, 'AC-1', {
            identifier: 'AC-1',
            translations: { name: 'Politique', description },
            warnings: [],
          }),
        /non-empty/,
        `${JSON.stringify(description)} should not pass as a translation`,
      );
    }
  });
});

describe('validateResponse: review reasons', () => {
  test('dropped references become a review reason, not a failure', () => {
    const result = validateResponse(
      job,
      { name: 'Policy', description: 'See AC-2 and AC-3.' },
      'AC-1',
      {
        identifier: 'AC-1',
        translations: { name: 'Politique', description: 'Voir AC-2.' },
        warnings: [],
      },
    );
    assert.ok(result.reviewReasons.some((r) => r.includes('AC-3')));
    assert.equal(result.translations.description, 'Voir AC-2.', 'the row is still usable');
  });

  test('model warnings surface as review reasons', () => {
    const result = validateResponse(
      job,
      { name: 'Policy', description: 'See AC-2 and AC-3.' },
      'AC-1',
      {
        ...goodValue,
        warnings: ['ambiguous term'],
      },
    );
    assert.ok(result.reviewReasons.some((r) => r === 'model warning: ambiguous term'));
  });
});

describe('normalize', () => {
  test('runs at the assignment, so what is checked is what is stored', () => {
    // The invariant: the guardrails, the store, and whatever the host renders
    // all see one canonical text. A job with no hook changes nothing.
    const normalizing: TranslationJob = {
      ...normalizeJob(),
      normalize: (v) => v.replace(/'/g, '’'),
    };
    const result = validateResponse(normalizing, { name: 'Policy' }, 'AC-1', {
      identifier: 'AC-1',
      translations: { name: "l'acces" },
      warnings: [],
    });
    assert.equal(result.translations.name, 'l’acces');
  });

  test('is what makes the identical-output check see normalized text', () => {
    // Without normalization first, a source and a translation that differ only
    // in a character the normalizer unifies would slip past the check.
    const normalizing: TranslationJob = {
      ...normalizeJob(),
      normalize: (v) => v.replace(/'/g, '’'),
    };
    const result = validateResponse(normalizing, { name: 'l’acces' }, 'AC-1', {
      identifier: 'AC-1',
      translations: { name: "l'acces" },
      warnings: [],
    });
    assert.ok(result.reviewReasons.some((r) => r.includes('identical')));
  });

  function normalizeJob(): TranslationJob {
    return {
      ...job,
      fields: [{ key: 'name', label: 'Name', translate: true, required: true }],
      validators: [],
    };
  }
});

describe('genericReviewReasons', () => {
  const T = DEFAULT_THRESHOLDS;

  test('flags bracket drift in either direction', () => {
    assert.ok(genericReviewReasons('a [x] b', 'a b', T).some((r) => r.includes('bracket')));
    assert.ok(genericReviewReasons('a b', 'a [x] b', T).some((r) => r.includes('bracket')));
  });

  test('flags output identical to the source, but not when both are blank', () => {
    assert.ok(genericReviewReasons('same', 'same', T).some((r) => r.includes('identical')));
    assert.ok(
      !genericReviewReasons('', '', T).some((r) => r.includes('identical')),
      'two blanks are not an untranslated row',
    );
  });

  test('a row whose fields are all blank is flagged, and says so in those terms', () => {
    // The behaviour is kept: `0 / max(0, 1)` is below any sane lower bound, so a
    // row where every translatable field is empty is still sent to review, which
    // is defensible (a row with nothing to translate is worth a human glance).
    // What changed is the reason. `suspicious combined length ratio: 0.00`
    // described the arithmetic and read as a warning about the translation;
    // there is no translation to warn about. A resumed run reports different
    // text for these rows, not a different set of rows.
    assert.deepEqual(genericReviewReasons('', '', T), ['no translatable content']);
  });

  test('flags a suspicious length ratio and says what it was', () => {
    const short = genericReviewReasons('a'.repeat(100), 'b'.repeat(10), T);
    assert.ok(short.some((r) => /suspicious combined length ratio: 0\.10/.test(r)));
    const long = genericReviewReasons('a'.repeat(10), 'b'.repeat(100), T);
    assert.ok(long.some((r) => /suspicious combined length ratio: 10\.00/.test(r)));
  });

  test('the bounds are a parameter, because the defaults fit one shape of text', () => {
    // A corpus of short interface strings trips the lower bound on almost every
    // row: three characters is a large ratio when the string is six long.
    const tight = { minLengthRatio: 0.9, maxLengthRatio: 1.1 };
    assert.ok(genericReviewReasons('hello there', 'salut', tight).some((r) => r.includes('ratio')));
    const wide = { minLengthRatio: 0.1, maxLengthRatio: 10 };
    assert.deepEqual(genericReviewReasons('hello there', 'salut', wide), []);
  });

  test('a job can widen the bounds and the validator honours it', () => {
    const source = { name: 'A very long source string indeed, quite long' };
    const value = { identifier: 'X', translations: { name: 'Court' }, warnings: [] };
    const narrow: TranslationJob = {
      ...job,
      fields: [{ key: 'name', label: 'Name', translate: true, required: true }],
      validators: [],
    };
    assert.ok(
      validateResponse(narrow, source, 'X', value).reviewReasons.some((r) => r.includes('ratio')),
    );
    const relaxed: TranslationJob = { ...narrow, thresholds: { minLengthRatio: 0.05 } };
    assert.deepEqual(validateResponse(relaxed, source, 'X', value).reviewReasons, []);
  });
});

describe('modalForceShiftsFor', () => {
  // The level table is the caller's: which words mark which level is a
  // judgement about one language pair, and the counting loop is the mechanism.
  const EN_FR: readonly ModalLevel[] = [
    { level: 'MUST', source: /\bMUST\b/g, target: /\b(?:DOIT|DOIVENT)\b/g },
    { level: 'SHOULD', source: /\bSHOULD\b/g, target: /\b(?:DEVRAIT|DEVRAIENT)\b/g },
    { level: 'MAY', source: /\bMAY\b/g, target: /\b(?:PEUT|PEUVENT)\b/g },
  ];

  const ctx = (source: Record<string, string | null>, translated: Record<string, string>) =>
    ({ identifier: 'X.1', source, translated }) satisfies ValidationContext;

  const shifts = (source: Record<string, string | null>, translated: Record<string, string>) =>
    modalForceShiftsFor(EN_FR, ctx(source, translated));

  test('matching force yields no reason', () => {
    assert.deepEqual(
      shifts(
        { description: 'The key MUST be stored separately. Logs SHOULD be checked.' },
        {
          description:
            'La clé DOIT être conservée séparément. Les journaux DEVRAIENT être vérifiés.',
        },
      ),
      [],
    );
  });

  test('an obligation rendered as an advisory impersonal is flagged', () => {
    // The real defect this exists for: idiomatic target prose that carries no
    // modal verb at all, so the obligation silently becomes a suggestion while
    // the row stays structurally valid and exports clean.
    const found = shifts(
      { description: 'In particular, the network transitions MUST be considered.' },
      { description: 'Il convient notamment de prendre en compte les passerelles.' },
    );
    assert.equal(found.length, 1);
    assert.match(found[0] as string, /MUST 1 -> 0/);
  });

  test('a level swap is caught even though the total matches', () => {
    const found = shifts(
      { description: 'It MUST be encrypted.' },
      { description: 'Il DEVRAIT être chiffré.' },
    );
    assert.equal(found.length, 1);
    assert.match(found[0] as string, /MUST 1 -> 0/);
    assert.match(found[0] as string, /SHOULD 0 -> 1/);
  });

  test('a surplus in the target is reported too', () => {
    const found = shifts(
      { description: 'A register SHOULD list the systems and their owners.' },
      {
        description:
          'Un registre DEVRAIT recenser les systèmes. Il DEVRAIT indiquer leurs responsables.',
      },
    );
    assert.match(found[0] as string, /SHOULD 1 -> 2/);
  });

  // `String.match` on a regex without `g` returns a match object rather than a
  // list, and its `length` is 1 plus the capture-group count. So a job spelling
  // its table `/shall/i` got a fabricated shift report - every level counted 1
  // wherever the word occurred at all - and nothing said so. The two spellings
  // have to agree, which is why both are asserted against the same text.
  test('counts every match, whether or not the table carries the global flag', () => {
    const source = { description: 'It SHALL be logged. It SHALL be signed. It SHALL be kept.' };
    const translated = { description: 'Il DOIT être journalisé, signé et conservé.' };

    const withoutFlag: readonly ModalLevel[] = [
      { level: 'MUST', source: /\bshall\b/i, target: /\b(?:doit|doivent)\b/i },
    ];
    const withFlag: readonly ModalLevel[] = [
      { level: 'MUST', source: /\bshall\b/gi, target: /\b(?:doit|doivent)\b/gi },
    ];

    const expected = ['modal force differs: MUST 3 -> 1'];
    assert.deepEqual(modalForceShiftsFor(withoutFlag, ctx(source, translated)), expected);
    assert.deepEqual(modalForceShiftsFor(withFlag, ctx(source, translated)), expected);
  });

  // The same mistake in its other guise: a non-global pattern's `length` counts
  // capture groups, so this once reported 3 matches of a word occurring once.
  test('a capture group in a non-global pattern does not inflate the count', () => {
    const twoGroups: readonly ModalLevel[] = [
      { level: 'MUST', source: /\b(M)(UST)\b/, target: /\b(DOIT|DOIVENT)\b/ },
    ];
    assert.deepEqual(
      modalForceShiftsFor(
        twoGroups,
        ctx({ description: 'It MUST be encrypted.' }, { description: 'Il DOIT être chiffré.' }),
      ),
      [],
      'one match each, so there is no shift to report',
    );
  });

  test('a passthrough field cannot contribute a phantom source modal', () => {
    // `type` is never translated, so it is absent from `translated` and must be
    // excluded from the comparison rather than counted as a dropped MUST.
    assert.deepEqual(
      shifts(
        { type: 'MUST', description: 'It MUST be encrypted.' },
        { description: 'Il DOIT être chiffré.' },
      ),
      [],
    );
  });
});

describe('missingReferences', () => {
  const ctx = (source: Record<string, string | null>, translated: Record<string, string | null>) =>
    ({ identifier: 'X', source, translated }) satisfies ValidationContext;

  test('reports what the source had and the translation dropped, sorted', () => {
    const found = missingReferences(
      REF,
      ctx({ a: 'See AC-3, AC-2 and AC-1.' }, { a: 'Voir AC-2.' }),
    );
    assert.deepEqual(found, ['missing references: AC-1, AC-3']);
  });

  test('a reference that moved between fields still counts as present', () => {
    // The check is about the row, not about field alignment: a translation may
    // legitimately move a reference into a different sentence.
    assert.deepEqual(
      missingReferences(REF, ctx({ a: 'AC-1', b: null }, { a: null, b: 'AC-1' })),
      [],
    );
  });

  test('no references at all is not a finding', () => {
    assert.deepEqual(missingReferences(REF, ctx({ a: 'plain text' }, { a: 'texte simple' })), []);
  });
});
