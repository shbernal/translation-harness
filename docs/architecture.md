---
read_when: changing anything under src/, adding a directory, or implementing a store
---

# Architecture

Three ideas, in the order they matter.

1. **A job is data.** A language pair, a set of fields, a prompt and some
   validators. The engine is written once against `TranslationJob` and knows
   nothing about where rows come from.
2. **A row is a subprocess.** One non-interactive agent CLI call, answering a
   generated JSON schema, with its output retained as evidence.
3. **A run is resumable.** Every row is claimed, settled and committed on its
   own, so an interrupted run resumes exactly where it stopped.

## The layers

Each layer may import **only** the layers listed, and nothing else inside
`src/`. Anything not listed is a violation whichever direction it points.

| Layer | Files | May import |
|---|---|---|
| `errors` | `src/errors.ts` | nothing |
| `provider` | `src/provider/**` | `errors` |
| `job` | `src/job.ts` | `errors` |
| `contract` | `src/contract/**` | `errors`, `job`, `provider` |
| `store` | `src/store/**` | `errors`, `job` |
| `pipeline` | `src/pipeline/**` | `errors`, `job`, `provider`, `contract`, `store` |
| `index` | `src/index.ts` | all of them; nothing imports it |

A layer may always import itself. Three edges are worth stating out loud:

- **`contract` may import `provider`.** The offline mock registers itself and
  needs the invoker types. It lives in `contract/` because it parses the prompt
  payload, which is translation knowledge the provider layer must not have.
- **`store` may not import `provider`.** The registry records a provider *name*
  and a model id, as strings. If a store method ever wants a provider type, that
  is a design change and it should cost an edit to this table.
- **`provider` may not import `job`.** This is the edge most likely to be
  crossed by accident, because `job.ts` sits at the root next to `errors.ts` and
  looks equally neutral. It is not: it is where translation is defined.

### Why this is a test and not a paragraph

`test/layering.test.ts` reads the table as data, walks every relative import
under `src/`, and fails on any edge the table forbids, on any import that does
not resolve, and on any file belonging to no declared layer at all. That last
assertion is what stops somebody adding `src/util/` and silently opting it out.

It matters to you, not just to us, for one concrete reason: it is why
`translation-harness/providers` can be **depended on** as a domain-free layer
rather than merely described as one. If a future release quietly imported
translation types into the provider layer, that subpath would stop being what it
claims, and CI would not notice without this. A provider contributed from
outside is held to the same rule by the same check, rather than by an opinion in
review.

The rule was worth mechanizing because review demonstrably does not enforce it:
the private codebase this was extracted from broke exactly this boundary once,
silently, with one attentive author reading it daily.

## The run loop

```
selectCandidates  ->  for each row, one worker:
                        tryClaim            (atomic; a lost claim is not an error)
                        precomputed?        -> commit, no subprocess
                        buildPrompt
                        startAttempt        (store allocates the attempt number)
                        setAttemptPaths
                        invokeProvider      (the only place a worker yields)
                        validateResponse
                        commitSuccess       (one transaction, this row only)
                      unclaim(everything ever claimed)
                      finishRun(why it stopped)
```

### Three reasons to stop, each ending the run differently

- **interrupted** - the caller aborted. Workers stop pulling; rows in flight
  finish, because they are work already paid for.
- **paused** - a quota refusal. The same, and the run records `paused_quota`.
- **fatal** - a non-transient error. The pool drains, the rows *that run owned*
  are recorded failed, and the error is rethrown to the caller.

The fatal case snapshots the rows it owned rather than failing every row in
`running`, because with workers, or a second process against the same registry,
"every running row" is somebody else's rows too.

### The one rule a refactor can break silently

Between a successful `tryClaim` and the two lines that record the row locally,
**nothing may be awaited**. A row claimed in the registry but missing from the
run's own list is a row the final sweep will never release: it sits in
`running`, invisible to every selection filter, until `reclaimStale`'s cutoff
passes. There is a shouted comment at the call site because the two lines look
like exactly the kind of thing somebody tidies up later.

This is the cost of the store being asynchronous. The synchronous version could
argue that nothing interleaves, because `node:sqlite` is synchronous and the
runtime single-threaded. That argument is void here, and what replaces it is
contract term 2 below.

## The store seam

`TranslationStore` is an interface with exactly one shipped implementation,
`sqliteStore`. The interface exists so the runner never names SQLite, not so
that we maintain a Postgres backend.

It is **asynchronous** although `sqliteStore` is not. A synchronous interface is
the honest shape of `node:sqlite` and cheaper to write, but it can only ever be
implemented by a synchronous store: no Postgres, no network-backed registry, no
SQLite behind a worker thread. Those are exactly the consumers the seam exists
for, and it is the direction that cannot be widened later without breaking
everyone.

### The six contract terms

Signatures do not tell an implementer what to guarantee. These do, and
`storeConformance` checks every one.

1. **Every method is its own transaction.** The runner never needs atomicity
   spanning two calls, so no method may leave a partial write visible and none
   may require a surrounding transaction.
2. **`tryClaim` is atomic against other processes,** not merely against other
   workers in this one. It returns a given row to at most one caller, ever.
   Everything else rests on this, and it is the one term a lazy implementation
   breaks invisibly: the symptom is two workers translating the same row and the
   second silently overwriting the first.
3. **Store failures are not translation failures.** A rejected store call is a
   fatal run error. Never raise `TransientFailure` from a store method, or the
   runner will retry the row, and a row does not become translatable because you
   tried it again after the disk filled up.
4. **`recordInternalError` may itself fail,** since the store is very often what
   broke. The runner swallows its rejection so it cannot mask the original
   error, which means an implementation must not rely on it having succeeded.
5. **Paths handed to the store are absolute.** How they are recorded is the
   store's business; `sqliteStore` takes a `pathBase` and relativizes, because
   absolute paths in a registry leak the machine that produced them into a file
   somebody may well commit.
6. **`initialize` refuses to run when the registry holds a row absent from the
   supplied records.** This is the guard that turns silent corpus drift into an
   error. Without it a shrinking corpus quietly orphans finished work.

### Schema versions

`applySchema` stamps `PRAGMA user_version` and opening checks it. A registry
written by a different schema version is refused, loudly, naming both versions.
Refusing to open is a fine migration story for a young package; running new code
against an old registry and finding out from the data is not.

`initialize`'s guard covers corpus drift. It does not cover schema drift, which
is what the stamp is for.

### Where SQLite shows through

`sqliteStore(...).db` exposes the live `DatabaseSync`, on the concrete return
type only and never on `TranslationStore`, so a host can run its own DDL on the
same connection and keep its tables in the same transactional world. The
interface has to stay implementable by something with no such handle to give.

The consequence reaches consumers: `applySchema` names `node:sqlite` types in
the published declarations, so **Node 24 typings are needed to compile against
this package**, not merely to run it.

## Known limitation: stale claims from interrupted runs

Rows claimed by a run that is already recorded `interrupted` still wait out
`reclaimStale`'s full cutoff, 30 minutes by default. Under repeated kills the
stranded set therefore grows faster than it drains, and those rows are invisible
to every selection filter in the meantime.

`tryClaim` takes a run id and `items` carries the column, which is what makes
the fix an added query rather than a schema change: release the rows held by
runs already marked interrupted, without waiting on the clock. The parameter
went in during the first version precisely so that fix stays cheap.

Workaround today: `reclaimStale(0)` releases everything, so call it when you
know no run is live.
