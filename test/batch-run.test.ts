// The generic batch runner, driven over rows that are not translations.
//
// This is where the claim that `translation-harness/batch` is domain-free stops
// being an import rule and becomes a demonstration: the rows below are support
// tickets, the store is forty lines of `Map`, and neither the runner nor the
// suite it satisfies has any idea. It also gives `batchConformance` a second
// implementation, which is the only way to find out whether a conformance suite
// tests the interface or tests `sqliteStore`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { batchConformance } from '../src/batch/conformance.ts';
import { type AgentBatchOptions, type RunEvent, runAgentBatch } from '../src/batch/run.ts';
import type {
  AttemptPaths,
  AttemptStart,
  BatchStore,
  ClaimedRow,
  RunRecord,
  RunStatus,
  StartedAttempt,
} from '../src/batch/types.ts';
import { TransientFailure } from '../src/errors.ts';
import { registerProvider } from '../src/provider/registry.ts';
import { scratchDir } from './helpers/fake-cli.ts';

/** A row that is emphatically not a translation. */
interface Ticket extends ClaimedRow {
  question: string;
}

type Verdict = 'answered' | 'escalated';

interface MemoryRow {
  ticket: Ticket;
  claimedBy: string | null;
  claimedAt: number;
  state: 'open' | 'settled' | 'failed';
}

interface MemoryStore extends BatchStore<Ticket> {
  readonly rows: Map<number, MemoryRow>;
  readonly attempts: Map<number, { rowNumber: number; failed: boolean; paths?: AttemptPaths }>;
  readonly runs: Map<string, RunStatus>;
  claimedCount(): number;
  /**
   * Settling a row is the lifecycle's business, not `BatchStore`'s, so these two
   * are outside the interface exactly as `commitSuccess` and `markItemFailed`
   * are. The batch runner reaches them only through the caller's callbacks.
   */
  settleRow(rowNumber: number): void;
  failRow(rowNumber: number): void;
}

/**
 * A `BatchStore` in memory. Every mutation happens synchronously inside its
 * method, with nothing awaited first, which is exactly how `tryClaim` manages to
 * be atomic here: the term is about what two callers can observe, not about
 * locks.
 */
function memoryStore(count: number): MemoryStore {
  const rows = new Map<number, MemoryRow>();
  for (let i = 1; i <= count; i++) {
    rows.set(i, {
      ticket: { rowNumber: i, identifier: `TICKET-${i}`, question: `How do I do thing ${i}?` },
      claimedBy: null,
      claimedAt: 0,
      state: 'open',
    });
  }
  const attempts = new Map<number, { rowNumber: number; failed: boolean; paths?: AttemptPaths }>();
  const runs = new Map<string, RunStatus>();
  const perRow = new Map<number, number>();
  let nextAttemptId = 1;
  let closed = false;

  const release = (row: MemoryRow, state: MemoryRow['state']): void => {
    row.claimedBy = null;
    row.state = state;
  };

  return {
    rows,
    attempts,
    runs,
    claimedCount: () => [...rows.values()].filter((r) => r.claimedBy !== null).length,

    settleRow(rowNumber) {
      const row = rows.get(rowNumber);
      if (row) release(row, 'settled');
    },

    failRow(rowNumber) {
      const row = rows.get(rowNumber);
      if (row) release(row, 'failed');
    },

    async tryClaim(rowNumber, runId) {
      const row = rows.get(rowNumber);
      if (!row || row.claimedBy !== null || row.state !== 'open') return null;
      row.claimedBy = runId;
      row.claimedAt = Date.now();
      return row.ticket;
    },

    async unclaim(rowNumbers) {
      let released = 0;
      for (const rowNumber of rowNumbers) {
        const row = rows.get(rowNumber);
        if (row?.claimedBy) {
          release(row, 'open');
          released++;
        }
      }
      return released;
    },

    async reclaimStale(ageMinutes = 30) {
      const cutoff = Date.now() - ageMinutes * 60_000;
      let released = 0;
      for (const row of rows.values()) {
        if (row.claimedBy && row.claimedAt <= cutoff) {
          release(row, 'open');
          released++;
        }
      }
      return released;
    },

    async releaseSettledRunClaims() {
      let released = 0;
      for (const row of rows.values()) {
        // A claim naming a run this store has never seen is left alone: there is
        // nothing to ask about it, so it stays `reclaimStale`'s problem.
        const status = row.claimedBy === null ? undefined : runs.get(row.claimedBy);
        if (status !== undefined && status !== 'running') {
          release(row, 'open');
          released++;
        }
      }
      return released;
    },

    async startRun(run: RunRecord) {
      runs.set(run.runId, 'running');
    },

    async finishRun(runId, status) {
      runs.set(runId, status);
    },

    async startAttempt(attempt: AttemptStart): Promise<StartedAttempt> {
      const attemptNumber = (perRow.get(attempt.rowNumber) ?? 0) + 1;
      perRow.set(attempt.rowNumber, attemptNumber);
      const attemptId = nextAttemptId++;
      attempts.set(attemptId, { rowNumber: attempt.rowNumber, failed: false });
      return { attemptId, attemptNumber };
    },

    async setAttemptPaths(attemptId, paths) {
      const attempt = attempts.get(attemptId);
      if (attempt) attempt.paths = paths;
    },

    async failAttempt(attemptId) {
      const attempt = attempts.get(attemptId);
      if (attempt) attempt.failed = true;
    },

    async recordInternalError(_runId, _error, inFlight) {
      for (const rowNumber of inFlight) {
        const row = rows.get(rowNumber);
        if (row) release(row, 'failed');
      }
    },

    async close() {
      closed = true;
      assert.ok(closed, 'close is idempotent, which is why calling it twice is fine');
    },
  };
}

