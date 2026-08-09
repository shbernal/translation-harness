---
read_when: changing src/contract/prompt.ts, src/contract/schema.ts, or src/job.ts
---

# The model contract

Every job speaks one shape:

```json
{
  "identifier": "AC-2",
  "translations": { "title": "...", "statement": null },
  "warnings": []
}
```

The prompt and the JSON output schema are **generated from the same field
specs**, which is the point: they cannot drift. A field added to the job is a
field the model is asked for and a field the schema requires, in one edit.

## The prompt

```
<promptTemplate, trailing whitespace trimmed>

<promptExtras for this row, if any>

Translate from <sourceLang> into <targetLang>. Translate these fields:
- <key>: <label>
...

Reply with EXACTLY ONE JSON object matching the output schema and nothing else:
no prose, no explanation, no markdown code fences. Preserve the identifier exactly.
When a field's source value is null, its translation MUST be null.

SOURCE ROW JSON:
{"identifier":"...","fields":{...}}
```

Only translatable fields appear, in the list and in the payload. A passthrough
field is neither named nor sent.

The payload comes last, after `SOURCE_ROW_MARKER`, so a parser can find it with
`lastIndexOf` regardless of what the template said. That is how the offline
provider answers without a subprocess.

**The template is text, not a path.** Resolving one is the caller's business. A
library that reads files out of a directory it was handed has quietly taken
ownership of the caller's layout.

### `test/golden/`

`buildPrompt` and `buildResponseSchema` output for a fixed job and row is
committed and asserted on every run. Regenerate deliberately when the prompt is
meant to change, and treat the diff as the review: nothing else in the suite
would notice a stray space, and a stray space is a change to what every model in
every run is asked.

## The two hashes

### `hashInput(identifier, source)`

A row's identity. The canonical form is the identifier plus every field in
sorted key order, with absent and null treated alike, so the hash is stable
against a caller that reads its fields in a different order tomorrow.

Comparing it on re-read is how a corpus that changed under a half-finished run
is noticed instead of silently mixed. `initialize` resets exactly the rows whose
hash moved.

One consequence worth knowing before it surprises you: **a field that is absent
hashes differently from a field that is null.** The canonical form lists the keys
it was given, so dropping a column from your reader changes every hash in the
corpus, even where the value was empty either way, and invalidates a
half-finished run. That is correct (the row really is being read differently
now) but the symptom looks like corruption if you are not expecting it.

### `jobPromptHash(job)`

A run's identity: the template plus `promptSalt`. Stored per row, so a resume
can tell in one comparison whether the standing guidance has changed since the
rows it is about to skip were produced.

## The two extension hooks, and why the salt is not decoration

```ts
promptExtras?: (source: Fields) => string;   // text, inserted per row
promptSalt?: string;                          // hashed, never shown
```

`promptExtras` is for anything that depends on what this particular row says: a
glossary of terms it contains, prior decisions about its vocabulary. It sits
between the template and the output contract, so the standing guidance reads
first and the row-specific material reads last before the payload.

**A job with neither hook, and a job whose hook returns `''`, produce
byte-identical prompts.** That is what makes adding a glossary to a corpus that
is already half translated safe.

`promptSalt` exists because that safety creates a hole. A glossary pack that
matched nothing on *this* row still changes what the run means, and a resume
that cannot see the difference will reuse answers produced under different
rules. So the pack's digest goes into the hash without going into the prompt. An
empty salt leaves the hash exactly where it has always been.

## A termbase without a language pack

The hooks above are what a per-row glossary is built on, and building one by hand
gets one thing wrong reliably. A pack reaches a translation run **twice** - as
text through `promptExtras`, as a digest through `promptSalt` - and it reaches a
review run twice more, as the `TERMINOLOGY` block and as an `extraInputs` entry.
Four hooks over one input. Fill them from four places and you can inject one pack
while recording the identity of another; nothing reports it, and what it buys is
a resume reusing answers produced under rules nobody can still name.

