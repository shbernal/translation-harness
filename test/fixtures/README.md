# Test fixtures

**This directory is immutable upstream material.** Do not edit it, do not
reformat it, and do not let a lint autofix touch it. Biome excludes it via
`files.includes`, `.gitattributes` marks it `-text` so Git will not rewrite a
line ending either, and `scripts/check-no-emdash.ts` skips it. All three are on
purpose.

## Why the bytes matter

The library ships generic guardrails with numeric thresholds (a combined length
ratio, bracket counting). Those numbers are a claim about how translated text
behaves, and the only honest form of that claim is "measured over these pairs".
The fixtures are the measurement. Change a byte and the calibration is
measuring something else, which is why every file's SHA-256 is recorded in its
source's `meta.json` and checked by `test/fixtures-integrity.test.ts`.

## Licensing

The MIT license at the repository root covers this repository's **code**. It
does not cover anything in here.

Every fixture is a third-party work redistributed under its own terms. Each
source directory carries the material, a `LICENSE` holding the full upstream
license text, and a `meta.json` recording where it came from, at which commit,
under which license, and with what attribution.

A fixture with no license permitting redistribution does not belong here, no
matter how convenient the text is. Reusing a fixture elsewhere means honouring
the license that ships beside it, not this repository's.

## Contents

| Source | License | Languages | Rows | Register |
|---|---|---|---|---|
| [`corpus/kubernetes-glossary`](corpus/kubernetes-glossary) | CC BY 4.0 | en, fr, es, it, de | 79 / 78 / 49 / 27 / 38 | technical reference prose, one definition per term |
| [`corpus/godot-editor-ui`](corpus/godot-editor-ui) | MIT | en, fr, es, it, de | 150 each | short interface labels, 3 to 60 characters |

Two sources rather than one, so no single upstream's house style decides the
ratio distribution on its own, and two deliberately different registers: one
where a row is a paragraph, one where a row is a button.

**Attribution, as both licenses require.**

- The Kubernetes Authors, [kubernetes/website](https://github.com/kubernetes/website),
  licensed under CC BY 4.0.
- Godot Engine contributors, [godotengine/godot](https://github.com/godotengine/godot),
  MIT licensed.

Neither project endorses this one.

## Recorded provider output

`recorded/<provider>-<case>/` holds real `codex` and `claude` output, captured
once and committed, so the invokers can be tested against bytes a model
actually produced rather than bytes we imagined it would. Each case carries the
prompt that was sent, the `stdout` and `stderr` that came back, the response
file where there was one, and a `meta.json` naming the provider, the model and
the outcome.

`test/provider-recorded.test.ts` replays them through a fake CLI on `PATH` and
runs the **real** invoker against the result. No model is called.

| Case | What only a real capture shows |
|---|---|
| `codex-success` | the answer arriving as a file while `stdout` carries something else entirely, and the human banner on `stderr` |
| `codex-untrusted-cwd` | the exact wording of a refusal, and that it classifies as `exit_code` rather than `quota` |
| `claude-success` | an envelope whose `modelUsage` map holds a *second* model (Claude Code bills its own internal call), which the exact-model check has to look past |
| `claude-fenced` | a real model wrapping its JSON in a ` ```json ` fence with a sentence on either side, which is the whole reason `extractJsonObject` exists |

**The payload is always fixture material**, never anything private: every case
sent one row of the Kubernetes glossary above, and `meta.json` says so.

**Everything was scrubbed before it was committed** - local paths, the home
directory, the user and host names, and session UUIDs, including the one Codex
prints as plain text in its banner where a JSON-shaped scrubber would have
missed it. `provider-recorded.test.ts` re-checks the committed bytes for paths,
UUIDs, keys, tokens and addresses on every run, because the scrubbing itself is
not repeatable and this is the one directory nobody re-reads.

Adding a case means capturing it, scrubbing it, and reading every byte of it
yourself. If you cannot say what a line in it is, it does not go in.

## Shape

```text
corpus/<source-id>/
  LICENSE        verbatim upstream license text
  meta.json      upstream URL, commit, retrieval date, SPDX id, attribution,
                 field descriptions, per-language row counts, per-file SHA-256
  <lang>.jsonl   one row per line: { "identifier": "...", "fields": { ... } }
```

`.jsonl` keyed by identifier is deliberate. It is `SourceRecord` shape minus
the hashes, it diffs line by line, and a shared identifier across two language
files is what makes a pair extractable with no alignment step at all.

`meta.json` listing the languages present is what lets the test suite
**discover** the available pairs instead of hard-coding a matrix that would
break the moment a source is added or dropped. `test/helpers/fixtures.ts` reads
it; nothing in the suite names a language.

## Contributing a source

The language list (Spanish, French, Italian, English, German) is a
**reviewability constraint, not a coverage target**: it is the set the
maintainer reads, so it is the set whose content can be checked rather than
taken on trust. No source needs more than one pair, and a fixture in a language
nobody here reads is worse than no fixture, because nobody can tell when it is
wrong.

Contributions from native speakers, in these languages or others, are exactly
what lifts that constraint and are actively wanted. What a source must carry:

1. **A license permitting redistribution**, with its full text in `LICENSE`.
   CC0, public domain, CC BY, or a permissive software license covering the
   docs. CC BY-SA is usable but a complication. Anything unclear is a no.
2. **`meta.json`** in the shape above, including the upstream commit and a
   SHA-256 per file. The integrity test checks the hashes; nothing checks that
   the commit is honest, so that part is on you.
3. **Genuinely parallel, human-translated material.** Machine translation makes
   the calibration circular: the ratios would measure a model's habits rather
   than a translator's.
4. **Aligned identifiers**, and your word that they are aligned. That is the
   one thing no reviewer here can verify for a language they do not read, and
   an unnoticed misalignment quietly poisons the measurement rather than
   failing a test.

Adding a source adds its pairs to `test/calibration.test.ts` automatically. It
is a data change, not a test change, which is the whole reason the discovery is
built this way.
