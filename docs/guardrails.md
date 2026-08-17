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
- **No translatable content.** The same check, reported in its own terms when
  there was nothing to measure. See below.
- **Translation is identical to the source.** Usually the model echoing back
  rather than translating.
- **Model warnings**, surfaced as `model warning: ...`.
- **Whatever your own validators return.**

## The length ratio, and what its default actually means

The shipped bounds are **0.45 to 2.25** on
`translated.length / max(source.length, 1)` over the concatenated translatable
fields.

Those numbers were *chosen* on one language pair over one corpus of long-form
technical prose. They have since been *measured*, and the measurement is
`test/calibration.test.ts` rather than a paragraph: it reads the committed
fixture corpus, discovers every ordered language pair in it, and fails when one
crosses a stated bound.

### What the measurement says

Forty ordered pairs drawn from English, French, Spanish, Italian and German,
over two deliberately different registers. Percentages are the share of
human-translated rows the length check alone would send to review.

| Corpus | Register | Rows | Pairs | Worst pair | Overall |
|---|---|---|---|---|---|
| Kubernetes glossary | reference prose, a paragraph per row | 728 aligned | 20 | 5.6% (fr -> de) | 2.2% |
| Godot editor strings | interface labels, 3 to 60 characters | 3000 aligned | 20 | 2.7% (it -> en) | 0.9% |

Two results worth stating plainly, because both contradict what this page used
to say.

**The prose corpus flags more than the short-string corpus, not less.** The
predicted failure mode - short strings tripping the lower bound because a
three-character difference is a large ratio on a six-character string - is real
arithmetic, but it needs strings far shorter than an interface actually has. At
the shortest tail of the Godot material (English of 12 characters or fewer) the
flag rate is 3% to 7%, not "nearly every row". The median English label is 20
characters and translates comfortably inside the bounds.

**The rows that do flag are mostly true positives.** Every flagged row in the
Kubernetes corpus is one language's entry carrying a long detail section that
another language's translation omits - `cluster`, `control-plane`,
`replica-set`. That is exactly what the check is for. It is a small sample and
not a general claim, but on this material the check is finding dropped content
rather than inventing noise.

### What it does not license

A pair the fixtures do not contain is **unmeasured**, not blessed: nothing here
says anything about English into Japanese, or about any pair outside those five
languages. And a job whose rows are single words is still a job whose ratio can
move a long way for a small absolute change. If most of your rows are flagged
for length, the threshold is wrong for your corpus, not your corpus for the
threshold:

```ts
const job: TranslationJob = {
  // ...
  thresholds: { minLengthRatio: 0.2, maxLengthRatio: 4 },
};
```

Adding a fixture source adds its pairs to the calibration automatically, which
is the cheapest way to extend the claim. See `test/fixtures/README.md`.

### The all-blank row

A row whose translatable fields are **all blank** trips the ratio check by
construction: zero over one is zero, which is below any sane lower bound. The row
goes to review, which is deliberate - a row with nothing to translate is worth a
glance - and the reason it carries is `no translatable content` rather than a
ratio, because there is no translation for a ratio to be suspicious about.

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
