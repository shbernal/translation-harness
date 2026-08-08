// The review pass, as one configuration of the generic agent batch.
//
// This is the sibling of `pipeline/run.ts` and it is deliberately the same
// shape: the pool, the atomic claim, the retry ladder, the quota pause, the
// abort path and the final sweep are `batch/run.ts`'s and know nothing about
// review. What is left here is the review knowledge - which prompt a row gets,
// what a valid verdict is, and what recording one means.
//
// The thing worth knowing before reading it is the two-level naming, because
// every line below turns on it. **A review run is a job; a pass is one
// execution of it.** The run is created once by `initializeReview`, with a
// derived id and a frozen snapshot, and then executed as many times as it takes.
// So the run the batch layer opens and closes is *not* the review run: it is a
// pass, and `startRun`, `finishRun` and `tryClaim`'s run id all mean a pass.
// Step by step:
//
//   * `initializeReview` opens the job.
//   * `runReview` opens a pass, and decides the job's status afterwards.
//   * `runAgentBatch` closes the pass.
//
// That is what keeps `releaseSettledRunClaims` meaningful here: a crashed pass
// ends, and the rows it was holding come back without waiting on a clock. Had
// the claim been recorded against the job, it could never fire, because the job
// stays open across exactly the crash that stranded the rows.

import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { RunEvent as BatchRunEvent } from '../batch/run.ts';
import { runAgentBatch } from '../batch/run.ts';
import type { ProviderOptions } from '../provider/types.ts';
import type {
  ReviewItem,
  ReviewRunStatus,
  ReviewStore,
  ReviewVerdict,
} from '../store/review-types.ts';
import { buildConsistency, promptEvidence } from './consistency.ts';
import type { ReviewJob } from './job.ts';
import { buildReviewPrompt } from './prompt.ts';
import { writeReviewSchema } from './schema.ts';
import { validateReview } from './validate.ts';

/**
 * Something worth telling the caller about.
 *
 * The batch runner's event union, narrowed to the verdicts a reviewed row can
 * settle as. One union serves both lifecycles; specializing it here is what
 * keeps `switch (event.outcome)` exhaustive for a review consumer, exactly as
 * `RunEvent` does for a translation one.
 */
export type ReviewEvent = BatchRunEvent<ReviewVerdict>;

export interface ReviewRunOptions extends ProviderOptions {
  /**
   * Where the schema and the per-attempt evidence are written.
   *
   * Both land under `<workDir>/review/<reviewRunId>/`, so a run's evidence sits
   * beside the run it belongs to and two runs over one corpus cannot overwrite
   * each other. Attempts from every pass share that one directory: an attempt
   * number is allocated per row across the whole run, so the file names cannot
   * collide, and which pass produced an attempt is recorded on the attempt row
   * rather than spelled into a path.
   */
  workDir: string;

  maxAttempts: number;

  /**
   * Pause after each row, **per worker**. It paces one provider conversation,
   * so at concurrency N the effective rate is roughly
   * `N / (avgLatency + delay)`.
   */
  delaySeconds: number;

  /**
   * Reviewer calls in flight at once. 1 (the default) behaves exactly like the
   * serial flow.
   */
  concurrency?: number;

  /**
   * Cancellation. Aborting stops the pool pulling new rows; rows already in
   * flight finish, because they are work already paid for.
   *
   * A library must not install a process-wide signal handler, so wiring SIGINT
   * to a controller is the caller's job and takes two lines.
   */
  signal?: AbortSignal;

  /**
   * Progress. The runner owns no output stream, so it reports and the caller
   * decides whether that means a log line, a progress bar or nothing.
   */
  onEvent?: (event: ReviewEvent) => void;
}

export interface ReviewSummary {
  pass: number;
  change_proposed: number;
  failed: number;
}

/** A pass id. The same shape as a translation run id, and for the same reasons. */
function newPassId(): string {
  return `${Date.now().toString(36)}-${randomInt(0, 0xffffffff).toString(36)}`;
}

/**
 * The provider binding, fixed the first time a run executes.
 *
 * Provenance is the whole argument. A review run records one provider, one
 * model and one reasoning effort, so a run answered under two of them would
 * store a claim about itself that is false for half its rows - and unlike a
 * changed prompt or a changed corpus, this cannot show up as a different run
 * id, because a binding may legitimately arrive after the id was computed.
 * Refusing the switch is the only place it can be caught.
 *
 * An option left unset inherits the binding rather than being refused, so
 * resuming a run takes `--provider` and nothing else. Setting one to something
 * the run is not bound to is refused rather than ignored: silently running the
 * stored model while the caller believes they chose another is the failure this
 * exists to prevent, wearing a friendlier face.
 */
