// The review lifecycle at a prompt: open a run, resume it, decide it. Offline,
// free, and in about a second.
//
//   node examples/review/cli.ts translate           # fill a registry, with the mock
//   node examples/review/cli.ts init                # open the review run
//   node examples/review/cli.ts init                # the same id, created: false
//   node examples/review/cli.ts review --limit 3    # one pass over three rows
//   node examples/review/cli.ts review              # resume the rest
//   node examples/review/cli.ts status
//   node examples/review/cli.ts decide AC-2 statement proposal
//   node examples/review/cli.ts resolve
//
// **This is an example, not an interface.** The package ships no binary, and
// none of these flags are API. They exist because two properties of a review run
// are only convincing at a prompt and a code sample cannot show either:
//
//   * **Init is idempotent, because a run id is derived rather than generated.**
//     Run `init` twice and the second call reports the same id and
//     `created: false`. Change any input - `--profile`, `--mono`, a line of the
//     terminology, one character of one row - and you get a different run rather
//     than a polluted one. `init --dry-run` tells you the id without opening
//     anything, so you can check that before committing to it.
//   * **A run is a job; a pass is one execution of it.** `review --limit 3`
//     settles three rows and leaves the run `running`, because work remains.
//     `review` again picks up the rest. Ctrl-c in between loses nothing: rows in
//     flight finish, and the ones a dead pass was holding come back without
//     waiting on a clock.
//
// One consequence is worth noticing while you use it: **this CLI stores nothing
// about which run is current.** Every verb re-derives the id from the flags it
// was handed, which is what a derived id buys - `status --mono` addresses the
// monolingual run without anything on disk having to remember it exists. Pass
// `--run <id>` to address a run whose id came from somewhere else.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  deriveReviewRun,
  type Fields,
  initializeReview,
  type ModelProfile,
  parseFields,
  REVIEW_DECISION_KINDS,
  REVIEW_MOCK_PROVIDER_NAME,
  type ReviewDecision,
  type ReviewDecisionKind,
  type ReviewDecisions,
  type ReviewEvent,
  type ReviewJob,
  type ReviewSourceRow,
  type RunEvent,
  registerMockProvider,
  registerReviewMockProvider,
  resolveDecisions,
  resolveProfile,
  resolveRunOutput,
  runReview,
  runTranslation,
  type SqliteStore,
  type Status,
  sqliteStore,
} from '../../src/index.ts';
import { records, reviewJobFor, translationJob } from './corpus.ts';

const WORK_DIR = join(tmpdir(), 'translation-harness-review-example');
const REGISTRY = join(WORK_DIR, 'registry.sqlite3');
/**
 * Where `decide` writes and `resolve` reads.
 *
 * Input, not state. It stands in for the thing a real host has - a workbook a
 * reviewer filled in, a form somebody submitted - and it is keyed by run id for
 * the same reason that thing would be: a decision is about the text one run
 * showed a person, and carrying it to a different run would be applying an
 * answer to a question nobody asked.
 */
const DECISIONS = join(WORK_DIR, 'decisions.json');

/**
 * This host's own profile table.
 *
 * `resolveProfile` takes one as an argument rather than reading the shipped
 * `DEFAULT_PROFILES`, because model ids age faster than releases do. Both of
 * these bind the offline reviewer, so `--profile` demonstrates what a profile
 * does to a run id without needing a model to be reachable.
 */
const PROFILES: Record<string, ModelProfile> = {
  offline: { provider: REVIEW_MOCK_PROVIDER_NAME, model: 'tidy-1', reasoningEffort: null },
  'offline-careful': {
    provider: REVIEW_MOCK_PROVIDER_NAME,
    model: 'tidy-1',
    reasoningEffort: 'high',
  },
};

