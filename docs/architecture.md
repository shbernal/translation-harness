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
| `batch` | `src/batch/**` | `errors`, `provider` |
| `job` | `src/job.ts` | `errors` |
| `contract` | `src/contract/**` | `errors`, `job`, `provider` |
| `store` | `src/store/**` | `errors`, `job`, `batch` |
| `review` | `src/review/**` | `errors`, `job`, `store` |
| `pipeline` | `src/pipeline/**` | `errors`, `job`, `provider`, `batch`, `contract`, `store` |
| `index` | `src/index.ts` | all of them; nothing imports it |

A layer may always import itself. Five edges are worth stating out loud:

- **`contract` may import `provider`.** The offline mock registers itself and
  needs the invoker types. It lives in `contract/` because it parses the prompt
  payload, which is translation knowledge the provider layer must not have.
- **`store` may not import `provider`.** The registry records a provider *name*
  and a model id, as strings. If a store method ever wants a provider type, that
  is a design change and it should cost an edit to this table.
- **`provider` may not import `job`.** This is the edge most likely to be
  crossed by accident, because `job.ts` sits at the root next to `errors.ts` and
  looks equally neutral. It is not: it is where translation is defined.
- **`batch` may not import `job`, `contract` or `store`.** The batch runner is
  the pool, the claim, the retry ladder and the abort path, and it must not know
  what a row means; that is what `translation-harness/batch` promises. The edge
  it does have runs the other way: **`store` imports `batch`**, because
  `TranslationStore` extends `BatchStore`.
- **`review` may not import `pipeline`.** Translation and review are two
  lifecycles over the same runner, and they are siblings: a review that reached
  into `runTranslation` would be the first line of a third runner nobody decided
  to write. `review`'s allow-list is also deliberately the narrowest thing that
  compiles, and it grows one edge at a time, so each dependency the lifecycle
  takes on is a diff on this table rather than a licence granted in advance. It
  gained `store` when `initializeReview` landed, which is the direction
  `pipeline` already takes - a lifecycle names the seam it writes through. **The
  reverse edge is the one to watch: `store` must not import `review`**, or the
  SQLite implementation and the lifecycle it stores stop being two things.

### Why this is a test and not a paragraph

`test/layering.test.ts` reads the table as data, walks every relative import
under `src/`, and fails on any edge the table forbids, on any import that does
not resolve, and on any file belonging to no declared layer at all. That last
assertion is what stops somebody adding `src/util/` and silently opting it out.

It matters to you, not just to us, for one concrete reason: it is why
`translation-harness/providers` and `translation-harness/batch` can be
**depended on** as domain-free layers rather than merely described as ones. If a
future release quietly imported translation types into either, that subpath would
stop being what it claims, and CI would not notice without this. A provider
contributed from outside is held to the same rule by the same check, rather than
by an opinion in review.

The rule was worth mechanizing because review demonstrably does not enforce it:
the private codebase this was extracted from broke exactly this boundary once,
silently, with one attentive author reading it daily.

## The run loop

The loop itself is `runAgentBatch` in `src/batch/`, and it knows nothing about
translation: four callbacks supply the prompt, the answer that is acceptable, what
committing one means and what failing one means. `runTranslation` is that function
plus those four callbacks, and its exported signature has not changed.
`docs/batch.md` covers the layer on its own terms. What follows is the loop as a
translation pass experiences it.

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
`running`, invisible to every selection filter, and this run will not come back
to it. Only a later, host-invoked sweep frees it. There is a shouted comment at
the call site because the two lines look
like exactly the kind of thing somebody tidies up later.

This is the cost of the store being asynchronous. The synchronous version could
argue that nothing interleaves, because `node:sqlite` is synchronous and the
runtime single-threaded. That argument is void here, and what replaces it is
contract term 2 below.

## What the library refuses to know

Two omissions look like oversights and are both deliberate, so they are written
down here rather than rediscovered as bugs.