describe('a Map satisfies the BatchStore contract', () => {
  // The suite cannot create a row or count a claim through `BatchStore`, on
  // purpose, so the host supplies exactly those two capabilities.
  for (const { name, run } of batchConformance(async (rowCount) => {
    const store = memoryStore(rowCount);
    return {
      store,
      rows: [...store.rows.keys()],
      claimed: async () => store.claimedCount(),
    };
  })) {
    test(name, run);
  }
});

const ANSWER_PROVIDER = 'batch-test-answer';
let invocations = 0;

registerProvider(ANSWER_PROVIDER, async ({ prompt, responsePath }) => {
  invocations++;
  const value = { answer: `re: ${prompt}` };
  mkdirSync(dirname(responsePath), { recursive: true });
  writeFileSync(responsePath, `${JSON.stringify(value)}\n`, 'utf8');
  return { value, stdout: 'provider said something\n', stderr: '', exitCode: 0, duration: 0.25 };
});

/** The same, with both streams non-empty, so losing one is visible. */
const NOISY_PROVIDER = 'batch-test-noisy';
const NOISY_STDOUT = 'REAL STDOUT FROM THE PROVIDER\n';
const NOISY_STDERR = 'REAL STDERR FROM THE PROVIDER\n';

registerProvider(NOISY_PROVIDER, async ({ prompt, responsePath }) => {
  const value = { answer: `re: ${prompt}` };
  mkdirSync(dirname(responsePath), { recursive: true });
  writeFileSync(responsePath, `${JSON.stringify(value)}\n`, 'utf8');
  return {
    value,
    stdout: NOISY_STDOUT,
    stderr: NOISY_STDERR,
    exitCode: 0,
    duration: 0.25,
  };
});

interface Fixture {
  store: MemoryStore;
  options: AgentBatchOptions<Ticket, Verdict>;
  attemptDir: string;
}

