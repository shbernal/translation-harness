// The fixtures are a measurement, so their bytes are the instrument.
//
// Nothing else in the suite would notice a fixture being reformatted, an
// autofix reaching into it, or a well-meant typo correction in upstream
// material. The calibration would just quietly start measuring something else
// and still pass, which is the failure mode worth a test of its own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fieldKeys, loadCorpus, pairs } from './helpers/fixtures.ts';

const corpus = loadCorpus();

test('the corpus is not empty', () => {
  assert.ok(corpus.length > 0, 'no fixture sources found');
});

for (const source of corpus) {
  const id = source.meta.id;

  test(`${id}: every file matches the SHA-256 recorded in meta.json`, () => {
    const recorded = Object.entries(source.meta.files);
    assert.ok(recorded.length > 0, 'meta.json records no files');
    for (const [name, want] of recorded) {
      const got = createHash('sha256')
        .update(readFileSync(join(source.dir, name)))
        .digest('hex');
      assert.equal(got, want, `${name} has changed since it was committed`);
    }
  });

  test(`${id}: meta.json accounts for every data file on disk`, () => {
    // The mirror of the check above: a hash list only proves what it lists, so
    // an added file with no hash would be unguarded material.
    const onDisk = readdirSync(source.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    assert.deepEqual(onDisk, Object.keys(source.meta.files).sort());
  });

  test(`${id}: carries its upstream license and attribution`, () => {
    // MIT covers this repository's code and nothing in here. A fixture whose
    // license text is missing is a redistribution nobody can check.
    const license = readFileSync(join(source.dir, 'LICENSE'), 'utf8');
    assert.ok(license.trim().length > 200, 'LICENSE looks truncated');
    assert.ok(source.meta.license.length > 0, 'meta.json names no license');
    assert.ok(
      source.meta.attribution.includes(source.meta.upstream),
      'attribution has no upstream link',
    );
    assert.match(source.meta.commit, /^[0-9a-f]{40}$/, 'provenance needs an exact commit');
  });

  test(`${id}: row counts match meta.json, and identifiers are unique`, () => {
    for (const [lang, expected] of Object.entries(source.meta.languages)) {
      const rows = source.byLanguage.get(lang);
      assert.ok(rows, `no rows loaded for ${lang}`);
      assert.equal(rows.length, expected, `${lang} row count`);
      assert.equal(new Set(rows.map((r) => r.identifier)).size, rows.length, `${lang} identifiers`);
    }
  });

  test(`${id}: every row carries the fields meta.json describes, and no others`, () => {
    const keys = new Set(fieldKeys(source));
    for (const [lang, rows] of source.byLanguage) {
      for (const row of rows) {
        for (const key of Object.keys(row.fields)) {
          assert.ok(keys.has(key), `${lang}/${row.identifier}: undescribed field '${key}'`);
        }
        const filled = Object.values(row.fields).filter((v) => v !== null && v !== '');
        assert.ok(filled.length > 0, `${lang}/${row.identifier}: every field is blank`);
      }
    }
  });

  test(`${id}: every row is part of at least one pair`, () => {
    // A row only one language carries cannot calibrate anything and is only
    // weight in a clone. This is the property the material was selected for,
    // so it is worth asserting rather than assuming.
    const counts = new Map<string, number>();
    for (const rows of source.byLanguage.values()) {
      for (const row of rows) counts.set(row.identifier, (counts.get(row.identifier) ?? 0) + 1);
    }
    const orphans = [...counts].filter(([, n]) => n < 2).map(([id_]) => id_);
    assert.deepEqual(orphans, [], 'identifiers present in only one language');
  });
}

test('the corpus yields pairs in both directions', () => {
  // The length ratio is directional, so a corpus that only ever produced
  // en -> x would leave half of what the guardrail does unmeasured.
  const found = pairs(corpus);
  assert.ok(found.length >= 4, `only ${found.length} usable pairs`);
  const directions = new Set(found.map((p) => `${p.from}->${p.to}`));
  const reversed = [...directions].filter((d) => {
    const [a, b] = d.split('->');
    return directions.has(`${b}->${a}`);
  });
  assert.ok(reversed.length > 0, 'no pair is measured in both directions');
});