**`TranslationJob.sourceLang` is a free `string`, not a union.** The project
this was extracted from closes it to `'English' | 'German'`, and is right to: it
has language-specific tables - term folding, determiner handling,
orthotypography - and a typo there silently selects the wrong one. The library
has no such tables, so it has nothing to be wrong about, and closing the union
here would only stop somebody translating a language nobody thought to add. If
*you* have those tables, close it in your own code. Do not close it here.

**`SourceRecord` says nothing about where a row came from.** No workbook path,
no sheet name, no column index. That single assumption is what made the engine
unpublishable in the first place: an engine that reads column D of a spreadsheet
is a spreadsheet tool. The host reads its own rows and hands them over, and the
one thing the library asks is that `rowNumber` is stable across re-reads,
because it is the primary key everything else hangs off.

## The store seam

`TranslationStore` is an interface with exactly one shipped implementation,
`sqliteStore`. The interface exists so the runner never names SQLite, not so
that we maintain a Postgres backend.

It is two interfaces now, split where the runner was generalized.
**`BatchStore`** is what a claim-and-retry pool needs - `tryClaim`, `unclaim`,
`reclaimStale`, `releaseSettledRunClaims`, the run and attempt bookkeeping, and
`close` - and it knows a row only as a row number and an identifier.
**`TranslationStore extends BatchStore<Item>`** adds the translation lifecycle:
`initialize`, `counts`, `selectCandidates`, `commitSuccess`, `commitPrecomputed`,
`markItemFailed`, `translationsByIdentifier`. Nothing was removed and nothing
changed shape, so a 0.1 implementation is still a valid one; it simply gained a
supertype.

The split is not tidiness. It is what lets a second lifecycle *inherit* the
guarantees below rather than re-earn them, and `batchConformance` is the
executable form of that: `storeConformance` runs the whole of it before its own
cases, so a translation store demonstrates the generic terms rather than
asserting them.

It is **asynchronous** although `sqliteStore` is not. A synchronous interface is
the honest shape of `node:sqlite` and cheaper to write, but it can only ever be
implemented by a synchronous store: no Postgres, no network-backed registry, no
SQLite behind a worker thread. Those are exactly the consumers the seam exists
for, and it is the direction that cannot be widened later without breaking
everyone.

### The six contract terms

Signatures do not tell an implementer what to guarantee. These do, and
`storeConformance` checks every one. **Terms 1 to 5 are `BatchStore`'s and term 6
is `TranslationStore`'s**, which is exactly the line the split was drawn on: five
of the six were never about translation. The numbering did not shift when the seam
split, so a comment naming "term 2" still names the same guarantee.

1. **Every method is its own transaction.** The runner never needs atomicity
   spanning two calls, so no method may leave a partial write visible and none
   may require a surrounding transaction.
2. **`tryClaim` is atomic against other processes,** not merely against other
   workers in this one. It returns a given row to at most one caller, ever.
   Everything else rests on this, and it is the one term a lazy implementation
   breaks invisibly: the symptom is two workers translating the same row and the
   second silently overwriting the first.
3. **Store failures are not row failures.** A rejected store call is a fatal run
   error. Never raise `TransientFailure` from a store method, or the runner will
   retry the row, and a row does not become translatable because you tried it
   again after the disk filled up.
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

`BatchStore` deliberately has no way to create a row and no way to count a claim,
because both are lifecycle knowledge. That makes the generic suite unable to set
itself up, so `batchConformance` asks the host for exactly those two capabilities
and nothing else. Widening the base interface to make its own tests easier would
have made the base interface a lie.

Two more terms belong to `ReviewStore`, numbered on from these rather than
restarting, because five of the six above are shared and two numbering schemes
over one contract is how "term 2" stops meaning anything.

7. **`createRun` writes a run and all of its rows in one transaction, and
   refuses to overwrite a run that exists.** Review init is idempotent by
   derivation, so a second call must return the first run rather than rebuild
   it. A partial run is worse than no run: it reports itself as already created
   and then reviews a corpus with a hole in it.