/** A batch over `count` tickets, wired to the echoing provider. */
async function withBatch(count: number, body: (f: Fixture) => Promise<void>): Promise<void> {
  const scratch = scratchDir('batch');
  const store = memoryStore(count);
  const runId = 'run-under-test';
  await store.startRun({ runId, model: `${ANSWER_PROVIDER}:none`, options: {} });
  const schemaPath = join(scratch.dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object' }), 'utf8');
  const attemptDir = join(scratch.dir, 'attempts', runId);
  try {
    await body({
      store,
      attemptDir,
      options: {
        store,
        runId,
        rows: [...store.rows.keys()],
        schemaPath,
        attemptDir,
        cwd: scratch.dir,
        provider: ANSWER_PROVIDER,
        timeoutSeconds: 10,
        maxAttempts: 3,
        delaySeconds: 0,
        buildPrompt: (ticket) => ticket.question,
        commit: async (ticket) => {
          store.settleRow(ticket.rowNumber);
          return ticket.rowNumber % 3 === 0 ? ('escalated' as const) : ('answered' as const);
        },
        fail: async (ticket) => store.failRow(ticket.rowNumber),
      },
    });
  } finally {
    scratch.remove();
  }
}

describe('runAgentBatch', () => {
  test('settles every row under the labels the caller returned', async () => {
    await withBatch(6, async ({ store, options }) => {
      const summary = await runAgentBatch(options);
      assert.deepEqual(summary, { settled: { answered: 4, escalated: 2 }, failed: 0 });
      assert.equal(store.claimedCount(), 0, 'nothing may be left claimed');
      assert.equal(store.runs.get(options.runId), 'completed', 'the runner closes the run');
    });
  });

  test('keeps one attempt of evidence per row, named after the row', async () => {
    await withBatch(2, async ({ store, options, attemptDir }) => {
      await runAgentBatch(options);
      assert.equal(store.attempts.size, 2);
      for (const attempt of store.attempts.values()) {
        const paths = attempt.paths;
        assert.ok(paths, 'the runner records where the evidence went');
        for (const path of [paths.responsePath, paths.stdoutPath, paths.stderrPath]) {
          assert.ok(path.startsWith(attemptDir), 'evidence lands in the directory it was given');
          assert.ok(existsSync(path), `${path} must exist`);
        }
        assert.match(paths.responsePath, /00001_TICKET-1_a01|00002_TICKET-2_a01/);
        assert.equal(readFileSync(paths.stdoutPath, 'utf8'), 'provider said something\n');
      }
    });
  });

  test('a rejected answer fails the attempt and the row is retried', async () => {
    await withBatch(1, async ({ store, options }) => {
      // This is how validation refuses an answer: the same channel a provider
      // uses to report a timeout, so the retry ladder needs no second concept.
      let seen = 0;
      const events: RunEvent<Verdict>[] = [];
      const summary = await runAgentBatch<Ticket, Verdict>({
        ...options,
        onEvent: (event) => events.push(event),
        commit: async (ticket) => {
          seen++;
          if (seen === 1) throw new TransientFailure('invalid_shape', 'not what I asked for');
          store.settleRow(ticket.rowNumber);
          return 'answered';
        },
      });
      assert.deepEqual(summary, { settled: { answered: 1 }, failed: 0 });
      assert.equal(seen, 2, 'the second attempt settled it');
      assert.equal([...store.attempts.values()].filter((a) => a.failed).length, 1);
      // No `rows-released`: the row was settled by its commit, so the final
      // sweep found nothing to free. That event appearing here would mean the
      // guarantee was doing work it should not have had to do.
      assert.deepEqual(
        events.map((e) => e.kind),
        ['row-retrying', 'row-settled'],
      );
    });
  });

  // The evidence a refused attempt leaves is the evidence somebody opens. The
  // placeholder writes that keep the recorded paths pointing at real files used
  // to happen on the way out of a `TransientFailure`, which meant they landed
  // on top of what the provider had actually said, on every failing attempt.
  test('a refused answer keeps the output that produced it', async () => {
    await withBatch(1, async ({ store, options }) => {
      let seen = 0;
      await runAgentBatch<Ticket, Verdict>({
        ...options,
        provider: NOISY_PROVIDER,
        maxAttempts: 2,
        commit: async (ticket) => {
          seen++;
          if (seen === 1) throw new TransientFailure('invalid_shape', 'not what I asked for');
          store.settleRow(ticket.rowNumber);
          return 'answered';
        },
      });

      assert.equal(store.attempts.size, 2, 'the row was refused once and settled once');
      for (const attempt of store.attempts.values()) {
        const paths = attempt.paths;
        assert.ok(paths, 'every attempt records where its evidence went');
        assert.equal(
          readFileSync(paths.stdoutPath, 'utf8'),
          NOISY_STDOUT,
          'the refused attempt keeps its stdout',
        );
        assert.equal(
          readFileSync(paths.stderrPath, 'utf8'),
          NOISY_STDERR,
          'the refused attempt keeps its stderr',
        );
      }
    });
  });

  test('a row settled without a provider never reaches one', async () => {
    await withBatch(3, async ({ options }) => {
      const before = invocations;
      const events: RunEvent<Verdict>[] = [];
      const summary = await runAgentBatch<Ticket, Verdict>({
        ...options,
        onEvent: (event) => events.push(event),
        settleWithoutProvider: async (ticket) =>
          ticket.rowNumber === 2 ? ('answered' as const) : null,
      });
      assert.deepEqual(summary, { settled: { answered: 2, escalated: 1 }, failed: 0 });
      assert.equal(invocations - before, 2, 'one of the three rows skipped the provider');
      const settled = events.filter((e) => e.kind === 'row-settled');
      assert.equal(settled.filter((e) => e.precomputed).length, 1);
    });
  });

  test('an exhausted row is failed through the caller, not by the store', async () => {
    await withBatch(1, async ({ store, options }) => {
      const failures: string[] = [];
      const summary = await runAgentBatch<Ticket, Verdict>({
        ...options,
        maxAttempts: 2,
        fail: async (ticket, failure) => {
          failures.push(`${ticket.identifier}: ${failure.reason} @${failure.attemptNumber}`);
          store.failRow(ticket.rowNumber);
        },
        commit: async () => {
          throw new TransientFailure('timeout', 'too slow', 124);
        },
      });
      // The runner counts the failure and reports why; what a failed row looks
      // like is the caller's to decide, and the reason arrives already formatted
      // as `category: message` so two lifecycles record it the same way.
      assert.deepEqual(summary, { settled: {}, failed: 1 });
      assert.deepEqual(failures, ['TICKET-1: timeout: too slow @2']);
      assert.equal(store.claimedCount(), 0, 'nothing is left claimed');
    });
  });
});
