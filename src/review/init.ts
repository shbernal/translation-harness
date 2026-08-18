// Opening a review run: the snapshot, the hashes it is made of, and the id
// derived from all of them.
//
// **A review run id is not generated, it is derived.** Every input that could
// change what the reviewer is asked - the profile, the guidance, the response
// schema, the terminology, the consistency analysis, every row of the corpus,
// whether the source is shown, and any base run being chained onto - goes into
// one sha, truncated to 32 hex characters. Two consequences follow, and the
// whole design of this file is in service of them:
//
//   * **Init is idempotent.** Run it twice on unchanged inputs and the second
//     call finds the first run and reports `created: false`. Nothing is rebuilt
//     and nothing is re-reviewed.
//   * **A changed input is a different run, never a polluted one.** Edit the
//     guidance, swap the profile, fix one row of the corpus, and you have
//     provably got a new run id. There is no state in which a run's answers were
//     produced under rules the run does not record.
//
// The corpus arrives as data rather than as a store to read. That is the same
// choice `TranslationStore.initialize` makes with `SourceRecord`, and here it
// buys something extra: a host cannot hide a row from init, because the
// snapshot hash covers every row it was given. A filtered corpus is a different
// run id, which is a different run - not a run with a hole in it.

import { createHash } from 'node:crypto';
import { canonicalFields, type Fields, type TranslationJob } from '../job.ts';
import type {
  ReviewItemRecord,
  ReviewRunStatus,
  ReviewStore,
  StoredReviewRun,
} from '../store/review-types.ts';
import type { Status } from '../store/types.ts';
import { resolveRunOutput } from './chain.ts';
import { buildConsistency, type ConsistencyAnalysis, recordedEvidence } from './consistency.ts';
import { extraInputsDigest } from './inputs.ts';
import type { ReviewJob } from './job.ts';
import { buildReviewSchema } from './schema.ts';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Opens a `ReviewStore` scoped to one review run.
 *
 * Init cannot be handed a store, because the run id it would be scoped to is
 * the thing init computes. So it is handed the function that opens one, and
 * `sqliteStore(path).review` is exactly that function - it closes over its own
 * state rather than using `this`, so passing it detached is safe.
 *
 * The same function is how init reaches a *base* run when chaining, which is
 * the other reason it is a provider and not an argument: two runs in one file,
 * opened by run id, with no host wiring in between.
 */
export type ReviewStoreProvider = (reviewRunId: string) => ReviewStore;

/**
 * One corpus row as init snapshots it.
 *
 * `Item` from the translate store satisfies this structurally, which is the
 * intended way in for a host whose corpus lives in a registry. A host whose
 * corpus lives anywhere else supplies the same six values and is no worse off.
 */
export interface ReviewSourceRow {
  /** The corpus row number. Becomes the review row's key within the run. */
  readonly rowNumber: number;
  readonly identifier: string;
  /** The corpus row's input hash, snapshotted so drift can be spotted afterwards. */
  readonly inputHash: string;
  readonly source: Readonly<Fields>;
  /** The accepted translation, or `null` for a row that has no answer. */
  readonly target: Readonly<Fields> | null;
  /** Checked against the accepted-corpus rule below. */
  readonly status: Status;
}

/** Everything the run id is derived from, and nothing else. */
export interface ReviewDerivationInputs {
  readonly job: ReviewJob;
  /**
   * The whole corpus, as this run will snapshot it. For a chained run that
   * means the base run's resolved output as `target`, which is why
   * {@link initializeReview} resolves the chain before calling this and a
   * caller deriving directly has to do the same.
   *
   * Order does not matter: the rows are sorted by row number before anything is
   * hashed, so the id cannot depend on how the caller happened to iterate.
   */
  readonly corpus: Iterable<ReviewSourceRow>;
  /**
   * The model profile this run is bound to, hashed into the id.
   *
   * The profile is in the id and the provider and model are not, which is
   * deliberate rather than an oversight. A profile is chosen when the run is
   * opened and names the configuration the run means; a provider binding can
   * legitimately arrive later (see `ReviewStore.bindProvider`), and an input
   * that can arrive after the id was computed cannot be one of the id's inputs.
   */
  readonly profile?: string | null;
  /** The completed run whose resolved output this run reviews, if it chains. */
  readonly baseRunId?: string | null;
}