const USAGE = `Usage: node examples/review/cli.ts <verb> [flags]

  translate                       Translate the corpus with the offline provider.
  init                            Open the review run these flags name.
  review                          Run one pass over it.
  status                          What the run says about itself, row by row.
  decide <id> <field> <kind> [text]
                                  Record one decision: keep | proposal | custom.
  resolve                         Apply the decisions and print the final text.
  reset                           Delete ${WORK_DIR}.

Flags:
  --profile <name>                ${Object.keys(PROFILES).join(' | ')}. Part of the run id.
  --mono                          Withhold the source: a coherence pass, not a fidelity one.
  --base <runId>                  Review a completed run's output instead of the corpus.
  --run <runId>                   Address a run by id rather than by deriving it.
  --limit <n>                     Attempt at most n rows this pass.
  --dry-run                       On init: derive the id and write nothing.
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    mono: { type: 'boolean' },
    base: { type: 'string' },
    run: { type: 'string' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

// A library must not install a process-wide signal handler, so wiring one is the
// host's. These two lines are the whole of it: rows in flight still finish,
// because they are work already paid for.
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

function open(): SqliteStore {
  mkdirSync(WORK_DIR, { recursive: true });
  return sqliteStore(REGISTRY, { pathBase: WORK_DIR });
}

/**
 * The corpus, as `initializeReview` wants it.
 *
 * Producing this is the host's job, and this is the whole of it: init takes the
 * corpus as data rather than reading a store, so that a filtered corpus is a
 * different run id rather than a run with a hole in it. This host keeps its
 * corpus in the registry, so it comes back out of `items` through the `db`
 * handle the concrete store exposes. A host whose corpus lives in a spreadsheet
 * builds the same six values from there and is no worse off.
 */
function corpusRows(store: SqliteStore): ReviewSourceRow[] {
  const rows = store.db
    .prepare(
      `SELECT row_number, identifier, input_hash, source_json, target_json, status
         FROM items ORDER BY row_number`,
    )
    .all() as unknown as {
    row_number: number;
    identifier: string;
    input_hash: string;
    source_json: string;
    target_json: string | null;
    status: string;
  }[];
  return rows.map((row) => ({
    rowNumber: row.row_number,
    identifier: row.identifier,
    inputHash: row.input_hash,
    source: parseFields(row.source_json),
    // Null rather than `{}`: a row with no answer and a row with an empty one
    // hash differently, and conflating them would move the run id.
    target: row.target_json === null ? null : parseFields(row.target_json),
    status: row.status as Status,
  }));
}

/** What the flags describe, before anything is opened. */
function planned(): {
  job: ReviewJob;
  profileName: string | null;
  profile: ModelProfile | null;
  baseRunId: string | null;
} {
  const { name, profile } = resolveProfile(flags.profile, PROFILES);
  return {
    job: reviewJobFor(!flags.mono),
    profileName: name,
    profile,
    baseRunId: flags.base ?? null,
  };
}

/**
 * A chained run's corpus: the base run's resolved output as this run's target.
 *
 * `initializeReview` does this itself, so it is only needed on the paths that
 * derive an id without opening a run. `resolveRunOutput` is what "the output of
 * run 1" means - a computation over its snapshot, never a read of the live
 * corpus - and it ships precisely so the chained run and anything rendering it
 * cannot disagree.
 */
async function chained(
  store: SqliteStore,
  baseRunId: string,
  corpus: readonly ReviewSourceRow[],
): Promise<ReviewSourceRow[]> {
  const output = resolveRunOutput(await store.review(baseRunId).snapshot());
  return corpus.map((row) => ({ ...row, target: output.get(row.rowNumber) ?? row.target }));
}

/**
 * Which run these flags name.
 *
 * Derived, never remembered. `deriveReviewRun` is init with the writing taken
 * out, and it exists for exactly this question: what id would these inputs
 * produce, asked before opening a file.
 */
async function runIdFor(store: SqliteStore, corpus: readonly ReviewSourceRow[]): Promise<string> {
  if (flags.run) return flags.run;
  const { job, profileName, baseRunId } = planned();
  return deriveReviewRun({
    job,
    corpus: baseRunId ? await chained(store, baseRunId, corpus) : corpus,
    profile: profileName,
    baseRunId,
  }).runId;
}

function printRow(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(14)}${value}`);
}

function printInputs(inputs: Readonly<Record<string, string>>): void {
  console.log('  the id was derived from');
  for (const [name, hash] of Object.entries(inputs))
    console.log(`    ${name.padEnd(16)}${hash.slice(0, 16)}`);
}

function onTranslationEvent(event: RunEvent): void {
  if (event.kind !== 'row-settled') return;
  const how = event.precomputed ? 'precomputed' : `${event.durationSeconds.toFixed(1)}s`;
  console.log(
    `  [${event.completed}/${event.total}] ${event.identifier}: ${event.outcome} (${how})`,
  );
}

function onReviewEvent(event: ReviewEvent): void {
  switch (event.kind) {
    case 'row-settled':
      console.log(`  [${event.completed}/${event.total}] ${event.identifier}: ${event.outcome}`);
      break;
    case 'row-retrying':
      console.log(`  ${event.identifier}: ${event.category}; retrying`);
      break;
    case 'quota-paused':
      console.log(`  ${event.identifier}: quota reached; pausing the pass`);
      break;
    case 'rows-released':
      console.log(`  released ${event.count} claimed rows`);
      break;
  }
}

