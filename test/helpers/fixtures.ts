// Reading the committed fixture corpus.
//
// Everything here discovers rather than declares. A test that hard-coded which
// sources exist, or which language pairs they carry, would have to be edited
// every time somebody contributes material - and the whole point of the corpus
// is that adding a source is a data change.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fields } from '../../src/job.ts';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'corpus');

export interface FixtureMeta {
  readonly id: string;
  readonly title: string;
  readonly upstream: string;
  readonly commit: string;
  readonly license: string;
  readonly attribution: string;
  readonly register: string;
  readonly alignment: string;
  /** Field key -> what it holds, for a human reading the fixture. */
  readonly fields: Readonly<Record<string, string>>;
  /** Language code -> row count, as committed. */
  readonly languages: Readonly<Record<string, number>>;
  /** File name -> sha256 of its bytes. The drift guard checks these. */
  readonly files: Readonly<Record<string, string>>;
}

export interface FixtureRow {
  readonly identifier: string;
  readonly fields: Fields;
}

export interface FixtureSource {
  readonly dir: string;
  readonly meta: FixtureMeta;
  /** Language code -> its rows, in file order. */
  readonly byLanguage: ReadonlyMap<string, readonly FixtureRow[]>;
}

function readJsonl(path: string): FixtureRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FixtureRow);
}

/** Every committed source, in directory order. */
export function loadCorpus(): FixtureSource[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(CORPUS, e.name);
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
      const byLanguage = new Map<string, readonly FixtureRow[]>();
      for (const lang of Object.keys(meta.languages)) {
        byLanguage.set(lang, readJsonl(join(dir, `${lang}.jsonl`)));
      }
      return { dir, meta, byLanguage };
    });
}

/** One row present in both languages of a pair. */
export interface AlignedRow {
  readonly identifier: string;
  readonly source: Fields;
  readonly target: Fields;
}

/**
 * An ordered language pair within one source, and the rows both sides carry.
 *
 * Ordered, because the length ratio is directional: English into German is not
 * the measurement German into English is.
 */
export interface Pair {
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
  readonly rows: readonly AlignedRow[];
}

/**
 * Every ordered pair the corpus actually contains, with at least `minRows`
 * aligned rows.
 *
 * The floor is there because a pair of four rows produces a ratio
 * "distribution" that is really four numbers, and asserting a rate over it
 * would be noise wearing a percentage sign.
 */
export function pairs(sources: readonly FixtureSource[], minRows = 10): Pair[] {
  const out: Pair[] = [];
  for (const source of sources) {
    const langs = [...source.byLanguage.keys()];
    for (const from of langs) {
      for (const to of langs) {
        if (from === to) continue;
        const target = new Map(source.byLanguage.get(to)!.map((r) => [r.identifier, r]));
        const rows: AlignedRow[] = [];
        for (const row of source.byLanguage.get(from)!) {
          const other = target.get(row.identifier);
          if (other)
            rows.push({ identifier: row.identifier, source: row.fields, target: other.fields });
        }
        if (rows.length >= minRows) out.push({ sourceId: source.meta.id, from, to, rows });
      }
    }
  }
  return out;
}

/**
 * A pair's rows as the two strings `genericReviewReasons` compares: every
 * field joined in key order, which is what the runner does with a real row.
 */
export function concatenated(row: AlignedRow, keys: readonly string[]): [string, string] {
  return [
    keys.map((k) => row.source[k] ?? '').join('\n'),
    keys.map((k) => row.target[k] ?? '').join('\n'),
  ];
}

/** The field keys a source's rows carry, in `meta.json` order. */
export function fieldKeys(source: FixtureSource): string[] {
  return Object.keys(source.meta.fields);
}