8. **Nothing in the review half writes to the translate half.** The reviewer
   proposes and a human adopts. A store that let a verdict reach `items` would
   turn an auditable proposal into a silent edit, which is the one property the
   review lifecycle exists to have.

### The review half

`sqliteStore(path).review(runId)` returns a `ReviewStore` on the same connection,
and calling it is how a host **opts in**: the review tables are created on the
first call and never by opening a registry, so a file belonging to someone who
only translates has no review half at all.

Two things about its shape are not arbitrary.

**A review store is scoped to one run.** In the translate half `items` outlive
runs, so a row number identifies a row. In the review half a row belongs to
exactly one run, so a row number identifies a row only once the run is fixed.
Binding the run at construction is what lets `rowNumber` stay the corpus row
number - the number a human reading a workbook will recognise - instead of
becoming a surrogate key nobody can look up. Reading a second run (which is what
chaining does) means a second store: `.review(baseRunId).snapshot()`.

**A review run is a job; a pass is an invocation.** `review_runs` is created once,
with a derived id and a frozen snapshot, and executed as many times as it takes.
So the run the batch layer opens and closes is not that one - it is a row in
`review_passes`, and `startRun`, `finishRun` and `tryClaim`'s run id all mean a
pass. Collapsing the two would cost both of the guarantees below this line:
`releaseSettledRunClaims` could never fire, because a job stays open across
exactly the crash that stranded its rows, and `reclaimStale` would read a job's
creation time as evidence about a live process and interrupt a healthy one.
`reclaimStale` therefore closes stale passes and leaves the run alone, which is
the one place the two halves deliberately differ.

### Schema versions

`applySchema` stamps `PRAGMA user_version` and opening checks it. A registry
written by a different schema version is refused, loudly, naming both versions.
That refusal is the default and stays the default: running new code against an
old registry and finding out from the data is the failure it prevents.

`initialize`'s guard covers corpus drift. It does not cover schema drift, which
is what the stamp is for.

**The two halves are stamped separately.** A file has exactly one
`user_version` and the translate half has it, so the review half keeps its
version in a `schema_versions` row instead (`tableStamp('review')` builds that
stamp, and a third half would be another row rather than another mechanism).
This is not a workaround for having run out of pragmas: a host who never reviews
must never be migrated for review, and two independent stamps are what makes
that enforceable rather than merely intended.

The review half's refusal fires later than the translate one, at
`.review(runId)` rather than at the open. That is deliberate. A file whose review
half is old still opens, still translates and still reports; only the code that
would misread the old review tables is stopped.

### Migration

`migrateRegistry(path)` is the other half of that refusal, and everything about
its shape follows from one fact: **the thing that fails is the open.**

- **It takes a path, not a store.** There is no store to hand in, because
  obtaining one is exactly what did not work.
- **It is never automatic.** An open that quietly migrated would turn a mistyped
  path into a rewritten database, and would hide the one moment where a backup is
  obviously worth taking inside a constructor.
- **Ask before you open.** `registryNeedsMigration(path)` answers the question
  the open would otherwise answer by throwing, so a host's error can name the
  migration and the command that runs it. `pendingMigrations(path)` returns the
  same answer with the steps in it, for a host that wants to say what is about to
  happen to a file.
- **It is synchronous**, unlike `TranslationStore`. That interface is async so a
  registry can live somewhere other than a local file; this is about a local
  file. A store backed by anything else migrates with its own host's tooling.

The order inside it is the interesting part. Every step's `refuse` hook runs
first, across every plan, so a file that cannot be migrated is left exactly as it
was and no copy is taken for a migration that never happens. Then the
write-ahead log is folded back into the file, so the copy taken next is the whole
registry rather than a prefix of it. Then each step applies inside its own
transaction and stamps its own version, so an interruption leaves the file at a
version some step produced rather than at a version nothing describes.

**Refuse rather than guess** is a first-class part of a step, not a convention. A
step that lets its DDL fail instead reports SQLite's message, which names neither
what the constraint meant nor what to do about it. The one shipped step refuses a
registry with repeated `(row_number, attempt_number)` pairs, because the new
schema declares that unique and the old allocation should have made it
impossible - so a file that has them needs a human, not a retry.