async function translate(store: SqliteStore): Promise<void> {
  // Opt-in by name. Nothing that fabricates plausible-looking translations
  // should be one typo away from a real run.
  registerMockProvider();
  const sync = await store.initialize(records);
  console.log(`${sync.inserted} rows inserted, ${sync.reset} reset`);

  const candidates = await store.selectCandidates({});
  if (!candidates.length) {
    console.log('Nothing to translate: every row is already settled.');
  } else {
    const summary = await runTranslation(store, translationJob, candidates, {
      cwd: process.cwd(),
      workDir: WORK_DIR,
      provider: 'mock',
      timeoutSeconds: 300,
      maxAttempts: 3,
      delaySeconds: 0,
      concurrency: 4,
      signal: controller.signal,
      onEvent: onTranslationEvent,
    });
    console.log(
      `${summary.succeeded} succeeded, ${summary.review_required} need review, ` +
        `${summary.failed} failed`,
    );
  }
  console.log(`Registry: ${JSON.stringify(await store.counts())}`);
}

async function init(store: SqliteStore): Promise<void> {
  const { job, profileName, profile, baseRunId } = planned();
  const corpus = corpusRows(store);
  if (!corpus.length) throw new Error(`No corpus in ${REGISTRY}. Run 'translate' first.`);

  if (flags['dry-run']) {
    const derived = deriveReviewRun({
      job,
      corpus: baseRunId ? await chained(store, baseRunId, corpus) : corpus,
      profile: profileName,
      baseRunId,
    });
    console.log(`These inputs open ${derived.runId}`);
    printRow('rows', `${derived.items.length} (${derived.settledCount} settled by construction)`);
    printInputs(derived.inputs);
    console.log('Nothing was written.');
    return;
  }

  // The corpus goes in unresolved. Init resolves the chain itself, and handing
  // it rows already resolved would derive the id off a snapshot twice-applied.
  const result = await initializeReview(store.review, {
    job,
    corpus,
    profile: profileName,
    provider: profile?.provider,
    model: profile?.model,
    reasoningEffort: profile?.reasoningEffort,
    baseRunId,
  });

  console.log(`Review run ${result.runId}`);
  printRow('created', result.created);
  printRow('status', result.status);
  printRow('rows', `${result.itemCount} (${result.settledCount} settled by construction)`);
  printRow('showSource', result.showSource);
  printRow('profile', result.profile ?? '(none)');
  printRow(
    'binding',
    result.provider ? `${result.provider} ${result.model ?? ''}`.trim() : '(none)',
  );
  if (result.baseRunId) printRow('chained onto', result.baseRunId);
  printRow('snapshot', result.snapshotHash.slice(0, 16));
  printInputs(result.inputs);

  if (!result.created)
    console.log(
      'This run already existed. Same inputs, same id, nothing rebuilt and nothing re-reviewed.',
    );
}

async function review(store: SqliteStore): Promise<void> {
  registerReviewMockProvider();
  const { job } = planned();
  const runId = await runIdFor(store, corpusRows(store));
  const run = store.review(runId);
  if (!(await run.run()))
    throw new Error(`No review run ${runId}. Open it with 'init' and the same flags first.`);

  // A pass that died holds no rows once it has ended, so a resume gets them back
  // at once rather than waiting out `reclaimStale`'s cutoff. Safe on every pass:
  // the run outlives the pass, and only a *finished* pass's claims are released.
  const released = await run.releaseSettledRunClaims();
  if (released) console.log(`Released ${released} rows held by a pass that has ended`);

  const candidates = await run.selectCandidates({
    limit: flags.limit ? Number(flags.limit) : null,
  });
  if (!candidates.length) {
    console.log('Nothing to review: every row of this run has an answer.');
    return;
  }

  const summary = await runReview(run, job, candidates, {
    cwd: process.cwd(),
    workDir: WORK_DIR,
    provider: REVIEW_MOCK_PROVIDER_NAME,
    timeoutSeconds: 300,
    maxAttempts: 3,
    delaySeconds: 0,
    concurrency: 4,
    signal: controller.signal,
    onEvent: onReviewEvent,
  });
  console.log(
    `${summary.pass} pass, ${summary.change_proposed} change proposed, ${summary.failed} failed`,
  );

  const after = await run.run();
  console.log(`Run ${runId} is ${after?.status}`);
  if (after?.status === 'running')
    console.log("Rows remain, and nobody stopped anything. Run 'review' again to take the rest.");
}

