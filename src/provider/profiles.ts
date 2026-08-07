// Model profiles. A profile binds a run to an exact provider, model, and
// (optionally) reasoning effort, so a run's identity and reproducibility are
// fixed when it opens rather than inferred afterwards from whatever the machine
// happened to be configured with.
//
// The hazard this exists for is quiet and expensive. A run that passes no model
// passes none to the agent CLI either, so the CLI inherits the user's own
// config file. On the machine this was written for that meant reasoning effort
// `medium` where the pass called for `high`, and the run recorded its model as
// the single word `config-default`: a pointer to a mutable file on one
// computer, which tells a later reader nothing about what actually produced the
// output. Naming a profile is how a pass says what it ran.

import type { ProviderName } from './types.ts';

export interface ModelProfile {
  provider: ProviderName;
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * A starting table, not a fixed one.
 *
 * These name specific model ids, and model ids age faster than releases do.
 * `resolveProfile` takes the table as an argument for exactly that reason: a
 * consumer supplies their own and never waits on this package to publish a
 * new one.
 */
export const DEFAULT_PROFILES: Record<string, ModelProfile> = {
  'opus-5': { provider: 'claude', model: 'claude-opus-5', reasoningEffort: null },
  'opus-4-8': { provider: 'claude', model: 'claude-opus-4-8', reasoningEffort: null },
  'sonnet-5': { provider: 'claude', model: 'claude-sonnet-5', reasoningEffort: null },
  'codex-medium': { provider: 'codex', model: null, reasoningEffort: 'medium' },
  'gpt-5-6-high': { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
};

export function resolveProfile(
  name: string | undefined,
  profiles: Record<string, ModelProfile> = DEFAULT_PROFILES,
): { name: string | null; profile: ModelProfile | null } {
  if (!name) return { name: null, profile: null };
  const profile = profiles[name];
  if (!profile)
    throw new Error(
      `Unknown model profile '${name}'. Available: ${Object.keys(profiles).join(', ')}`,
    );
  return { name, profile };
}