**Foreign keys are off for the whole of it**, and the file is checked once at the
end with `PRAGMA foreign_key_check`. A step that has to change a table's
declaration rather than add to it has to rebuild that table - make the new one,
copy, drop the old, rename - and dropping a table two others reference cannot be
done with the constraints live. Neither pragma that looks like a smaller fix
works: `foreign_keys` is a no-op inside a transaction, and `defer_foreign_keys`
counts the violations a drop causes and never re-checks them after the rename
puts the table back. This is the sequence SQLite's own rebuild procedure
prescribes, and the check at the end is what keeps it honest. A migration that
leaves a broken reference throws, naming the backup, because that is a defect in
a step rather than something a retry resolves.

It is not concurrency-safe and is not meant to be. Migrate a registry when
nothing is running against it, which for a file whose whole purpose is resuming
means between passes.

#### A plan is data

A `MigrationPlan` is a label, a target version, a `SchemaStamp`, an `isPresent`
probe and an ordered list of steps. `REGISTRY_MIGRATIONS` is the only one the
library ships and the only one `migrateRegistry` uses by default.

The stamp is part of the plan rather than fixed at `PRAGMA user_version`, and
that is what keeps a second independently versioned half of the file from
becoming a second migration mechanism. A file has exactly one `user_version`, so
anything added later that a host can decline to adopt cannot use it - and must
not, because a consumer who never uses a feature must never be migrated for it.
Hence the default of `[REGISTRY_MIGRATIONS]` alone: a half a host has not adopted
is not brought forward behind their back, and `isPresent` says the same thing
from the other side, since an absent half is created at the current version by
`applySchema` rather than migrated up from 0.

`REVIEW_MIGRATIONS` is the second plan and the first proof that this is a
mechanism rather than an intention. A host with review tables passes
`migrateRegistry(path, { plans: [REGISTRY_MIGRATIONS, REVIEW_MIGRATIONS] })`; a
host without them passes nothing and is untouched. Its one step rebuilds
`review_runs`, which is why the paragraph about foreign keys above exists.

### Where SQLite shows through

`sqliteStore(...).db` exposes the live `DatabaseSync`, on the concrete return
type only and never on `TranslationStore`, so a host can run its own DDL on the
same connection and keep its tables in the same transactional world. The
interface has to stay implementable by something with no such handle to give.

Two helpers come with it, `tx(db, fn)` and `parseFields(json)`, and they are
exported for a specific reason rather than for completeness: a host that has
been handed the connection will otherwise reimplement both beside ours, and then
the two halves of one database can disagree about what a transaction covers and
about what a null `*_json` column means. If you are running your own tables
here, use these.

Your own tables mean your own row types. The registry's `Item` is deliberately
camelCase with `source` already parsed; if you query `items` yourself, declare
the column shape you are selecting locally rather than expecting the library to
publish its DDL as a type.

The consequence reaches consumers: `applySchema` names `node:sqlite` types in
the published declarations, so **Node 24 typings are needed to compile against
this package**, not merely to run it.

## Releasing stale claims without waiting on a clock

`reclaimStale` needs a cutoff because it cannot tell a dead process from a slow
one. When the run holding a row is recorded as anything other than `running`,
that question is already settled: `finishRun` is called after every worker has
returned, so an ended run has nothing in flight and any row it still holds is
stranded. `releaseSettledRunClaims()` releases exactly those, immediately, and
closes their dangling attempts the same way `reclaimStale` does.

It matters most under repeated kills, where the version of this that waited out a
30-minute cutoff let the stranded set grow faster than it drained - and a
stranded `running` row is invisible to every selection filter in the meantime,
so a resume skips it silently.

Rows claimed with no `run_id` are deliberately left to `reclaimStale`: they
predate the column, so there is no run to ask about them.

The reason this is a query and not a schema change is that `tryClaim` takes a run
id and `items` carries the column. Both went in before there was a caller for
them.
