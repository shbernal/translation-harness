# translation-harness

> **Requires Node >= 24.** The shipped store is built on the built-in
> `node:sqlite`, which does not exist before 24.

Run a large translation job as a batch of non-interactive coding-agent CLI calls
(Codex, Claude), one subprocess per row, against a uniform JSON contract. The
library owns the machinery that makes that survivable at scale: a resumable
per-row registry, a worker pool that pauses on quota and retries on transient
failure, structural and generic guardrails on every response, and per-attempt
logs you can go back to. It does not own your corpus, your prompts, your
languages or your output format, all of which stay with the caller.

**Status: pre-release, `0.0.0`.** The API is not stable and there is no
published version yet. Part of the surface described here is still being moved
in from the private codebase this was extracted from.

## License

The code is MIT. See [LICENSE](LICENSE).

The material under `test/fixtures/` is **not** covered by it: those are
third-party works redistributed under their own terms, each with its own license
text and attribution beside it. See `test/fixtures/README.md` before reusing
any of it.
