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
