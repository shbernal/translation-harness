---
read_when: changing src/provider/**, adding a provider, or asking what a row costs
---

# Providers

A provider turns a prompt into a parsed JSON value. That is the whole contract.
It knows nothing about translation, which is what the
`translation-harness/providers` subpath export is selling and what
[the layering rule](architecture.md#the-layers) enforces.

```ts
type Invoker = (args: InvokeArgs) => Promise<ProviderResult>;
```

## What a row costs, and the trims

The single largest lever on cost is not the model, it is the context an agent
harness injects into every call that a one-shot translation can never use.

Measured 2026-08-06 against codex-cli 0.145.0 and `gpt-5.6-sol` at reasoning
effort `high`, on one real row of a technical standard, flipping one entry at a
time and reading `turn.completed.usage.input_tokens`:

| | input tokens |
|---|---|
| As shipped | 29,382 |
| With `CODEX_CONTEXT_TRIMS` | **14,586** |

A 50% cut, with the translated output unchanged in substance and still
schema-valid. Of what remains, roughly 12,350 is Codex's own base instructions,
which no CLI flag reaches (`base_instructions` and
`experimental_instructions_file` were both measured inert), and roughly 2,230
was the actual prompt.

The biggest single entry, 8,060 tokens, is **the agent instructions discovered
from the working directory**. `--ignore-rules` does not cover it: that skips
execpolicy files only. Without `project_doc_max_bytes=0`, every row carries
whatever `AGENTS.md` lives in `cwd`. In the measured case that was a 53 KB file
of instructions about how to work on a codebase, shipped to a model whose entire
job was to render one sentence into another language.

Two smaller entries worth knowing: cross-session memories at 4,047, and the
shell and `apply_patch` tool definitions at 540. Shipping tool schemas and then
asking the model in the prompt not to use tools is the same mistake the Claude
side was separately measured making at 19k tokens a row.

### `cwd` has to be a directory Codex trusts

The other thing the working directory decides. Codex refuses to run outside a
directory it trusts - in practice a git repository - and this package does not
pass `--skip-git-repo-check`. A `cwd` it does not trust fails **every row** of a
pass, on row one, like this:

```
TransientFailure: exit_code
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

Point `cwd` at your project root. That is what it is for, it is almost always a
repository, and the trim above is what stops the project root's own agent
instructions riding along. A scratch directory is the case that surprises
people, and it is captured verbatim in
`test/fixtures/recorded/codex-untrusted-cwd` so the failure has a name here
rather than only on somebody's terminal.

### Why they are `-c key=false` and never `--disable`

`--disable` rejects a flag name the running build does not know and exits 1, so
a Codex upgrade that retired any one entry would fail **every row of a pass**.
The config path ignores unknown keys, which is what a batch runner wants from a
pure optimization.

### Adjusting them without forking

The numbers come from one build. Two options on `ProviderOptions`:

```ts
codexTrims: 'none' | 'default' | string[]   // replace or disable outright
codexConfig: string[]                        // extra --config entries, appended
```

## Process control

### The Windows launcher

An npm-installed CLI on Windows is a `.cmd` shim, which `spawn` cannot execute.
`launcher()` produces `%COMSPEC% /d /c <name>.cmd`. The `/d` is not decoration:
it skips AutoRun commands, which would otherwise inject whatever the machine's
registry has configured into every single attempt.

Everywhere else the name is the executable.

### The tree kill

Killing the Windows shim leaves the agent it launched running, because the shim
has already handed off. A stranded agent holds its quota slot and keeps writing.
So `killTree` takes the whole tree, via `taskkill /T /F`, and it does so
**synchronously**: this runs on the timeout path, the next row spawns a provider
immediately, and the tree has to be gone before we resolve rather than
eventually.

### Testing both branches from either host

The platform is a parameter (`Platform`, defaulting to `HOST`) rather than a
`process.platform` read at module scope, and the argv construction is split into
pure functions, `launcher` and `treeKillCommand`. Both branches of both are
asserted from any machine, and CI additionally runs on a real Windows runner
because only that proves the spawn works.

These are the parts of this package most worth publishing and exactly what a
Linux-only test matrix would never reach.

## What `run()` restates by hand

Everything `spawnSync` gave implicitly, because the pool cannot use it: holding
the event loop for the whole subprocess would have made N workers execute
strictly one at a time and a worker pool a no-op.

- The prompt goes to **stdin**, which is then closed. A provider that exits
  before reading it makes stdin emit EPIPE; that is the child's exit code to
  report, not a runner crash.
- **Timeout** is an explicit timer that kills the tree and classifies the
  result, where `spawnSync` surfaced it as `SIGTERM` / `ETIMEDOUT`.
- A **launch failure** arrives as an `error` event and stays distinct from a
  timeout, because they call for different failure categories and collapsing
  them hides a broken installation behind a plausible slow row.
- The **32 MiB output cap** has no async equivalent. Overflow kills the child
  and reports as a launch failure, which is what `spawnSync`'s own `maxBuffer`
  breach did. Without it a runaway provider is an out-of-memory crash of the
  batch rather than one failed row.
- `close` rather than `exit`, so the last chunk of output cannot be lost to the
  race.

## Model profiles, and the `config-default` hazard

A run that passes no model passes none to the agent CLI either, so the CLI falls
back to the user's own config file. On the machine this was written for that
meant reasoning effort `medium` where the pass called for `high`, and the run
recorded its model as the single word `config-default`: a pointer to a mutable
file on one computer, which tells a later reader nothing about what produced the
output.

`DEFAULT_PROFILES` binds a name to an exact provider, model and effort.
`resolveProfile` takes the table as an argument, because the defaults name
specific model ids and model ids age faster than releases do.

## The Claude exact-model check

The Claude CLI reports which model actually served the request. When a
`claude-*` model is named and the reported usage does not include it, the
attempt fails. A batch whose provenance says one model while another did the
work is worse than a batch that stopped.

## Adding a provider

```ts
import { registerProvider } from 'translation-harness/providers';

registerProvider('my-backend', async ({ prompt, responsePath, schemaPath, options }) => {
  // ... produce a JSON value, write it to responsePath
  return { value, stdout: '', stderr: '', exitCode: 0, duration: 1.2 };
});
```

Then `provider: 'my-backend'` in `RunOptions`. Re-registering a name replaces
it, which is how you override a built-in without patching the package.

Raise `TransientFailure` with the right category for anything retryable, and
`quota` specifically for "you have run out of allowance", which pauses the whole
batch instead of spending the rest of it rediscovering the same refusal.
