// The provider contract: what a provider is asked to do, and what it must
// return. Nothing here knows what a translation is. A provider is handed a
// prompt and a schema, and produces a parsed JSON value plus the evidence of
// how it was produced.

/**
 * A provider's registered name. Deliberately a bare `string` rather than a
 * closed union: the registry is open, and a consumer adding an HTTP backend or
 * a different agent CLI must not have to fork the package to name it.
 */
export type ProviderName = string;

/** Which host we are running on, injected rather than read from the process. */
export interface Platform {
  readonly win32: boolean;
}

export interface ProviderOptions {
  /**
   * Working directory for the subprocess, and nothing else.
   *
   * It is worth knowing that an agent CLI treats this as a project root and
   * will discover instructions from it: Codex reads a project doc found here
   * and prepends it to every single call. That is why
   * `project_doc_max_bytes=0` heads the trim list in `codex.ts`, and the two
   * facts are only useful next to each other.
   *
   * Where attempt logs are recorded, and relative to what, is the store's
   * business, not this option's.
   */
  cwd: string;

  /** Which registered provider to invoke. */
  provider: ProviderName;

  /**
   * Exact model id. Passing none means the agent CLI falls back to whatever
   * that machine's own config says, which makes the run unreproducible. See
   * `profiles.ts` for why that matters more than it sounds.
   */
  model?: string | null;

  /** Reasoning effort, for the providers that expose one. */
  reasoningEffort?: string | null;

  /** Hard wall-clock limit per attempt. Zero or less disables the timer. */
  timeoutSeconds: number;

  /**
   * Extra `--config key=value` entries appended after the Codex defaults.
   * Ignored by other providers.
   */
  codexConfig?: readonly string[];

  /**
   * What to do with the built-in Codex context trims: keep them (`'default'`),
   * send none (`'none'`), or replace them wholesale with your own list.
   *
   * The defaults are measured against one particular Codex build. A consumer
   * running a build that has renamed a feature flag needs a way to adjust
   * without forking, which is the only reason this is configurable.
   */
  codexTrims?: 'default' | 'none' | readonly string[];
}

export interface ProviderResult {
  /** The parsed JSON the provider produced. Shape is the caller's business. */
  value: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall-clock seconds, measured around the subprocess. */
  duration: number;
}

export interface InvokeArgs {
  prompt: string;

  /**
   * Where the provider must leave its JSON answer.
   *
   * Providers treat the directory around this path as theirs for audit
   * evidence: the Claude invoker also writes `<basename>.system-prompt.txt`
   * beside it, recording the exact system prompt that produced the answer.
   * Point this somewhere per-attempt.
   */
  responsePath: string;

  /** Path to the JSON Schema the answer must satisfy. */
  schemaPath: string;

  options: ProviderOptions;
}

/** A provider: turn a prompt into a parsed JSON value, or throw. */
export type Invoker = (args: InvokeArgs) => Promise<ProviderResult>;

/** What a finished subprocess left behind. */
export interface RunResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The timer fired and the tree was killed. Distinct from `launchError`. */
  timedOut: boolean;
  /** The process never started, or its output was capped and it was killed. */
  launchError: Error | null;
}