async function status(store: SqliteStore): Promise<void> {
  const runId = await runIdFor(store, corpusRows(store));
  const run = store.review(runId);
  const record = await run.run();
  if (!record) throw new Error(`No review run ${runId}. Open it with 'init' first.`);

  console.log(`Review run ${runId}`);
  printRow('status', record.status);
  printRow('created', record.createdAt);
  printRow('profile', record.profile ?? '(none)');
  printRow(
    'binding',
    record.provider ? `${record.provider} ${record.model ?? ''}`.trim() : '(none)',
  );
  if (record.baseRunId) printRow('chained onto', record.baseRunId);
  printInputs(record.inputs);
  printRow('counts', JSON.stringify(await run.counts()));

  console.log('');
  for (const item of await run.snapshot()) {
    const graded = item.severity ? ` ${item.severity}/${item.confidence}` : '';
    console.log(`${item.outcome.padEnd(16)}${item.identifier}${graded}`);
    for (const [field, proposal] of Object.entries(item.proposals ?? {})) {
      if (proposal == null) continue;
      console.log(`    ${field}`);
      console.log(`      now      ${JSON.stringify(item.target[field] ?? null)}`);
      console.log(`      proposed ${JSON.stringify(proposal)}`);
    }
  }
}

type DecisionFile = Record<string, Record<string, Record<string, ReviewDecision>>>;

function readDecisionFile(): DecisionFile {
  try {
    return JSON.parse(readFileSync(DECISIONS, 'utf8')) as DecisionFile;
  } catch {
    return {};
  }
}

async function decide(store: SqliteStore, args: readonly string[]): Promise<void> {
  const [identifier, field, kind, ...rewrite] = args;
  if (!identifier || !field || !kind)
    throw new Error('Usage: decide <identifier> <field> <keep|proposal|custom> [rewrite]');
  if (!(REVIEW_DECISION_KINDS as readonly string[]).includes(kind))
    throw new Error(`Unknown decision '${kind}'. One of: ${REVIEW_DECISION_KINDS.join(', ')}`);

  const runId = await runIdFor(store, corpusRows(store));
  const file = readDecisionFile();
  const forRun = file[runId] ?? {};
  const forRow = forRun[identifier] ?? {};
  forRow[field] = { kind: kind as ReviewDecisionKind, custom: rewrite.join(' ') || null };
  forRun[identifier] = forRow;
  file[runId] = forRun;
  writeFileSync(DECISIONS, JSON.stringify(file, null, 2), 'utf8');
  console.log(`${identifier} ${field}: ${kind}`);
}

async function resolve(store: SqliteStore): Promise<void> {
  const runId = await runIdFor(store, corpusRows(store));
  const run = store.review(runId);
  const snapshot = await run.snapshot();
  if (!snapshot.length) throw new Error(`No review run ${runId}. Open it with 'init' first.`);

  const decisions: ReviewDecisions = new Map(Object.entries(readDecisionFile()[runId] ?? {}));
  const { resolved, counts, warnings } = resolveDecisions(snapshot, decisions);

  console.log(`Decisions written down: ${JSON.stringify(counts)}`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);

  let changed = 0;
  for (const item of snapshot) {
    const final = resolved.get(item.rowNumber) as Fields;
    for (const [field, value] of Object.entries(final)) {
      if (value === item.target[field]) continue;
      changed += 1;
      console.log(`${item.identifier} ${field}`);
      console.log(`  was ${JSON.stringify(item.target[field] ?? null)}`);
      console.log(`  now ${JSON.stringify(value)}`);
    }
  }
  console.log(`${changed} field(s) differ from what was reviewed, out of ${snapshot.length} rows.`);
  console.log(
    'Nothing was written to the corpus. A review run only ever proposes; publishing what ' +
      "came back is the host's, and it is the step a person signs off.",
  );
}

async function main(): Promise<void> {
  const [verb, ...args] = positionals;

  if (!verb || verb === 'help') {
    console.log(USAGE);
    return;
  }
  if (verb === 'reset') {
    rmSync(WORK_DIR, { recursive: true, force: true });
    console.log(`Removed ${WORK_DIR}`);
    return;
  }

  const store = open();
  try {
    switch (verb) {
      case 'translate':
        await translate(store);
        break;
      case 'init':
        await init(store);
        break;
      case 'review':
        await review(store);
        break;
      case 'status':
        await status(store);
        break;
      case 'decide':
        await decide(store, args);
        break;
      case 'resolve':
        await resolve(store);
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`${(error as Error).message}`);
  process.exitCode = 1;
}