`glossaryHook` returns both translation-side hooks from one entry list, so that
state has nowhere to come from. The review side has no such hook and needs none:
its two are plain fields, filled by
[`glossaryBlock` and `termsDigest`](review.md#a-termbase-on-the-review-side)
from the same list.

```ts
const ENTRIES: TermEntry[] = [
  { match: ['access control'], render: '- access control -> controle d acces' },
  { match: ['policy', 'policies'], render: '- policy -> politique (eviter: police)' },
];

const job: TranslationJob = {
  ...rest,
  fields: FIELDS,
  ...glossaryHook({ entries: ENTRIES, heading: GLOSSARY_HEADING, fields: FIELDS }),
};
```

**There are no term lists here, and no language tables.** Which words are
canonical is a judgement about one language pair and one domain, and a library
that shipped that judgement would be making it for every host. What is published
is the mechanism a host's own pack plugs into.

### The two fields of an entry, and why one of them is a string

`match` is data the library compares. `render` is text the library only ever
copies. That split is what keeps every language-policy decision - which label
marks a banned form, what separates a source term from its target, which language
any of it is written in - on the host's side of the boundary.

`render` is a string rather than a callback so `termsDigest` is provably a digest
of exactly what gets injected. With a callback the two could disagree and nothing
would notice.

### The matcher is a predicate, not a profile

```ts
type TermMatcher = (text: string, term: string) => boolean;
```

A profile of folding rules, determiners and inflection suffixes is *one* matching
strategy and an opinionated one. A predicate presumes nothing: a regex profile
satisfies it, and so do a stemmer, a lemmatizer, an ICU collator and plain
substring search. Because the library never composes a pattern, it never needs to
know what a determiner is - which is the reason no language pack has to exist
here for any of this to ship.

It must be a pure function of its two arguments. It runs once per entry per row
and its answers become prompt bytes, so a matcher that reads a clock or a locale
makes a run unreproducible.

The default, `substringMatcher`, is case-insensitive substring search and is
honestly naive: it will not match `Massnahmen` from a pack authored with
`Massnahme`, and it fires `art` inside `restart`. It is right for proper nouns
and product names, and the point of it is that the floor is zero rather than a
language pack. Anything inflected wants a matcher of its own.

### What an empty pack costs

Nothing, and that is a contract term rather than a happy accident. An empty entry
list makes `promptExtras` answer `''` for every row, which `buildPrompt` composes
identically to a job with no hook, and makes `termsDigest` answer `''`, which
leaves `jobPromptHash` exactly where it was. Same for a pack that simply matched
nothing on this row. That is what makes adding a termbase to a corpus already
half translated safe.

`selectTerms` skips empty `match` forms rather than matching them, because under
the default matcher `''` is a substring of everything: an entry that lost its
forms to a bad parse would otherwise attach itself to every row in the corpus.

If the job already has a `promptSalt`, pass it as `salt` rather than losing it -
spreading the result over a job replaces the field outright.

## `sourceLang` is a free string

Deliberately. A host with language-specific tables (term folding, determiners,
orthotypography) is right to close it to a union in its own code, because a typo
there silently selects the wrong table and the failure is invisible.

This package has no such tables, so it has nothing to be wrong about, and
narrowing it here would only stop somebody translating a language nobody thought
to add. Do not "fix" it by narrowing it.

## The response schema

Generated with `additionalProperties: false` at both levels, and every
translation field typed `["string", "null"]`, because a blank source field must
translate to null.

`additionalProperties: false` matters more than it looks: without it a model in
a structured output mode is free to add commentary keys, and nothing stops it.

`writeResponseSchema(job, dir)` puts it on disk and returns the path, because
that is what the agent CLIs take: Codex wants `--output-schema <path>`, and the
Claude invoker reads the file to embed it in the system prompt.
