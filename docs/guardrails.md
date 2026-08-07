---
read_when: changing src/contract/validate.ts, writing a validator, or tuning thresholds
---

# Guardrails

Two kinds of problem, handled differently on purpose. Getting the split wrong in
either direction is expensive: treating a content concern as a failure burns the
attempt budget on rows that are fine, and treating a structural problem as a
concern stores something that is not a translation.

## Hard: structural problems raise

These mean the answer is not usable. They raise `TransientFailure`, the attempt
is recorded failed, and the row retries with bounded exponential backoff
(`min(30s, 2^(n-1)s + jitter)`).

| Category | What happened |
|---|---|
| `invalid_shape` | Not an object, a missing top-level key, `warnings` not an array of strings, or a non-empty source field answered with something that is not a non-empty string |
| `identifier_mismatch` | The model answered about a different row |
| `blank_contract` | A blank source field came back with text in it |
| `invalid_json` | The reply would not parse |
| `missing_output` | The provider exited cleanly having written nothing |

`identifier_mismatch` has its own category rather than being folded into
`invalid_shape` because it means something different: the model lost track of
which row it was answering, and no retry policy should treat that as an ordinary
bad answer.

## Soft: content concerns downgrade the row

These become review reasons. The row is stored as `review_required` with the
reasons attached, so it is usable and flagged. It is neither thrown away nor
waved through.

- **Square-bracket count differs from source.** Cheap proxy for a dropped
  placeholder or reference.
- **Suspicious combined length ratio.** See below.
- **Translation is identical to the source.** Usually the model echoing back
  rather than translating.
- **Model warnings**, surfaced as `model warning: ...`.
- **Whatever your own validators return.**

## The length ratio, and what its default actually means

The shipped bounds are **0.45 to 2.25** on
`translated.length / max(source.length, 1)` over the concatenated translatable
fields.

Those numbers were calibrated on **one language pair over one corpus of
long-form technical prose**. That is the entire evidential basis. Any other
pair, and any other shape of text, is unmeasured: not known to be fine, not
known to be wrong, unmeasured.

The failure mode is predictable. A corpus of short interface strings trips the
lower bound on nearly every row, because a three-character difference is a large
ratio when the string is six characters long. If most of your rows are flagged
for length, the threshold is wrong for your corpus, not your corpus for the
threshold:

```ts
const job: TranslationJob = {
  // ...
  thresholds: { minLengthRatio: 0.2, maxLengthRatio: 4 },
};
```

**Measured distributions per language pair will appear here** once the fixture
corpus lands, described as what they are: a measurement over that material. A
default threshold nobody has measured is a number nobody will dare change later,
which is why the scope is stated rather than implied.

### A known quirk

A row whose translatable fields are **all blank** always trips the ratio check:
zero over one is zero, which is below any sane lower bound, so the row goes to
review with `suspicious combined length ratio: 0.00`. It is defensible (a row
with nothing to translate is worth a glance) and it is a surprise, so it is
written down rather than fixed.

## Normalization runs before the checks

`job.normalize` is applied at the one line where an accepted value is written,
and before any content check sees it. That ordering is the invariant: **what is
checked is what is stored**, so the guardrails, the registry and whatever you
render cannot disagree.

The intended use is orthotypography, where a target language's conventions
differ from what a model emits by default. A precomputed row routes through the
same function, so it inherits the rule with no second code path. The per-attempt
response file still holds the raw model output, so the audit trail survives.

## Writing a validator

A validator is `(ctx: ValidationContext) => string[]`. Empty means the row
passed. It must not throw for a content problem.

```ts
const noDroppedPlaceholders: Validator = ({ source, translated }) => {
  const had = Object.values(source).some((v) => v?.includes('[Assignment:'));
  const kept = Object.values(translated).some((v) => v?.includes('[Assignment:'));
  return had && !kept ? ['a placeholder was dropped'] : [];
};
```

Two helpers are exported because they are genuinely reusable and the
language-specific tables that drive them are not:

### `missingReferences(pattern, ctx)`

Reference tokens present in the source and absent from the translation, sorted.
It compares the row as a whole rather than field by field, because a translation
may legitimately move a reference into a different sentence.

```ts
validators: [(ctx) => missingReferences(/\b[A-Z]{2}-\d+(?:\(\d+\))?\b/g, ctx)]
```

### `modalForceShiftsFor(levels, ctx)`

Normative modal force that did not survive. A requirement is binding because of
its modal and nothing else in the pipeline looks at one, so this is the check
that catches an obligation quietly becoming a suggestion while the row stays
structurally valid, passes every other check and exports clean.

Four design points, all deliberate:

- **Per level, not in total.** A MUST rendered at the SHOULD level is a real
  defect that an equal total would hide.
- **Counts, not alignment.** A translation legitimately splits and merges
  sentences, so a difference is a review lead and not proof of a defect.
- **Both directions.** A surplus in the target can mean a lowercase source modal
  was promoted into a scannable requirement.
- **Translatable fields only,** so a passthrough field cannot contribute a
  phantom source modal.

The level table is a parameter because which words mark which level is a
judgement about one language pair. You supply it:

```ts
const EN_FR: ModalLevel[] = [
  { level: 'MUST',   source: /\bMUST\b/g,   target: /\b(?:DOIT|DOIVENT)\b/g },
  { level: 'SHOULD', source: /\bSHOULD\b/g, target: /\b(?:DEVRAIT|DEVRAIENT)\b/g },
  { level: 'MAY',    source: /\bMAY\b/g,    target: /\b(?:PEUT|PEUVENT)\b/g },
];

validators: [(ctx) => modalForceShiftsFor(EN_FR, ctx)]
```

Case-sensitivity is the table's choice, not the mechanism's. Where a source
document capitalizes a modal to mark requirement level and is inconsistent about
it, mirroring the source's case is the correct translation, and comparing
case-sensitively is what distinguishes a real shift from a faithfully mirrored
lowercase.
