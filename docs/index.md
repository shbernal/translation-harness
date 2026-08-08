# Documentation

The map. Each page owns a subject; read the page that owns what you are about to
change, before you change it.

| Page | Owns |
|---|---|
| [architecture.md](architecture.md) | The layers and the rule that binds them, the run loop's shape, the store seam and its eight contract terms, the review half, schema versions and migration, known limitations |
| [providers.md](providers.md) | Subprocess invocation, the Windows paths, timeouts and the output cap, what a row costs, the measured context trims, adding a provider |
| [batch.md](batch.md) | The domain-free runner behind every pass: `runAgentBatch`, `BatchStore`, `batchConformance`, and what it refuses to know |
| [contract.md](contract.md) | The response schema, prompt assembly, the two hashes, the per-row extras and salt hooks |
| [review.md](review.md) | The review lifecycle: what a review job is, the reviewer prompt and schema, the graded vocabularies and why they are closed |
| [guardrails.md](guardrails.md) | The hard and soft split, the length-ratio defaults and their real scope, writing a validator |
| [pipeline.md](pipeline.md) | Resume, claiming, concurrency, the three stop reasons, quota, events, evidence |

Human usage lives in [`../README.md`](../README.md); the session-start briefing
for agents is [`../AGENTS.md`](../AGENTS.md).

## What belongs here, and what does not

`docs/` holds what stays true: an invariant, a measured property, a decision
with the reason attached, a constraint a future reader would otherwise
rediscover the hard way.

It does not hold narrative. How many steps a change took, what was tried before
it worked, which files moved in which order and what the counts were: that is
what a commit message is for, and it rots in a document within a release.
