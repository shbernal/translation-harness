# translation-harness

Run a large translation job as a batch of non-interactive coding-agent CLI calls
(Codex, Claude), one subprocess per row, against a uniform JSON contract. It
gives you the machinery that makes ten thousand such calls survivable: a
resumable per-row registry, a worker pool that pauses on quota and retries on
transient failure, structural and generic guardrails on every response, and
per-attempt evidence you can go back to.

It does not translate, and it does not know where your rows come from. You bring
the corpus, the prompt, the language pair and the validators. The harness is the
part that is the same whatever you are translating.

**Status: pre-release.** The API is not stable and nothing is published yet.

## Requirements

- **Node >= 24.** Not a preference. The shipped store is built on the built-in
  `node:sqlite`, which does not exist before 24. It emits no experimental
  warning on 24.16.0, checked on stderr and through the warning event.
- **Node 24 typings to compile, not only to run.** `applySchema` and
  `SqliteStore` name `DatabaseSync` in the published declarations, so a consumer
  on older `@types/node` cannot typecheck against this package even if they
  never touch the SQLite store.
- **A `codex` or `claude` CLI on `PATH`,** for real runs. The offline provider
  needs neither.

## Try it without any of that

```bash
node examples/minimal/run.ts
```

Twenty rows, no API key, no CLI, no network, about a second. Run it again and it
translates nothing, because every row is already settled in the registry, which
is the whole point of the library. The full source is
[`examples/minimal/run.ts`](examples/minimal/run.ts); here is the shape of it:

```ts
import {
  hashInput, registerMockProvider, runTranslation, sqliteStore,
  type StoreRecord, type TranslationJob,
} from 'translation-harness';

const job: TranslationJob = {
  id: 'controls',
  sourceLang: 'English',
  targetLang: 'French',
  fields: [
    { key: 'title', label: 'Control title', translate: true, required: true },
    { key: 'family', label: 'Control family', translate: false, required: false },
    { key: 'statement', label: 'Control statement', translate: true, required: false },
  ],
  promptTemplate: 'Keep bracketed placeholders exactly as they appear. ...',
  validators: [],
};

// Your rows, from wherever you keep them.
const records: StoreRecord[] = myRows.map((row, i) => ({
  rowNumber: i + 1,
  identifier: row.id,
  source: row.fields,
  seedSucceeded: false,
  inputHash: hashInput(row.id, row.fields),
}));

registerMockProvider();                       // or leave it out and use 'codex'
const store = sqliteStore('./registry.sqlite3');
await store.initialize(records);

const summary = await runTranslation(store, job, await store.selectCandidates({}), {
  cwd: process.cwd(),
  workDir: './work',
  provider: 'mock',                           // 'codex' | 'claude' | your own
  timeoutSeconds: 300,
  maxAttempts: 3,
  delaySeconds: 0,
  concurrency: 4,
  onEvent: (e) => console.log(e),
});
```

Switching to a real agent is one line: `provider: 'codex'`, plus a `model`.

## What you get that a for-loop over `spawn` does not

Every item here exists because a simpler version of it failed in production.

- **The Windows launcher shim.** An npm-installed CLI on Windows is a `.cmd`
  file, which `spawn` cannot execute, so the call goes through
  `%COMSPEC% /d /c <name>.cmd`. The `/d` matters: without it every attempt
  inherits whatever AutoRun commands the machine's registry has configured.
- **Tree kill on timeout.** Killing the shim leaves the agent it launched
  running, and a stranded agent holds its quota slot and keeps writing. The
  whole process tree goes at once, synchronously, because the next row spawns
  immediately and the tree has to be gone before that, not eventually.
- **Categorized failures.** A timeout and a failed launch are different things:
  one means the agent ran and was too slow, the other means it never started,
  and collapsing them hides a broken installation behind a plausible slow row.
- **Quota pauses the batch.** One row pays for the discovery and the rest are
  left untouched. Retrying a quota refusal buys the same refusal at the same
  price, once per row, until the allowance is gone.
- **A 32 MiB output cap.** There is no async equivalent of `spawnSync`'s
  `maxBuffer`, so it is enforced by hand. Without it a provider stuck in a loop
  is an out-of-memory crash of the whole batch rather than one failed row.
- **Per-row transactions and real resume.** Every row settles on its own, so an
  interrupted run resumes exactly where it stopped and no path out of a run
  leaves a row stranded and invisible.
