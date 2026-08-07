// The `translation-harness/providers` surface: driving a non-interactive agent
// CLI as a subprocess and getting a JSON answer back, with nothing in it that
// knows what a translation is.
//
// It is a subpath export because that layer is genuinely domain-free and could
// be its own package one day. Publishing two packages on day one would double
// the release overhead for a consumer set of one; splitting later is a
// re-export away. What makes the promise real is not this file, it is
// `test/layering.test.ts`, which fails the build on any import from here into
// the translation layers above.

export { CLAUDE_SYSTEM_PROMPT, extractJsonObject, invokeClaude } from './claude.ts';
export { CODEX_CONTEXT_TRIMS, codexTrimsFor, invokeCodex } from './codex.ts';
export { DEFAULT_PROFILES, type ModelProfile, resolveProfile } from './profiles.ts';
export { hasProvider, invokeProvider, providerNames, registerProvider } from './registry.ts';
export { HOST, killTree, launcher, MAX_BUFFER, run, treeKillCommand } from './run.ts';
export type {
  InvokeArgs,
  Invoker,
  Platform,
  ProviderName,
  ProviderOptions,
  ProviderResult,
  RunResult,
} from './types.ts';
