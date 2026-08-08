# AGENTS.md

Session-start briefing for AI coding agents. Human usage lives in `README.md`;
the architecture and the invariants live in [`docs/`](docs/index.md). This file
is only what you need before you touch anything.

## What this project is

A library that harnesses non-interactive coding-agent CLIs (Codex, Claude) as
translation workers over a large structured corpus. One row is one subprocess
answering a JSON contract; a store tracks every row, so a pass resumes cleanly
after an interruption, pauses on quota, and retries on transient failure.

The library does not translate and it does not know where rows come from. The
host supplies the records, the prompt template, the validators and the language
pair. What is published is the *mechanism*; the judgement stays with the caller.

## Environment

Node >= 24, non-negotiable: the shipped store uses the built-in `node:sqlite`.
ESM only. Package manager is pnpm, pinned via `packageManager`.

```powershell
pnpm check                      # typecheck + lint + test (the done gate)
pnpm build                      # emit dist/ (.js + .d.ts)
node examples/minimal/run.ts    # the whole loop, offline, in about a second
```

Run the example when you have changed anything on the path from a job to a
committed row. It exercises more of the library end to end than any single test
and it costs nothing.

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
- **Nothing may be awaited between a successful `tryClaim` and the two lines
  that record the row locally.** A row claimed in the registry but missing from
  the run's own list is never released, sits in `running`, and is invisible to
  every selection filter. There is a comment at the call site saying so, because
  those two lines look exactly like something worth tidying.

## Where the documentation is

Read the page that owns the subject *before* changing the code, not after.

| About to touch | Read |
|---|---|
| `src/provider/**`, or anything about what a row costs | [docs/providers.md](docs/providers.md) |
| `src/contract/prompt.ts`, `src/contract/schema.ts`, `src/job.ts` | [docs/contract.md](docs/contract.md) |
| `src/contract/validate.ts`, a validator, or a threshold | [docs/guardrails.md](docs/guardrails.md) |
| `src/pipeline/**`, resume, concurrency or quota semantics | [docs/pipeline.md](docs/pipeline.md) |
| `src/batch/**`, the pool, the claim or the retry ladder itself | [docs/batch.md](docs/batch.md) |
| `src/store/**`, or implementing a store | [docs/architecture.md](docs/architecture.md) |
| The layer boundaries, or adding a directory under `src/` | [docs/architecture.md](docs/architecture.md) |
| `test/fixtures/`, or contributing one | [test/fixtures/README.md](test/fixtures/README.md), [CONTRIBUTING.md](CONTRIBUTING.md) |

[docs/index.md](docs/index.md) is the map, and it also states what belongs in
`docs/` and what belongs in a commit message.

## Conventions

- Strict TypeScript, ESM, `node:` builtins, small pure functions, explicit SQL
  with parameters, no ORM. Match the surrounding style.
- This package has no GitHub release yet. There is no backwards-compatibility
  obligation and no deference to prior architecture unless the owner asks for
  it. Once it is released that changes and breaking changes need evaluating.
- Run `pnpm check` before finishing. Add tests for new validation or contract
  logic.
- When you learn something durable - an invariant, a measured property, a
  decision with a reason - write it into the `docs/` page that owns the subject.
  Run counts, step ordering and what you tried before it worked belong in the
  commit message, not in a doc.
