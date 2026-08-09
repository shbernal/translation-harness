# AGENTS.md

Session-start briefing for AI coding agents. Human usage lives in `README.md`;
the architecture and the invariants live in [`docs/`](docs/index.md). This file
is only what you need before you touch anything.

## What this project is

A library that harnesses non-interactive coding-agent CLIs (Codex, Claude) as
translation workers over a large structured corpus. One row is one subprocess
answering a JSON contract; a store tracks every row, so a pass resumes cleanly
after an interruption, pauses on quota, and retries on transient failure.

There are **two lifecycles over one runner**: translation produces a rendering,
review judges an existing one and proposes rather than mutates. They share
`src/batch/`, the store contract and the provider layer, and they are siblings -
neither imports the other. A review run's id is derived from every input it was
given, which is the property most of `src/review/` exists to protect.

The library does not translate and it does not know where rows come from. The
host supplies the records, the prompt template, the validators and the language
pair. What is published is the *mechanism*; the judgement stays with the caller.

## Environment

Node >= 24, non-negotiable: the shipped store uses the built-in `node:sqlite`.
ESM only. Package manager is pnpm, pinned via `packageManager`.

```powershell
pnpm check                      # typecheck + lint + test (the done gate)
pnpm build                      # emit dist/ (.js + .d.ts)
node examples/minimal/run.ts    # the whole translate loop, offline, about a second
node examples/review/cli.ts     # the review lifecycle, verb by verb; start with `help`
```

Run the example when you have changed anything on the path from a job to a
committed row. It exercises more of the library end to end than any single test
and it costs nothing. The review CLI is the same gate for the review half:
`translate`, `init`, `init` again, `review --limit 3`, `review`. The second
`init` must report the same run id and `created: false`, and it must be the same
id on a machine that has never run it, because nothing machine-local is one of
the id's inputs.

The source tree runs directly under Node's type stripping, which is why
`erasableSyntaxOnly` is on and why relative imports keep their `.ts` extension.
`rewriteRelativeImportExtensions` turns them into `.js` on the way into `dist/`.

Two toolchain facts that look like bugs and are not:

- **The emitted `.d.ts` files still say `.ts` in their relative specifiers.**
  That is correct - TypeScript resolves them to the adjacent declarations, and
  a consumer on 5.8 compiles against them cleanly. Do not "fix" it.
- **TypeScript 7 publishes no compiler JS API**, only `version` and
  `versionMajorMinor`. Nothing here may plan on `ts.preProcessFile` or
  `createSourceFile`; `test/layering.test.ts` carries its own import scanner
  for exactly this reason.

## Rules that must not be broken

These are the ones an agent can violate in the first five minutes. Everything
else is in `docs/`.

- **Never write tests that make live model calls.** The mock provider runs the
  whole loop offline and deterministically. A test that spawns a real CLI is a
  test that fails in CI and costs money.
- **`test/fixtures/` is immutable upstream material.** Do not edit it, do not
  reformat it, do not let a lint autofix touch it. Each fixture is a third-party
  work redistributed under its own license, and its bytes are what the
  guardrail calibration is measured against. Biome and the em-dash check both
  exclude it on purpose.
- **No em dashes (U+2014)** in source, docs or prompts. Use a hyphen or
  restructure. `scripts/check-no-emdash.ts` enforces it.
- **Imports only ever point down the layer stack.** `provider/` and `batch/` know
  nothing about translation, `store/` knows nothing about providers, and nothing
  imports `index.ts`. The exact table is in
  [docs/architecture.md](docs/architecture.md) and it is enforced by
  `test/layering.test.ts`, which fails on any edge the table does not allow and
  on any file that maps to no layer at all. If you need a new edge, change the
  table in the test and say why in the commit; do not route around it.
- **The library must not own stdout or install process handlers.** Progress goes
  through the caller's `onEvent`; cancellation comes in as an `AbortSignal`.
  A `console.log` or a `process.on('SIGINT')` in `src/` is a defect.
- **Each row settles in its own store transaction.** Preserve that isolation or
  resume, quota-pause and worker-pool semantics all break.
