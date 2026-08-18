---
read_when: changing src/pipeline/**, or reasoning about resume, concurrency or quota
---

# The run loop

`runTranslation(store, job, candidates, options)`. It returns a summary and
throws only on a non-transient error.

Everything on this page except the guardrails and the prompt is `runAgentBatch`'s
doing: the loop lives in `src/batch/` and knows nothing about translation, and
`runTranslation` is that function plus the four callbacks that make it a
translation pass. Read [batch.md](batch.md) if you are changing the loop itself,
or if you want to drive an agent over rows that are not translations. This page
describes what a translation pass does, which is what almost everybody wants.

## Resume is the whole design

Every row settles in its own store transaction. There is no batch commit, no
end-of-run write, and no state held only in memory that a kill would lose. A run
that stops for any reason leaves a registry that a later run reads and continues
from, and `selectCandidates({})` returns exactly what is left.

The corollary is that **a row must never be left claimed**. A `running` row is
invisible to every selection filter (`selectCandidates` excludes it on purpose,
because a live pass owns it), so a stranded claim means a resume skips that row
silently until `reclaimStale`'s cutoff passes. That is a corpus with a hole in
it and no error anywhere to say so.

Two mechanisms guard it:

1. Every ordinary path settles its row.
2. The run tracks every row it ever claimed and sweeps them at the end, whatever
   path it took out. Normally this releases nothing. It is the guarantee, not
   the mechanism.

`reclaimStale` is the third line of defence, for a process that was killed
rather than stopped. `releaseSettledRunClaims` is the sharper version of it for
the case where the killed run did manage to record that it ended: it releases
that run's rows immediately rather than waiting out a cutoff meant for processes
that might still be alive. Both are host-invoked; neither runs on its own.

## Claiming

`tryClaim` moves a row to `running` and returns it, or returns `null` because
somebody else got there first. The claim and the test are one statement, so two
workers, or two processes against the same registry, cannot both come away
believing they own the row.

Losing the race is an ordinary outcome under concurrency, not an error, which is
why it is a `null` and not a rejection. A throw would make the common case look
exceptional. The worker skips the row and takes the next.

## Concurrency

`concurrency` workers pull from one shared cursor. At 1 it behaves exactly like
the serial flow, so nothing changes for anyone who does not ask.

The only place a worker yields is the provider call. Everything else is
bookkeeping, so the pool's benefit is exactly the subprocess latency it hides.

`concurrency: 1` and `concurrency: 6` reach the same corpus state; that is
asserted, because the pool is meant to change throughput and not results.

## `delaySeconds` is per worker

It paces one provider conversation. At concurrency N the effective rate is
roughly `N / (avgLatency + delay)`.

It is deliberately not repurposed as a global rate limit. That would be a
different knob wearing the same name, and a run tuned at concurrency 1 would
silently change meaning the moment somebody raised the pool.

A precomputed row skips the delay entirely: the delay paces a provider, and none
was called.

**It is charged once per row, which is invisible until the rows are cheap.** A
pass that waits on a real agent hides it inside the latency it is pacing; the
same delay over a mock provider is the entire run time, and 2 seconds across
2,125 rows at concurrency 4 is 18 minutes of a pass that makes no network calls
at all. A whole-corpus offline pass that looks hung is usually this. Set
`delaySeconds: 0` when there is no conversation to pace - neither it nor
`concurrency` is an input to any hash, so the run is the same run either way.

## Retries and quota

A `TransientFailure` retries up to `maxAttempts`, with
`min(30s, 2^(n-1)s + jitter)` between attempts. Every attempt gets its own row
in the registry and its own files on disk, so the history of a difficult row is
readable afterwards.

**A `quota` failure does not retry.** It fails that one row, records why, and
sets the whole run to stop pulling. Workers already mid-row still commit their
answers, which is work already paid for, and the run finishes as `paused_quota`.

Retrying a quota refusal buys the same refusal at the same price, once per row,
until the allowance is gone. One row pays for the discovery and the rest are
left untouched for the next run.

## The three reasons to stop

| Reason | Trigger | Run status | Rows in flight |
|---|---|---|---|
| `interrupted` | the caller's `AbortSignal` | `interrupted` | finish |
| `paused` | a `quota` failure | `paused_quota` | finish |
| `fatal` | a non-transient error | `failed` | drain, then recorded failed |

The fatal path snapshots **the rows that run owned** and fails only those.
"Every row in `running`" would also fail the rows a concurrent worker or a
second process happens to hold, which is how one broken run takes down another.
Recording is deferred until the pool has drained, so it cannot clobber the
in-progress attempts of workers about to finish their rows perfectly well.

## Cancellation is a signal, not a handler

```ts
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

await runTranslation(store, job, candidates, { signal: controller.signal, ... });
```

A library installing a process-wide signal handler is wrong even if it removes
it afterwards, so wiring it is yours, and it is two lines. A signal that is
already aborted stops the run before it claims anything.

## Progress is events, not output

The runner owns no output stream. `onEvent` receives:

| Event | When |
|---|---|
| `row-settled` | a row reached `succeeded`, `review_required` or `failed` |
| `row-retrying` | between attempts, with the category and the wait |
| `quota-paused` | the batch is stopping for quota |
| `rows-released` | the final sweep actually released something |

`completed` is a **settled count, not a cursor position**. With workers, rows
settle out of order, and a position number would claim progress the run has not
made.

A run with no `onEvent` is exactly as valid; it is simply silent.

## Precomputed rows

`job.precomputed(source)` returns translations to commit, or `null` to send the
row to a provider as usual. A row it answers costs no subprocess and writes no
attempt row, because `attempts` means "one provider invocation with its retained
output" and a synthetic entry with empty logs would misreport that.

It still goes through `validateResponse`, so it clears the same structural and
job-specific guardrails a model answer would. The row records its model as
`precomputed`, which is what keeps it auditable afterwards.

Keep the predicate exact: match the whole source value, not a prefix, so a row
that merely resembles the pattern still reaches the model.

## Evidence

Per attempt, under `<workDir>/attempts/<runId>/`:

```
00042_AC-2_a03.response.json
00042_AC-2_a03.stdout.log
00042_AC-2_a03.stderr.log
```

The registry records where. `sqliteStore`'s `pathBase` relativizes them, because
absolute paths leak the machine that produced them into a file somebody may well
commit.

The store allocates the attempt number, and the file names embed it, so paths
are recorded in a second write. Between the two the attempt row has null paths,
which is honest: the files do not exist yet either.

**A refused answer keeps its evidence**, which is the case a reader wants it
for. Validation refusing an answer is a `TransientFailure`, the same channel a
timeout uses, and the attempt that produced it keeps the provider's stdout and
stderr alongside the `.response.json` it was judging. The two log files are
created empty as soon as their paths are recorded, so an attempt that dies
before the provider answers still resolves to files somebody can open; they are
never written empty afterwards.