/** What {@link initializeReview} needs beyond the derivation. */
export interface ReviewRunInputs extends ReviewDerivationInputs {
  /** Provenance, fixed when the run is created. Not part of the id; see `profile`. */
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  /**
   * Review a corpus that is not fully accepted.
   *
   * Off by default, and the refusal is a contract term rather than a
   * convenience: a snapshot taken over half-translated rows produces proposals
   * about text nobody has accepted, and there is no later moment at which that
   * becomes visible. Setting it is recorded in the run's options, so a partial
   * run is visibly partial forever.
   *
   * It is not an input to the run id, and does not need to be: a row with no
   * answer snapshots differently from the same row once it has one, so the two
   * corpora already derive two ids.
   */
  readonly allowPartial?: boolean;
  /** Recorded alongside init's own keys in the run's options. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** A run id and everything that went into it, computed without touching a store. */
export interface ReviewDerivation {
  readonly runId: string;
  /**
   * The named hashes the id was derived from, as stored in the run's `inputs`.
   *
   * Six keys always, plus `extra` when the job declares `extraInputs`. Not the
   * profile, `showSource` or the base run: those are columns of their own,
   * because the store can answer questions about them and cannot about a hash.
   */
  readonly inputs: Readonly<Record<string, string>>;
  readonly snapshotHash: string;
  readonly analysis: ConsistencyAnalysis;
  /** The rows in row order, ready for `createRun`. */
  readonly items: readonly ReviewItemRecord[];
  /** How many rows the job answered itself. See {@link settledByConstruction}. */
  readonly settledCount: number;
}

/** What init did, and what the run says about itself afterwards. */
export interface ReviewInitResult {
  readonly runId: string;
  /** False when the run already existed, which is idempotency working. */
  readonly created: boolean;
  readonly status: ReviewRunStatus;
  readonly itemCount: number;
  readonly settledCount: number;
  readonly snapshotHash: string;
  /**
   * The consistency analysis this run's evidence was taken from.
   *
   * Returned rather than written anywhere. A host that wants the bytes on disk
   * has `analysis.text`; nothing in the library needs them, because the run's
   * own snapshot reproduces the analysis exactly - `buildConsistency(job,
   * await store.snapshot())` is the same object, hash included.
   */
  readonly analysis: ConsistencyAnalysis;
  readonly inputs: Readonly<Record<string, string>>;
  /** The binding as stored, which on an existing run is the *first* run's binding. */
  readonly profile: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly showSource: boolean;
  readonly baseRunId: string | null;
}

/**
 * True when the job answers this row itself and the corpus carries exactly that
 * answer, field for field.
 *
 * `job.precomputed` is the translate side's escape hatch for a value that is
 * fixed rather than translated. Such a row has nothing for a reviewer to judge,
 * and asking one to judge a fixed string once per row is as many chances to
 * word it differently as there are rows. So it is snapshotted like every other
 * row - the run still covers the whole corpus - and seeded `pass` with no
 * proposal.
 *
 * Any drift makes it a normal row again. A corpus value that no longer matches
 * the answer the job would give is exactly the case a reviewer should see.
 */
export function settledByConstruction(
  job: TranslationJob,
  source: Readonly<Fields>,
  target: Readonly<Fields> | null,
): boolean {
  if (target === null) return false;
  const answer = job.precomputed?.(source);
  if (!answer) return false;
  return Object.entries(answer).every(([key, value]) => target[key] === value);
}

/**
 * The whole snapshot as one string, which is then hashed.
 *
 * Two separators that cannot occur in JSON text or in an identifier read as
 * text, so no row can spell another row's boundary. The target of a row that
 * has none is the empty string rather than `{}`, which differs from what the
 * row is *stored* as - preserved deliberately, because run ids already
 * published were derived this way and a tidy-up here silently renames every
 * one of them.
 */
// Written as codepoints rather than as literal control characters: the bytes
// are invisible in an editor and one of them cannot survive a round trip
// through most tools that touch source. What they are is load bearing, so
// they should be readable.
const FIELD = String.fromCharCode(0);
const ROW = String.fromCharCode(1);

/**
 * A row's fields as bytes, in an order the host cannot influence.
 *
 * Every hash on this page runs through it. `JSON.stringify` writes an object's
 * keys in insertion order, so hashing a host's object directly made the derived
 * run id an accident of the sequence that host happened to build its fields in:
 * the same corpus presented twice, differently ordered, derived two ids, and
 * `init` created a second run and re-reviewed a corpus it had already paid for.
 * `hashInput` in `contract/prompt.ts` has sorted its keys since it was written,
 * and says in its own comment that this is what the sorting is for, so the two
 * halves of the library disagreed about the same question.
 */
const canonicalJson = (fields: Readonly<Fields>): string => JSON.stringify(canonicalFields(fields));

function snapshotMaterial(rows: readonly ReviewSourceRow[]): string {
  return rows
    .map((row) =>
      [
        row.identifier,
        row.inputHash,
        canonicalJson(row.source),
        row.target === null ? '' : canonicalJson(row.target),
      ].join(FIELD),
    )
    .join(ROW);
}

/**
 * Derive a review run id, and everything that goes into the run beside it.
 *
 * Pure: no store, no filesystem, no clock. This is init with the writing taken
 * out, and it exists separately because "what id would these inputs produce"
 * is a question worth being able to ask - before opening a file, in a CLI that
 * wants to say what it is about to do, and in a test that wants to compare an
 * id against one produced somewhere else.
 */
export function deriveReviewRun(inputs: ReviewDerivationInputs): ReviewDerivation {
  const { job, profile = null, baseRunId = null } = inputs;
  const rows = [...inputs.corpus].sort((a, b) => a.rowNumber - b.rowNumber);
  if (!rows.length) throw new Error('No corpus to review');

  const rowNumbers = new Set<number>();
  const identifiers = new Set<string>();
  for (const row of rows) {
    if (rowNumbers.has(row.rowNumber))
      throw new Error(`The corpus has two rows numbered ${row.rowNumber}`);
    if (identifiers.has(row.identifier))
      throw new Error(`The corpus has two rows identified '${row.identifier}'`);
    rowNumbers.add(row.rowNumber);
    identifiers.add(row.identifier);
  }

  const snapshotHash = sha(snapshotMaterial(rows));
  // The analysis reads the same rows the snapshot hash was taken over, so its
  // input hash *is* the snapshot hash. The two names are kept apart because the
  // id reserves a slot for an analysis over something else, and reusing one
  // slot for both would make that a change to every existing id.
  const analysis = buildConsistency(
    job,
    rows.map((row) => ({ source: row.source, target: row.target ?? {} })),
  );
  const promptHash = sha(job.promptTemplate);
  const schemaHash = buildReviewSchema(job).hash;
  const terminologyHash = sha(job.terminology ?? '');
  const extra = extraInputsDigest(job);

  // Appended, not joined. `extraInputsDigest` answers the empty string for a
  // job that declares no host inputs, and joining an empty string into the list
  // would add a separator - moving the id of every run that predates the
  // mechanism, which is the one thing a mechanism a host can decline to use
  // must not do.
  const runId = sha(
    [
      profile ?? '',
      promptHash,
      schemaHash,
      terminologyHash,
      snapshotHash,
      analysis.hash,
      snapshotHash,
      job.showSource ? 'bi' : 'mono',
      baseRunId ?? '',
    ].join('|') + extra,
  ).slice(0, 32);

  let settledCount = 0;
  const items: ReviewItemRecord[] = rows.map((row) => {
    const settled = settledByConstruction(job.translation, row.source, row.target);
    if (settled) settledCount += 1;
    return {
      rowNumber: row.rowNumber,
      identifier: row.identifier,
      inputHash: row.inputHash,
      sourceHash: sha(canonicalJson(row.source)),
      targetHash: sha(row.target === null ? '' : canonicalJson(row.target)),
      evidenceHash: sha(JSON.stringify(recordedEvidence(analysis, row.source))),
      source: row.source,
      // Stored as an object even when the row has none, so every reader of a
      // snapshot gets fields back rather than a null it has to think about.
      target: row.target ?? {},
      settled,
    };
  });

  return {
    runId,
    inputs: {
      prompt: promptHash,
      schema: schemaHash,
      terminology: terminologyHash,
      analysisInput: snapshotHash,
      analysisOutput: analysis.hash,
      snapshot: snapshotHash,
      ...(extra ? { extra } : {}),
    },
    snapshotHash,
    analysis,
    items,
    settledCount,
  };
}

/** Refuse a corpus that is not fully accepted, naming what is not. */
function requireAccepted(rows: readonly ReviewSourceRow[]): void {
  const counts = new Map<Status, number>();
  for (const row of rows)
    if (row.status !== 'succeeded') counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  if (!counts.size) return;
  const summary = [...counts].map(([status, n]) => `${status}=${n}`).join(', ');
  throw new Error(
    `A review run requires a fully accepted corpus; not accepted: ${summary}. ` +
      'Accept or re-run those rows first, or pass allowPartial to snapshot the corpus as it ' +
      'stands - which is recorded on the run, because a review of unaccepted text is a ' +
      'different thing from a review and should stay one.',
  );
}

/**
 * Resolve a chained run's target values, refusing a base that cannot carry the
 * chain.
 *
 * Two refusals, and both are about the same thing. A base that has not
 * completed has rows nobody has answered, so chaining onto it would freeze a
 * half-finished opinion into the next stage's snapshot and never mention it
 * again. A base that does not cover a row leaves that row reviewing the live
 * corpus while its neighbours review stage 1's corrections, which is a corpus
 * that never existed at any single moment.
 */
async function resolveBase(
  open: ReviewStoreProvider,
  baseRunId: string,
  rows: readonly ReviewSourceRow[],
): Promise<Map<number, Fields>> {
  const base = open(baseRunId);
  const record = await base.run();
  if (!record) throw new Error(`Unknown base review run ${baseRunId}`);
  if (record.status !== 'completed')
    throw new Error(
      `Base review run ${baseRunId} is ${record.status}; it must be completed before chaining`,
    );
  const output = resolveRunOutput(await base.snapshot());
  for (const row of rows) {
    if (!output.has(row.rowNumber))
      throw new Error(
        `Base review run ${baseRunId} does not cover row ${row.rowNumber} (${row.identifier}); ` +
          're-initialize the base run against the current corpus',
      );
  }
  return output;
}

/**
 * Open a review run over an accepted corpus, or find the one these inputs
 * already opened.
 *
 * The whole of it, in order: refuse a corpus that is not accepted, resolve the
 * chain if there is one, derive the id and the snapshot, and write the run and
 * every one of its rows in a single transaction (store contract term 7). A
 * second call with the same inputs derives the same id, finds the run, and
 * returns it with `created: false`.
 *
 * **No store opened here is closed here.** The shipped provider hands back
 * stores over one shared connection, so closing the base run's store would
 * close the caller's registry underneath them. The connection belongs to
 * whoever opened it.
 */
export async function initializeReview(
  open: ReviewStoreProvider,
  inputs: ReviewRunInputs,
): Promise<ReviewInitResult> {
  const { job, baseRunId = null } = inputs;
  const rows = [...inputs.corpus];
  if (!inputs.allowPartial) requireAccepted(rows);

  const snapshotRows = baseRunId
    ? await (async () => {
        const output = await resolveBase(open, baseRunId, rows);
        return rows.map((row) => ({ ...row, target: output.get(row.rowNumber) ?? row.target }));
      })()
    : rows;

  const derived = deriveReviewRun({
    job,
    corpus: snapshotRows,
    profile: inputs.profile ?? null,
    baseRunId,
  });

  const store = open(derived.runId);
  const created = await store.createRun(
    {
      runId: derived.runId,
      provider: inputs.provider ?? null,
      model: inputs.model ?? null,
      profile: inputs.profile ?? null,
      reasoningEffort: inputs.reasoningEffort ?? null,
      options: {
        ...inputs.options,
        // Init's own keys last, so a caller cannot overwrite the record of how
        // the run was actually configured with a key of the same name.
        jobId: job.id,
        reviewFields: derived.analysis.fields,
        showSource: job.showSource,
        allowPartial: Boolean(inputs.allowPartial),
      },
      inputs: derived.inputs,
      baseRunId,
    },
    derived.items,
  );

  // Read back rather than echo the arguments: on `created: false` the binding
  // that matters is the one the *first* call recorded, and reporting the
  // arguments would quietly claim this call's profile was in the id.
  const stored = (await store.run()) as StoredReviewRun;
  return {
    runId: derived.runId,
    created,
    status: stored.status,
    itemCount: derived.items.length,
    settledCount: derived.settledCount,
    snapshotHash: derived.snapshotHash,
    analysis: derived.analysis,
    inputs: derived.inputs,
    profile: stored.profile,
    provider: stored.provider,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    showSource: job.showSource,
    baseRunId,
  };
}