- **Changing a `SCHEMA` is three edits, not one.** Bump the version, and add a
  step to the matching plan that takes an existing file from the old version to
  the new one. Shipping the DDL alone means every registry with real rows in it
  stops opening, with no way forward. There are two halves and they are stamped
  and migrated separately: `SCHEMA` / `SCHEMA_VERSION` / `REGISTRY_MIGRATIONS`
  for the translate tables, and `REVIEW_SCHEMA` / `REVIEW_SCHEMA_VERSION` /
  `REVIEW_MIGRATIONS` in `src/store/review.ts` for the review ones. See
  [docs/architecture.md](docs/architecture.md#migration).
- **Nothing may be awaited between a successful `tryClaim` and the two lines
  that record the row locally.** A row claimed in the registry but missing from
  the run's own list is never released, sits in `running`, and is invisible to
  every selection filter. There is a comment at the call site saying so, because
  those two lines look exactly like something worth tidying.

## If a run ever hits a quota wall, capture it

`isQuotaError` decides a refusal is a quota refusal by matching `usage limit`,
`rate limit` and `session limit` against the provider's text, and those three
strings are ours rather than any provider's: no run has hit a quota wall since
they were written. The four cases under `test/fixtures/recorded/` cover success,
a fenced envelope and an untrusted-cwd refusal. A quota refusal is not among
them, and forcing one is not worth what it costs.

So this is opportunistic and standing: **the next time any run hits a quota
wall, capture the raw stderr, stdout and exit code before doing anything else**,
including before retrying. The moment does not come back. Scrub it before it
lands, because scrubbing happens at capture time and is not re-runnable, then
add it as a directory under `test/fixtures/recorded/` with the `meta.json` the
others carry. Nothing needs a test change: `recordedCases()` discovers the
directory, and the secret scan in `test/provider-recorded.test.ts` is what
catches an unscrubbed capture. That turns `isQuotaError` from a guess into a
measured claim. See [docs/providers.md](docs/providers.md).

## Where the documentation is

Read the page that owns the subject *before* changing the code, not after.

| About to touch | Read |
|---|---|
| `src/provider/**`, or anything about what a row costs | [docs/providers.md](docs/providers.md) |
| `src/contract/prompt.ts`, `src/contract/schema.ts`, `src/job.ts` | [docs/contract.md](docs/contract.md) |
| `src/glossary.ts`, `src/contract/glossary.ts` | [docs/contract.md](docs/contract.md) and [docs/review.md](docs/review.md) - one termbase, bound by each lifecycle |
| `src/contract/validate.ts`, a validator, or a threshold | [docs/guardrails.md](docs/guardrails.md) |
| `src/review/**`, the reviewer prompt or schema, the severity and confidence scales | [docs/review.md](docs/review.md) |
| `src/pipeline/**`, resume, concurrency or quota semantics | [docs/pipeline.md](docs/pipeline.md) |
| `src/batch/**`, the pool, the claim or the retry ladder itself | [docs/batch.md](docs/batch.md) |
| `src/store/**`, implementing a store, the review half, or a schema and its migrations | [docs/architecture.md](docs/architecture.md) |
| The layer boundaries, or adding a directory under `src/` | [docs/architecture.md](docs/architecture.md) |
| `test/fixtures/`, or contributing one | [test/fixtures/README.md](test/fixtures/README.md), [CONTRIBUTING.md](CONTRIBUTING.md) |

[docs/index.md](docs/index.md) is the map, and it also states what belongs in
`docs/` and what belongs in a commit message.

## Conventions

- Strict TypeScript, ESM, `node:` builtins, small pure functions, explicit SQL
  with parameters, no ORM. Match the surrounding style.
- **Published, and staying 0.x.** There is no 1.0 criterion and no deprecation
  policy: break what needs breaking, in a minor version, with a CHANGELOG entry
  saying so. What that does not license is breaking something quietly.
  `runAgentBatch`, `BatchStore` and `batchConformance` are a subpath export with
  a consumer behind them, so a change there is felt even though nothing forbids
  it.
- Run `pnpm check` before finishing. Add tests for new validation or contract
  logic.
- When you learn something durable - an invariant, a measured property, a
  decision with a reason - write it into the `docs/` page that owns the subject.
  Run counts, step ordering and what you tried before it worked belong in the
  commit message, not in a doc.
