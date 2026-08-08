// The resumable per-row agent batch. Each row is claimed, sent to one agent CLI
// call and committed in its own store transaction, so an interrupted or
// quota-paused batch resumes cleanly. Quota pauses the whole batch; transient
// errors retry with bounded exponential backoff plus jitter.
//
// Nothing here knows what a row means. What the prompt says, whether an answer
// is acceptable, and what committing one amounts to are callbacks, and the layer
// rule is what stops them leaking back in: `batch` may import `errors` and
// `provider`, and nothing else. `runTranslation` is one configuration of this
// function; the review pass is another.

import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransientFailure } from '../errors.ts';
import { invokeProvider } from '../provider/registry.ts';
import type { ProviderOptions, ProviderResult } from '../provider/types.ts';
import type { BatchStore, ClaimedRow } from './types.ts';

/**
 * Something worth telling the caller about.
 *
 * One union for every lifecycle, because there is one runner and so one
 * reporter. `TOutcome` is the set of labels a caller's `commit` may return, so a
 * consumer that switches on `outcome` keeps whatever exhaustiveness it had:
 * `runTranslation` reports `RunEvent<Outcome>` and nothing wider.
 */
export type RunEvent<TOutcome extends string = string> =
  | {
      kind: 'row-settled';
      identifier: string;
      outcome: TOutcome | 'failed';
      /** Seconds the provider took. Zero for a row settled without one. */
      durationSeconds: number;
      /**
       * True when `settleWithoutProvider` answered the row and no subprocess
       * ran. Named for the translation case that shipped first, and kept that
       * way because the name is published.
       */
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

/** Where one attempt's evidence went, and which attempt it was. */
export interface AttemptContext {
  attemptId: number;
  /** Allocated by the store, and embedded in the three paths below. */
  attemptNumber: number;
  responsePath: string;
  stdoutPath: string;
  stderrPath: string;
}

/** Why the runner gave up on a row. */
export interface BatchFailure {
  /** Already formatted as `category: message`, or `unknown failure`. */
  reason: string;
  /** The row's last attempt number, or 0 if no attempt was ever started. */
  attemptNumber: number;
  /**
   * A quota refusal, which also stops the batch pulling new rows. The row is
   * failed either way; a caller that records *why* wants to tell the two apart,
   * because a quota failure says nothing about the row.
   */
  quota: boolean;
}

/**
 * The batch's options, which are the provider's options plus the knobs that
 * govern the pool.
 *
 * Deliberately one flat bag rather than a nested `provider` field: a caller
 * thinks about a run as one set of decisions, `ProviderOptions.provider` already
 * holds the provider *name*, and `RunOptions` was published in this shape.
 */
export interface AgentBatchOptions<TRow extends ClaimedRow, TOutcome extends string = string>
  extends ProviderOptions {
  store: BatchStore<TRow>;

  /**
   * The run these rows belong to. **The caller opens the run and the runner
   * closes it.** That split is not arbitrary: what a run was configured with is
   * provenance the caller owns (and a lifecycle whose run ids are derived rather
   * than generated opens the run long before anything executes), whereas why it
   * stopped is knowledge only the pool has.
   */
  runId: string;

  /**
   * The rows to attempt, in the order to attempt them. Row numbers rather than
   * rows: the runner claims each one and works from what the store hands back,
   * so a richer candidate object would only be a staler copy of it.
   */
  rows: readonly number[];

  /** Path to the JSON Schema every answer must satisfy. */
  schemaPath: string;

  /** Where per-attempt evidence is written. Created if it does not exist. */
  attemptDir: string;

  buildPrompt(row: TRow): string;

  /**
   * Record the answer and say how the row settled. The returned label is what
   * the summary counts and what the event reports.
   *
   * Throwing `TransientFailure` fails the attempt and the row is retried, which
   * is how validation refuses an answer. Throwing anything else is fatal to the
   * whole batch, on the grounds that it is a bug rather than a bad answer.
   */
  commit(row: TRow, result: ProviderResult, attempt: AttemptContext): Promise<TOutcome>;

  /** Record a row the runner could not settle. */
  fail(row: TRow, failure: BatchFailure): Promise<void>;

  /**
   * A chance to answer the row without a provider, returning the label it
   * settled as, or `null` to send it to the agent after all. Whatever it does
   * must commit the row itself.
   *
   * The row skips the inter-row delay when this answers it, because that delay
   * paces a provider conversation and there was none.
   */
  settleWithoutProvider?(row: TRow): Promise<TOutcome | null>;

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
  onEvent?(event: RunEvent<TOutcome>): void;
}

export interface BatchSummary {
  /**
   * Rows settled, counted by the label `commit` or `settleWithoutProvider`
   * returned. Labels no row settled as are absent rather than zero: the runner
   * does not know the caller's full label set.
   */
  settled: Record<string, number>;
  /** Rows the runner gave up on: attempts exhausted, or a quota refusal. */
  failed: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sanitize(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export async function runAgentBatch<TRow extends ClaimedRow, TOutcome extends string = string>(
  options: AgentBatchOptions<TRow, TOutcome>,
): Promise<BatchSummary> {
  const { store, runId, rows } = options;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  mkdirSync(options.attemptDir, { recursive: true });
  const emit = (event: RunEvent<TOutcome>): void => options.onEvent?.(event);

  const summary: BatchSummary = { settled: {}, failed: 0 };
  const settled = (label: TOutcome): void => {
    summary.settled[label] = (summary.settled[label] ?? 0) + 1;
  };

  // The rows this run currently owns. An internal error fails exactly these and
  // nothing else: "every claimed row" would also fail every row a concurrent
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
  const total = rows.length;
  // Settled count, not cursor position: with workers, rows settle out of order
  // and a position number would claim progress the run has not made. The
  // provider-free path uses the same counter, so one sequence covers the run.
  const settle = (): number => ++completed;

  const worker = async (): Promise<void> => {
    try {
      while (!stop.interrupted && !stop.paused && !stop.fatal) {
        const position = cursor++;
        if (position >= total) return;
        const candidate = rows[position];
        if (candidate === undefined) return;

        // A lost claim means a competitor owns the row: skip it, take the next.
        const row = await store.tryClaim(candidate, runId);
        if (!row) continue;
        // NOTHING MAY BE AWAITED BETWEEN THE CLAIM ABOVE AND THESE TWO LINES.
        // The store now owns the row. If an abort or a throw slipped in here,
        // the row would be claimed in the registry and absent from `claimed`,
        // so the final sweep would never release it and it would sit claimed
        // forever, invisible to every selection filter. It looks like a harmless
        // place to add a log line or a check. It is not.
        inFlight.add(row.rowNumber);
        claimed.push(row.rowNumber);

        try {
          // A row the caller can answer itself never reaches a provider, and
          // skips the inter-row delay: that delay paces a provider, and none was
          // called.
          const without = await options.settleWithoutProvider?.(row);
          if (without !== null && without !== undefined) {
            settled(without);
            emit({
              kind: 'row-settled',
              identifier: row.identifier,
              outcome: without,
              durationSeconds: 0,
              precomputed: true,
              completed: settle(),
              total,
            });
            continue;
          }

          const prompt = options.buildPrompt(row);
          let finalError = 'unknown failure';
          let outcomeReached = false;
          let lastAttemptNumber = 0;

          for (let localAttempt = 1; localAttempt <= options.maxAttempts; localAttempt++) {
            const { attemptId, attemptNumber } = await store.startAttempt({
              runId,
              rowNumber: row.rowNumber,
            });
            lastAttemptNumber = attemptNumber;
            const stem = `${String(row.rowNumber).padStart(5, '0')}_${sanitize(row.identifier)}_a${String(attemptNumber).padStart(2, '0')}`;
            const responsePath = join(options.attemptDir, `${stem}.response.json`);
            const stdoutPath = join(options.attemptDir, `${stem}.stdout.log`);
            const stderrPath = join(options.attemptDir, `${stem}.stderr.log`);
            // The store allocated the attempt number, and the file names embed
            // it, so the paths can only be recorded now. Until this lands the
            // attempt row has null paths, which is honest: the files do not
            // exist yet either.
            await store.setAttemptPaths(attemptId, { responsePath, stdoutPath, stderrPath });

            try {
              const result = await invokeProvider({
                prompt,
                responsePath,
                schemaPath: options.schemaPath,
                options,
              });
              writeFileSync(stdoutPath, result.stdout, 'utf8');
              writeFileSync(stderrPath, result.stderr, 'utf8');
              const outcome = await options.commit(row, result, {
                attemptId,
                attemptNumber,
                responsePath,
                stdoutPath,
                stderrPath,
              });
              settled(outcome);
              emit({
                kind: 'row-settled',
                identifier: row.identifier,
                outcome,
                durationSeconds: result.duration,
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
                await options.fail(row, {
                  reason: `quota: ${error.message}`,
                  attemptNumber,
                  quota: true,
                });
                summary.failed++;
                emit({
                  kind: 'quota-paused',
                  identifier: row.identifier,
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
                  identifier: row.identifier,
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
            await options.fail(row, {
              reason: finalError,
              attemptNumber: lastAttemptNumber,
              quota: false,
            });
            summary.failed++;
            emit({
              kind: 'row-settled',
              identifier: row.identifier,
              outcome: 'failed',
              durationSeconds: 0,
              precomputed: false,
              completed: settle(),
              total,
            });
          }
        } finally {
          inFlight.delete(row.rowNumber);
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
  // claimed: a stranded claimed row is invisible to every selection filter, so a
  // resume skips it silently until `reclaimStale`'s cutoff passes or a host calls
  // `releaseSettledRunClaims`. Every ordinary path already settles its row, so
  // this normally changes nothing. It is the guarantee, not the mechanism.
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
