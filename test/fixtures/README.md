# Test fixtures

**This directory is immutable upstream material.** Do not edit it, do not
reformat it, and do not let a lint autofix touch it. Biome excludes it via
`files.includes`, and `scripts/check-no-emdash.ts` skips it, both on purpose.

## Why the bytes matter

The library ships generic guardrails with numeric thresholds (a combined length
ratio, bracket and placeholder counting). Those numbers are a claim about how
translated text behaves, and the only honest form of that claim is "measured
over these pairs". The fixtures are the measurement. Change a byte and the
calibration is measuring something else.

## Licensing

The MIT license at the repository root covers this repository's **code**. It
does not cover anything in here.

Every fixture is a third-party work redistributed under its own terms. Each
fixture directory carries:

- the material itself, unmodified;
- `LICENSE` (or `COPYING`), the full upstream license text; and
- `SOURCE.md`, recording where it came from, which version or revision, the
  license identifier, and the attribution the license requires.

A fixture with no license permitting redistribution does not belong here, no
matter how convenient the text is. Reusing a fixture elsewhere means honouring
the license that ships beside it, not this repository's.

## Languages

Fixtures use pairs drawn from Spanish, French, Italian, English and German.

That list is a **reviewability constraint, not a coverage target**: it is the
set of languages the maintainer reads, so it is the set whose content can be
checked rather than taken on trust. No source needs more than one pair, there
is no obligation to cover every pair or every language, and a fixture in a
language nobody here reads is worse than no fixture, because nobody can tell
when it is wrong.

Contributions from native speakers, in these languages or others, are exactly
what lifts the constraint and are actively wanted. See `CONTRIBUTING.md`.

## Contents

Nothing yet. The corpus selection is still open.