- **Atomic claiming across processes.** The claim and the test are one
  statement, so two workers, or two processes against the same registry, cannot
  both come away believing they own a row and silently overwrite each other.
- **Retained evidence.** Every attempt keeps its stdout, its stderr and the raw
  response, and the registry records where. When a row comes out wrong in three
  months, the thing that produced it is still on disk.
- **Measured Codex context trims.** The default configuration strips context a
  single-shot translation can never use: **29,382 input tokens down to 14,586, a
  50% cut**, measured one flag at a time, with the output unchanged in substance
  and still schema-valid. The largest single entry is the agent instructions
  discovered from the working directory, which nothing else turns off.

## The guardrail model

Two kinds of problem, handled differently on purpose.

**Structural problems are failures.** Wrong shape, a returned identifier that
does not match, a blank source field answered with text, an empty translation
where the source had content. These raise, the attempt is recorded as failed,
and the row retries with bounded exponential backoff.

**Content concerns downgrade the row, they never fail it and are never silently
accepted.** A dropped bracket, a suspicious length ratio, output identical to
the input, a model warning, or anything your own validators return. The row is
stored as `review_required` with the reasons attached, so it is usable and
flagged rather than thrown away or waved through.

The generic length-ratio bounds ship as **0.45 to 2.25**, and you should know
exactly what that number is. It was *chosen* on one language pair over one
corpus of long-form technical prose, and it has since been *measured* against
committed, human-translated fixtures: 40 ordered pairs across English, French,
Spanish, Italian and German, in two registers. Between 0% and 5.6% of rows per
pair are sent to review, and on that material the flagged rows are dominated by
translations that dropped a section their source had - which is what the check
is for. `test/calibration.test.ts` is the measurement, and it fails when a pair
crosses the bound.

**Pairs the fixtures do not contain are unmeasured, not blessed.** Nothing here
says anything about English into Japanese. And the ratio is over the
concatenated fields, so a job whose rows are single words can still move a long
way for a small absolute change. Override it per job:

```ts
thresholds: { minLengthRatio: 0.2, maxLengthRatio: 4 }
```

## What it deliberately does not do

No ingestion, no export, no rendering, no opinion about your source format. It
will not read your spreadsheet, will not write your deliverable, and does not
know what a column is. The linguistic review lifecycle, terminology and glossary
management, and language-specific typography are all out of scope for now, with
hooks (`job.normalize`, `job.promptExtras`, `job.promptSalt`) where they attach.

## Implementing your own store

`TranslationStore` is an interface with one shipped implementation. If your
state lives somewhere other than a local SQLite file, implement the interface
rather than forking the runner, and check yourself against the exported
conformance suite:

```ts
import { storeConformance } from 'translation-harness';

for (const { name, run } of storeConformance(async () => myStore()))
  test(name, run);
```

It is exported for a reason: `tryClaim` is easy to get subtly wrong, and the
symptom is rows translated twice under load with nothing anywhere to tell you.
The six contract terms are on the `TranslationStore` doc comment and in
[docs/architecture.md](docs/architecture.md).

## License

The code is MIT. See [LICENSE](LICENSE).

The material under `test/fixtures/` is **not** covered by it: those are
third-party works redistributed under their own terms, each with its own license
text and attribution beside it. See
[`test/fixtures/README.md`](test/fixtures/README.md) before reusing any of it.

## Contributions, especially fixtures

The guardrail thresholds above are a claim about how translated text behaves,
and right now that claim rests on the language pairs the maintainer can read:
Spanish, French, Italian, English and German. That is not a judgement about
which languages matter. It is the honest limit of what one person can verify,
and a fixture nobody can check is worse than no fixture.

So the contributions that help most are the ones that lift that limit:

- **A parallel fixture with provenance** in any language pair. Aligned source
  and translation, a license that permits redistribution, and a note saying
  where it came from. The calibration test discovers its pairs from the corpus,
  so adding one is a data change and not a test change.
- **A correction to a ratio bound that is wrong for a pair nobody measured.**
  If German to Finnish routinely trips the upper bound, that is a finding, and
  the number should move.
- **A validator for a language's conventions** that the generic checks cannot
  express.

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[`test/fixtures/README.md`](test/fixtures/README.md) for what a fixture must
carry.
