// The resumable batch runner. Each row is claimed, translated, validated and
// committed in its own store transaction, so an interrupted or quota-paused run
// resumes cleanly. Quota pauses the whole batch; transient errors retry with
// bounded exponential backoff plus jitter.

import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrompt, jobPromptHash, promptExtrasFor } from '../contract/prompt.ts';
import { writeResponseSchema } from '../contract/schema.ts';
import { validateResponse } from '../contract/validate.ts';
import { TransientFailure } from '../errors.ts';
import type { TranslationJob } from '../job.ts';
import { invokeProvider } from '../provider/registry.ts';
import type { ProviderOptions } from '../provider/types.ts';
import type { Item, Outcome, TranslationStore } from '../store/types.ts';

/** Something worth telling the caller about. */
export type RunEvent =
  | {
      kind: 'row-settled';
      identifier: string;
      outcome: Outcome | 'failed';
      /** Seconds the provider took. Zero for a precomputed row. */
      durationSeconds: number;
      /** True when the job answered the row itself and no provider ran. */
      precomputed: boolean;
      completed: number;
      total: number;
    }
  | {
      kind: 'row-retrying';
      identifier: string;
      category: string;
      waitMs: number;
      completed: number;
      total: number;
    }
  | {
      kind: 'quota-paused';
      identifier: string;
      message: string;
      completed: number;
      total: number;
    }
  | { kind: 'rows-released'; count: number };

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sanitize(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]+/g, '_');
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
  const currentPromptHash = jobPromptHash(job);
  const runId = newRunId();
  const modelLabel = `${options.provider}:${options.model ?? 'config-default'}`;
  const attemptRoot = join(options.workDir, 'attempts', runId);
  mkdirSync(attemptRoot, { recursive: true });
  const emit = (event: RunEvent): void => options.onEvent?.(event);

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

  const summary: RunSummary = { succeeded: 0, review_required: 0, failed: 0 };
  // The rows this run currently owns. An internal error fails exactly these and
  // nothing else: "every running row" would also fail every row a concurrent
  // worker or a second process happens to hold. Tracked explicitly rather than
  // queried back, which is heavier and would still catch a row another run
  // claimed before recording its first attempt.
  const inFlight = new Set<number>();
  /** Every row this run has ever claimed, for the final sweep. */
  const claimed: number[] = [];

  /**
   * Why the pool should stop pulling. One object rather than three `let`s: they
   * are a single decision read on every iteration by every worker, and each one
   * ends the run differently.
   *
   * - `interrupted`: the caller aborted. In-flight rows finish.
   * - `paused`: a quota failure. Same: stop pulling, let the rest land.
   * - `fatal`: a non-transient error, with the rows this run owned at that moment.
   */
  const stop = {
    interrupted: options.signal?.aborted ?? false,
    paused: false,
    fatal: null as { error: unknown; owned: number[] } | null,
  };
  const onAbort = (): void => {
    stop.interrupted = true;
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let cursor = 0;
  let completed = 0;
  const total = candidates.length;
  // Settled count, not cursor position: with workers, rows settle out of order
  // and a position number would claim progress the run has not made. The
  // precomputed path uses the same counter, so one sequence covers the run.
  const settle = (): number => ++completed;

  const worker = async (): Promise<void> => {
    try {
      while (!stop.interrupted && !stop.paused && !stop.fatal) {
        const position = cursor++;
        if (position >= total) return;
        const candidate = candidates[position];
        if (!candidate) return;

        // A lost claim means a competitor owns the row: skip it, take the next.
        const item = await store.tryClaim(candidate.rowNumber, runId);
        if (!item) continue;
        // NOTHING MAY BE AWAITED BETWEEN THE CLAIM ABOVE AND THESE TWO LINES.
        // The store now owns the row. If an abort or a throw slipped in here,
        // the row would be claimed in the registry and absent from `claimed`,
        // so the final sweep would never release it and it would sit in
        // `running` forever, invisible to every selection filter. It looks like
        // a harmless place to add a log line or a check. It is not.
        inFlight.add(item.rowNumber);
        claimed.push(item.rowNumber);

        try {
          const source = item.source;

          // A row the job can answer itself never reaches a provider. It still
          // goes through validateResponse, so it clears the same structural and
          // job-specific guardrails a model answer would, and it skips the
          // inter-row delay: that delay paces a provider, and none was called.
          const precomputed = job.precomputed?.(source);
          if (precomputed) {
            const { translations, warnings, reviewReasons } = validateResponse(
              job,
              source,
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
              promptHash: currentPromptHash,
            });
            summary[outcome]++;
            emit({
              kind: 'row-settled',
              identifier: item.identifier,
              outcome,
              durationSeconds: 0,
              precomputed: true,
              completed: settle(),
              total,
            });
            continue;
          }

          const prompt = buildPrompt(job, item.identifier, source, promptExtrasFor(job, source));
          let finalError = 'unknown failure';
          let outcomeReached = false;
          let lastAttemptNumber = 0;

          for (let localAttempt = 1; localAttempt <= options.maxAttempts; localAttempt++) {
            const { attemptId, attemptNumber } = await store.startAttempt({
              runId,
              rowNumber: item.rowNumber,
            });
            lastAttemptNumber = attemptNumber;
            const stem = `${String(item.rowNumber).padStart(5, '0')}_${sanitize(item.identifier)}_a${String(attemptNumber).padStart(2, '0')}`;
            const responsePath = join(attemptRoot, `${stem}.response.json`);
            const stdoutPath = join(attemptRoot, `${stem}.stdout.log`);
            const stderrPath = join(attemptRoot, `${stem}.stderr.log`);
            // The store allocated the attempt number, and the file names embed
            // it, so the paths can only be recorded now. Until this lands the
            // attempt row has null paths, which is honest: the files do not
            // exist yet either.
            await store.setAttemptPaths(attemptId, { responsePath, stdoutPath, stderrPath });

            try {
              const { value, stdout, stderr, exitCode, duration } = await invokeProvider({
                prompt,
                responsePath,
                schemaPath,
                options,
              });
              writeFileSync(stdoutPath, stdout, 'utf8');
              writeFileSync(stderrPath, stderr, 'utf8');
              const { translations, warnings, reviewReasons } = validateResponse(
                job,
                source,
                item.identifier,
                value,
              );
              const outcome: Outcome = reviewReasons.length ? 'review_required' : 'succeeded';
              await store.commitSuccess({
                attemptId,
                duration,
                outcome,
                exitCode,
                rowNumber: item.rowNumber,
                translations,
                warnings,
                reviewReasons,
                promptHash: currentPromptHash,
                modelLabel,
                attemptNumber,
              });
              summary[outcome]++;
              emit({
                kind: 'row-settled',
                identifier: item.identifier,
                outcome,
                durationSeconds: duration,
                precomputed: false,
                completed: settle(),
                total,
              });
              outcomeReached = true;
              break;
            } catch (error) {
              if (!(error instanceof TransientFailure)) {
                // Stop the pool and let it drain. Recording here would clobber
                // the in-progress attempts of workers about to finish their rows
                // perfectly well, so the run's own rows are snapshotted and the
                // write happens once, after everyone is done.
                stop.fatal ??= { error, owned: [...inFlight] };
                return;
              }
              finalError = `${error.category}: ${error.message}`;
              writeFileSync(stdoutPath, '', 'utf8');
              writeFileSync(stderrPath, '', 'utf8');
              await store.failAttempt(attemptId, error);
              if (error.category === 'quota') {
                await store.markItemFailed({
                  rowNumber: item.rowNumber,
                  lastError: `quota: ${error.message}`,
                  promptHash: currentPromptHash,
                  modelLabel,
                  attemptCount: attemptNumber,
                });
                summary.failed++;
                emit({
                  kind: 'quota-paused',
                  identifier: item.identifier,
                  message: error.message,
                  completed: settle(),
                  total,
                });
                // Every worker stops pulling; the ones mid-row still commit
                // their answer, which is work already paid for.
                stop.paused = true;
                return;
              }
              if (localAttempt < options.maxAttempts) {
                const wait = Math.min(30_000, 2 ** (localAttempt - 1) * 1000 + randomInt(0, 1000));
                emit({
                  kind: 'row-retrying',
                  identifier: item.identifier,
                  category: error.category,
                  waitMs: wait,
                  completed,
                  total,
                });
                await sleep(wait);
              }
            }
          }

          if (!outcomeReached) {
            await store.markItemFailed({
              rowNumber: item.rowNumber,
              lastError: finalError,
              promptHash: currentPromptHash,
              modelLabel,
              attemptCount: lastAttemptNumber,
            });
            summary.failed++;
            emit({
              kind: 'row-settled',
              identifier: item.identifier,
              outcome: 'failed',
              durationSeconds: 0,
              precomputed: false,
              completed: settle(),
              total,
            });
          }
        } finally {
          inFlight.delete(item.rowNumber);
        }
        if (cursor < total && options.delaySeconds) await sleep(options.delaySeconds * 1000);
      }
    } catch (error) {
      // Nothing above is expected to reach here (the provider path is handled
      // inline), but a worker that rejected would leave the pool half-drained
      // and `Promise.all` would abandon the rest. Funnel it into the same
      // channel.
      stop.fatal ??= { error, owned: [...inFlight] };
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (stop.fatal) {
    // Contract term 4: the store is often what broke, so this may fail too, and
    // its failure must not replace the error the caller actually needs to see.
    await store.recordInternalError(runId, stop.fatal.error, stop.fatal.owned).catch(() => {});
    await store.finishRun(runId, 'failed').catch(() => {});
    throw stop.fatal.error;
  }

  // Whatever path the run took out, it must not leave a row it claimed still
  // claimed: a stranded `running` row is invisible to every selection filter,
  // so a resume skips it silently until `reclaimStale`'s cutoff passes. Every
  // ordinary path already settles its row, so this normally changes nothing. It
  // is the guarantee, not the mechanism.
  const stranded = await store.unclaim(claimed);
  if (stranded) emit({ kind: 'rows-released', count: stranded });

  if (stop.paused) {
    await store.finishRun(runId, 'paused_quota');
    return summary;
  }
  if (stop.interrupted) {
    await store.finishRun(runId, 'interrupted');
    return summary;
  }
  await store.finishRun(runId, 'completed');
  return summary;
}