function resolveBinding(
  reviewRunId: string,
  bound: { provider: string | null; model: string | null; reasoningEffort: string | null },
  asked: ProviderOptions,
): { provider: string; model: string | null; reasoningEffort: string | null } {
  if (!bound.provider) {
    return {
      provider: asked.provider,
      model: asked.model ?? null,
      reasoningEffort: asked.reasoningEffort ?? null,
    };
  }
  const refuse = (what: string, held: string | null, wanted: string | null | undefined): void => {
    if (wanted == null || wanted === held) return;
    throw new Error(
      `Review run ${reviewRunId} is bound to ${what} ${held ?? 'none'} and cannot be run with ` +
        `${wanted}: a run records one binding, and answers produced under two of them would ` +
        'make that record false. Initialize a new run to review under a different binding.',
    );
  };
  refuse('provider', bound.provider, asked.provider);
  refuse('model', bound.model, asked.model);
  refuse('reasoning effort', bound.reasoningEffort, asked.reasoningEffort);
  return { provider: bound.provider, model: bound.model, reasoningEffort: bound.reasoningEffort };
}

/**
 * Review the rows given, as one pass over an already-initialized run.
 *
 * The candidates come from the caller - `store.selectCandidates({})` for
 * everything still pending - which is the shape `runTranslation` already has,
 * and for the same reason: which rows to attempt is a decision about this pass,
 * not about the run, and a pilot, a retry and a resume are all just different
 * answers to it.
 *
 * Nothing here needs a file written by init. The consistency evidence is
 * rebuilt from the run's own snapshot, which reproduces the analysis init
 * derived the run id from, hash included - so the run directory holds evidence
 * and nothing the next pass depends on.
 */
export async function runReview(
  store: ReviewStore,
  job: ReviewJob,
  candidates: readonly ReviewItem[],
  options: ReviewRunOptions,
): Promise<ReviewSummary> {
  const reviewRunId = store.reviewRunId;
  const run = await store.run();
  if (!run)
    throw new Error(
      `Unknown review run ${reviewRunId}; open it with initializeReview before running it`,
    );

  const binding = resolveBinding(reviewRunId, run, options);
  if (!run.provider) await store.bindProvider(binding);

  const runDir = join(options.workDir, 'review', reviewRunId);
  // Written per run rather than per work directory: the schema is one of the
  // inputs this run's id was derived from, so the copy on disk belongs beside
  // the run it identifies and not beside whatever ran last.
  const schemaPath = writeReviewSchema(job, runDir);
  // The snapshot is the corpus this run froze, so this is the same analysis
  // init derived the run id from - including for a chained run, whose snapshot
  // holds the base run's resolved output rather than the live corpus.
  const analysis = buildConsistency(job, await store.snapshot());

  const passId = newPassId();
  const modelLabel = `${binding.provider}:${binding.model ?? 'config-default'}`;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  await store.startRun({
    runId: passId,
    model: modelLabel,
    options: {
      provider: binding.provider,
      timeout_seconds: options.timeoutSeconds,
      max_attempts: options.maxAttempts,
      candidate_count: candidates.length,
      concurrency,
    },
  });
  await store.setRunStatus('running');

  let settled: Record<string, number>;
  let failed: number;
  try {
    ({ settled, failed } = await runAgentBatch<ReviewItem, ReviewVerdict>({
      ...options,
      ...binding,
      store,
      runId: passId,
      rows: candidates.map((candidate) => candidate.rowNumber),
      schemaPath,
      attemptDir: join(runDir, 'attempts'),
      concurrency,

      buildPrompt: (item) =>
        buildReviewPrompt(
          job,
          item.identifier,
          item.source,
          item.target,
          promptEvidence(analysis, item.source),
        ),

      // `validateReview` raises `TransientFailure` for an answer it will not
      // accept, which the batch runner turns into a failed attempt and a retry.
      // Anything else thrown from here is a bug and ends the pass.
      commit: async (item, result, attempt) => {
        const reviewed = validateReview(job, item.identifier, result.value);
        await store.commitVerdict({
          attemptId: attempt.attemptId,
          duration: result.duration,
          exitCode: result.exitCode,
          rowNumber: item.rowNumber,
          verdict: reviewed.verdict,
          severity: reviewed.severity,
          confidence: reviewed.confidence,
          proposals: reviewed.proposals,
          issues: reviewed.issues,
          attemptNumber: attempt.attemptNumber,
        });
        return reviewed.verdict;
      },

      fail: async (item, failure) =>
        store.markItemFailed({
          rowNumber: item.rowNumber,
          lastError: failure.reason,
          attemptCount: failure.attemptNumber,
        }),
    }));
  } catch (error) {
    // The batch has already failed the pass and recorded the internal error.
    // The job outlives the pass, so it needs saying separately - best effort,
    // for contract term 4's reason: the store is very often what broke, and its
    // failure must not replace the error the caller needs to see.
    await store.setRunStatus('failed').catch(() => {});
    throw error;
  }

  // The job's status is a statement about its rows, not about a live process -
  // that is the pass's business, and `review_passes` is where it is recorded.
  // A pass that stopped early (a quota pause, a limit, a filtered selection)
  // leaves the job open rather than finished, which is what `running` means
  // here: work remains, and no clock is being watched.
  const counts = await store.counts();
  const outstanding = counts.pending + counts.running;
  const status: ReviewRunStatus =
    outstanding === 0 ? 'completed' : options.signal?.aborted ? 'interrupted' : 'running';
  await store.setRunStatus(status);

  // The batch counts the labels it saw. A review summary names all three every
  // time, so a caller can print a total without checking for gaps.
  return {
    pass: settled.pass ?? 0,
    change_proposed: settled.change_proposed ?? 0,
    failed,
  };
}
