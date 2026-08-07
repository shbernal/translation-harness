# Contributing

Short version: `pnpm install`, then `pnpm check` before you finish. It runs the
typecheck, Biome, the em-dash guard and the whole test suite.

**Never write a test that makes a live model call.** `registerMockProvider()`
runs the entire loop offline and deterministically, and the provider tests drive
a stand-in CLI on `PATH` rather than a real one. A test that spawns a real agent
is a test that fails in CI and costs money.

## What this project most needs from outside

Fixtures, and language expertise.

The generic guardrails carry numeric thresholds, and those thresholds are a
claim about how translated text behaves. Right now that claim rests on the
language pairs the maintainer can read: Spanish, French, Italian, English and
German. That is not a judgement about which languages matter, it is the honest
limit of what one person can verify. A fixture in a language nobody here reads
is a fixture nobody can tell is wrong, which is worse than not having it.

So the contributions that move the project furthest are the ones that lift that
limit.

### A parallel fixture

What it must carry, in its own directory under `test/fixtures/`:

- **The material, unmodified.** Aligned source and translation, with matching
  identifiers so a row on one side can be paired with its row on the other.
- **`LICENSE`** (or `COPYING`): the full upstream license text. It must permit
  redistribution. This repository's MIT license covers its code and does not
  relicense your fixture; convenience is not a substitute for permission.
- **`SOURCE.md`**: where it came from, which version or revision, the license
  identifier, and whatever attribution that license requires.

Two things to know before you open the PR:

- **You are vouching for the alignment.** Nobody else can check it, which is the
  entire premise. Say in the PR how you verified that row N on one side really
  is row N on the other.
- **`test/fixtures/` is never reformatted or edited.** Biome and the em-dash
  guard both exclude it. The bytes are the measurement; a whitespace tidy-up
  changes what the calibration is measuring.

The calibration test discovers its language pairs from the corpus, so adding a
fixture is a data change and not a test change.

See [`test/fixtures/README.md`](test/fixtures/README.md) for the full detail.

### A threshold correction

If a language pair routinely trips a bound, that is a finding and the number
should move. Bring the pair, the fixture, and the distribution you observed. The
defaults were measured over one pair of one corpus of long-form technical prose;
every other pair is unmeasured, and unmeasured is not the same as fine.

### A validator for a language's conventions

Something the generic checks cannot express. Keep the mechanism generic and the
language-specific table a parameter, the way `modalForceShiftsFor` takes its
level table and `missingReferences` takes its pattern. The mechanism is shared;
which words mark which level is a judgement about one language pair.

## Code

- Strict TypeScript, ESM, `node:` builtins, small pure functions, explicit SQL
  with parameters, no ORM. Match the surrounding style.
- **Imports only ever point down the layer stack.** The table is in
  [docs/architecture.md](docs/architecture.md) and `test/layering.test.ts`
  enforces it. If you need a new edge, change the table in the test and say why
  in the commit; do not route around it.
- **No em dashes (U+2014)** in source, docs or prompts.
- The library must not own stdout or install process handlers. Progress goes
  through `onEvent`; cancellation arrives as an `AbortSignal`.
- When you learn something durable, write it into the `docs/` page that owns the
  subject. What you tried before it worked belongs in the commit message.
