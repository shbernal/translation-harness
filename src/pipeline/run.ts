// The translation pass, as one configuration of the generic agent batch.
//
// Everything that makes a run resumable - the atomic claim, the worker pool, the
// retry ladder, the quota pause, the abort path, the final sweep - lives in
// `batch/run.ts` and knows nothing about translation. What is left here is the
// translation knowledge itself: which prompt a row gets, what a valid answer is,
// and what committing one means. That is the whole of this file.
//
// The exported names and signatures are unchanged from when the pool was inline,
// because they are published and because the v0.1 acceptance gate is a byte
// comparison of what this function writes.

import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { RunEvent as BatchRunEvent } from '../batch/run.ts';
import { runAgentBatch } from '../batch/run.ts';
import { buildPrompt, jobPromptHash, promptExtrasFor } from '../contract/prompt.ts';
import { writeResponseSchema } from '../contract/schema.ts';
import { validateResponse } from '../contract/validate.ts';
import type { TranslationJob } from '../job.ts';
import type { ProviderOptions } from '../provider/types.ts';
import type { Item, Outcome, TranslationStore } from '../store/types.ts';

/**
 * Something worth telling the caller about.
 *
 * The batch runner's event union, narrowed to the outcomes a translation row can
 * settle as. One union serves both lifecycles; specializing it here is what keeps
 * `switch (event.outcome)` exhaustive for a translation consumer.
 */
export type RunEvent = BatchRunEvent<Outcome>;

export interface RunOptions extends ProviderOptions {
  /** Where the schema and the per-attempt evidence are written. */
  workDir: string;

  maxAttempts: number;

  /**
   * Pause after each row, **per worker**. It paces one provider conversation,
   * so at concurrency N the effective rate is roughly
   * `N / (avgLatency + delay)`. Deliberately not repurposed as a global rate
   * limit: that would be a different knob wearing the same name, and a run
   * tuned at concurrency 1 would silently change meaning when somebody raised
   * the pool.
   */
  delaySeconds: number;

  /**
   * Workers pulling from the shared cursor. 1 (the default) behaves exactly
   * like the serial flow, so nothing changes for anyone who does not ask.
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
  onEvent?: (event: RunEvent) => void;
}

export interface RunSummary {
  succeeded: number;
  review_required: number;
  failed: number;
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${randomInt(0, 0xffffffff).toString(36)}`;
}

export async function runTranslation(
  store: TranslationStore,
  job: TranslationJob,
  candidates: readonly Item[],
  options: RunOptions,
): Promise<RunSummary> {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const schemaPath = writeResponseSchema(job, options.workDir);
  // The salt is part of what produced a row once it reaches the model, so it is
  // part of the prompt's identity. An empty salt leaves the hash exactly where
  // a job without one has always had it.
  const promptHash = jobPromptHash(job);
  const runId = newRunId();
  const modelLabel = `${options.provider}:${options.model ?? 'config-default'}`;

  // Opening the run is the caller's, closing it is the runner's: what a run was
  // configured with is provenance this layer owns, and why it stopped is
  // knowledge only the pool has.
  await store.startRun({
    runId,
    model: modelLabel,
    options: {
      provider: options.provider,
      timeout_seconds: options.timeoutSeconds,
      max_attempts: options.maxAttempts,
      candidate_count: candidates.length,
      // Recorded so a finished run's throughput is auditable after the fact,
      // beside the timeout and attempt budget it was run with.
      concurrency,
    },
  });

  const { settled, failed } = await runAgentBatch<Item, Outcome>({
    ...options,
    store,
    runId,
    rows: candidates.map((candidate) => candidate.rowNumber),
    schemaPath,
    attemptDir: join(options.workDir, 'attempts', runId),
    concurrency,

    buildPrompt: (item) =>
      buildPrompt(job, item.identifier, item.source, promptExtrasFor(job, item.source)),

    // A row the job can answer itself never reaches a provider. It still goes
    // through validateResponse, so it clears the same structural and
    // job-specific guardrails a model answer would.
    settleWithoutProvider: async (item) => {
      const precomputed = job.precomputed?.(item.source);
      if (!precomputed) return null;
      const { translations, warnings, reviewReasons } = validateResponse(
        job,
        item.source,
        item.identifier,
        { identifier: item.identifier, translations: precomputed, warnings: [] },
      );
      const outcome: Outcome = reviewReasons.length ? 'review_required' : 'succeeded';
      await store.commitPrecomputed({
        rowNumber: item.rowNumber,
        outcome,
        translations,
        warnings,
        reviewReasons,
        promptHash,
      });
      return outcome;
    },

    // `validateResponse` raises `TransientFailure` for an answer it will not
    // accept, which the batch runner turns into a failed attempt and a retry.
    // Anything else thrown from here is a bug and ends the run.
    commit: async (item, result, attempt) => {
      const { translations, warnings, reviewReasons } = validateResponse(
        job,
        item.source,
        item.identifier,
        result.value,
      );
      const outcome: Outcome = reviewReasons.length ? 'review_required' : 'succeeded';
      await store.commitSuccess({
        attemptId: attempt.attemptId,
        duration: result.duration,
        outcome,
        exitCode: result.exitCode,
        rowNumber: item.rowNumber,
        translations,
        warnings,
        reviewReasons,
        promptHash,
        modelLabel,
        attemptNumber: attempt.attemptNumber,
      });
      return outcome;
    },

    fail: async (item, failure) =>
      store.markItemFailed({
        rowNumber: item.rowNumber,
        lastError: failure.reason,
        promptHash,
        modelLabel,
        attemptCount: failure.attemptNumber,
      }),
  });

  // The batch counts the labels it actually saw. A translation summary names all
  // three every time, so a caller can print a total without checking for gaps.
  return {
    succeeded: settled.succeeded ?? 0,
    review_required: settled.review_required ?? 0,
    failed,
  };
}
