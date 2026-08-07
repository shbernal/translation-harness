# Documentation

The map. Each page owns a subject; read the page that owns what you are about to
change, before you change it.

| Page | Owns |
|---|---|
| `architecture.md` | The layers and the rule that binds them, the run loop, resume and quota semantics |
| `providers.md` | Subprocess invocation, model profiles, timeouts, process trees, what a row costs |
| `contract.md` | The response schema, prompt assembly, the prompt hash, guardrails |
| `store.md` | The `TranslationStore` interface, its obligations, and implementing one |

None of these pages exist yet. The library's own code is still being moved in,
and a page written before the code it describes is a page that documents an
intention. They land with the surface they describe.

## What belongs here, and what does not

`docs/` holds what stays true: an invariant, a measured property, a decision
with the reason attached, a constraint a future reader would otherwise
rediscover the hard way.

It does not hold narrative. How many steps a change took, what was tried before
it worked, which files moved in which order and what the counts were: that is
what a commit message is for, and it rots in a document within a release.
