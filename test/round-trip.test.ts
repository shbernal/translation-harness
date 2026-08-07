// The whole loop at a size where the bookkeeping can actually go wrong.
//
// Every other pipeline test uses a handful of synthetic rows, which proves the
// plumbing and nothing about a corpus. This drives real material through
// ingest -> hash -> prompt -> provider -> validate -> store and back, at a few
// hundred rows, with workers pulling on the same cursor. Offline and free: the
// mock provider launches nothing.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MOCK_PROVIDER_NAME, registerMockProvider } from '../src/contract/mock.ts';
import { hashInput } from '../src/contract/prompt.ts';
import type { SourceRecord, TranslationJob } from '../src/job.ts';
import { type RunEvent, runTranslation } from '../src/pipeline/run.ts';
import { sqliteStore } from '../src/store/sqlite.ts';
import { fieldKeys, loadCorpus } from './helpers/fixtures.ts';

registerMockProvider();

const corpus = loadCorpus();
const source = corpus.find((s) => s.meta.id === 'kubernetes-glossary') ?? corpus[0]!;
const keys = fieldKeys(source);

const job: TranslationJob = {
  id: source.meta.id,
  sourceLang: 'English',
  targetLang: 'French',
  fields: keys.map((key) => ({
    key,
    label: source.meta.fields[key] ?? key,
    translate: true,
    required: key === keys[0],
  })),
  promptTemplate: `Translate ${source.meta.title} entries.`,
  validators: [],
};

/** Every language's rows, so the corpus is a few hundred and not one file. */
function records(): SourceRecord[] {
  const out: SourceRecord[] = [];
  let rowNumber = 2;
  for (const [lang, rows] of source.byLanguage) {
    for (const row of rows) {
      const identifier = `${lang}/${row.identifier}`;
      const fields = Object.fromEntries(keys.map((k) => [k, row.fields[k] ?? null]));
      out.push({
        rowNumber: rowNumber++,
        identifier,
        source: fields,
        seedSucceeded: false,
        inputHash: hashInput(identifier, fields),
      });
    }
  }
  return out;
}

async function withStore<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-round-trip-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const options = (workDir: string) => ({
  cwd: workDir,
  workDir,
  provider: MOCK_PROVIDER_NAME,
  timeoutSeconds: 10,
  maxAttempts: 2,
  delaySeconds: 0,
});

test('a few hundred real rows settle exactly once, at concurrency 8', async () => {
  await withStore(async (dir) => {
    const all = records();
    assert.ok(all.length >= 200, `corpus is only ${all.length} rows`);

    const store = sqliteStore(join(dir, 'registry.sqlite3'), { pathBase: dir });
    const { inserted } = await store.initialize(all);
    assert.equal(inserted, all.length);

    const settled: string[] = [];
    const summary = await runTranslation(store, job, await store.selectCandidates({}), {
      ...options(dir),
      concurrency: 8,
      onEvent: (e: RunEvent) => {
        if (e.kind === 'row-settled') settled.push(e.identifier);
      },
    });

    assert.equal(summary.failed, 0);
    assert.equal(summary.succeeded + summary.review_required, all.length);
    assert.equal(settled.length, all.length, 'one settled event per row');
    assert.equal(new Set(settled).size, all.length, 'no row settled twice');

    const counts = await store.counts();
    assert.equal(counts.pending, 0);
    assert.equal(counts.running, 0, 'a stranded claim is invisible to every filter');
    assert.equal(counts.failed, 0);

    // Attempt numbering is per row, so a pool cannot make two rows share one.
    const numbers = store.db
      .prepare('SELECT row_number, COUNT(*) AS n FROM attempts GROUP BY row_number')
      .all() as { row_number: number; n: number }[];
    assert.equal(numbers.length, all.length);
    assert.ok(
      numbers.every((r) => r.n === 1),
      'a row was attempted more than once with no failure to justify it',
    );

    await store.close();
  });
});

test('resuming after an abort finishes the corpus and re-translates nothing', async () => {
  await withStore(async (dir) => {
    const all = records();
    const store = sqliteStore(join(dir, 'registry.sqlite3'), { pathBase: dir });
    await store.initialize(all);

    // Abort once a quarter of the corpus has landed: enough that the pool is
    // genuinely mid-flight rather than testing an abort before it started.
    const controller = new AbortController();
    let done = 0;
    const first = await runTranslation(store, job, await store.selectCandidates({}), {
      ...options(dir),
      concurrency: 4,
      signal: controller.signal,
      onEvent: (e: RunEvent) => {
        if (e.kind === 'row-settled' && ++done >= Math.floor(all.length / 4)) controller.abort();
      },
    });

    const mid = await store.counts();
    assert.equal(mid.running, 0, 'the abort left rows claimed');
    assert.ok(mid.pending > 0, 'the abort did not actually stop the run');
    assert.equal(mid.pending + mid.succeeded + mid.review_required, all.length);

    const answered = mid.succeeded + mid.review_required;
    assert.equal(first.succeeded + first.review_required, answered);

    const resumed = await runTranslation(store, job, await store.selectCandidates({}), {
      ...options(dir),
      concurrency: 4,
    });
    assert.equal(resumed.succeeded + resumed.review_required, mid.pending, 'resume took the rest');

    const end = await store.counts();
    assert.equal(end.pending, 0);
    assert.equal(end.running, 0);
    assert.equal(end.succeeded + end.review_required, all.length);

    // One attempt per row across both runs: a resumed corpus that re-attempted
    // work it had already paid for would look identical in the status counts.
    const attempts = (store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number })
      .n;
    assert.equal(attempts, all.length);

    await store.close();
  });
});

test('every stored row round-trips its source and its answer', async () => {
  await withStore(async (dir) => {
    const all = records();
    const store = sqliteStore(join(dir, 'registry.sqlite3'), { pathBase: dir });
    await store.initialize(all);
    await runTranslation(store, job, await store.selectCandidates({}), {
      ...options(dir),
      concurrency: 4,
    });

    const stored = await store.selectCandidates({ redo: true });
    assert.equal(stored.length, all.length);
    const byIdentifier = new Map(all.map((r) => [r.identifier, r]));

    for (const item of stored) {
      const original = byIdentifier.get(item.identifier);
      assert.ok(original, `${item.identifier} is not a row we wrote`);
      // Unicode survival: accented Latin, sharp s, inverted marks, narrow
      // spaces and typographic apostrophes all the way through the JSON
      // columns and back.
      assert.deepEqual(item.source, original.source, `${item.identifier} source drifted`);
      assert.equal(item.inputHash, original.inputHash);
      assert.ok(item.target, `${item.identifier} has no answer`);
      const answer = item.target;
      for (const key of keys) {
        const from = original.source[key];
        const to = answer[key];
        if (from === null || from === undefined)
          assert.equal(to, null, `${item.identifier}.${key}`);
        else assert.ok(typeof to === 'string' && to.includes(from), `${item.identifier}.${key}`);
      }
    }

    await store.close();
  });
});
