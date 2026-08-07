// Which providers exist, by name.
//
// Open rather than closed. The version of this that shipped privately was a
// `Record` over a union of three literals, which is tighter and is also a fork
// reason the moment someone wants a fourth: a consumer with an internal HTTP
// backend, a different agent CLI, or a recorded-fixture provider has nowhere to
// put it. Registration is a function, and the name is a string.

import { TransientFailure } from '../errors.ts';
import { invokeClaude } from './claude.ts';
import { invokeCodex } from './codex.ts';
import type { InvokeArgs, Invoker, ProviderName, ProviderResult } from './types.ts';

const INVOKERS = new Map<ProviderName, Invoker>();

/**
 * Make a provider invokable by name. Re-registering a name replaces it, which
 * is how a consumer overrides a built-in without patching the package.
 */
export function registerProvider(name: ProviderName, invoker: Invoker): void {
  INVOKERS.set(name, invoker);
}

/** The names currently registered, in registration order. */
export function providerNames(): ProviderName[] {
  return [...INVOKERS.keys()];
}

/** Whether a name is registered. */
export function hasProvider(name: ProviderName): boolean {
  return INVOKERS.has(name);
}

/**
 * Invoke the provider named in `args.options.provider`.
 *
 * An unknown name is a `launcher` failure rather than a thrown `Error`, because
 * it reaches a running batch the same way a missing binary does: as one row
 * that could not start. The batch records it and moves on rather than dying
 * partway through with rows half-claimed.
 */
export async function invokeProvider(args: InvokeArgs): Promise<ProviderResult> {
  const invoker = INVOKERS.get(args.options.provider);
  if (!invoker) {
    const known = providerNames().join(', ') || 'none registered';
    throw new TransientFailure(
      'launcher',
      `Unknown translation provider: ${args.options.provider} (registered: ${known})`,
    );
  }
  return invoker(args);
}

// The two built-ins register on import of this module, which the package
// barrel and the provider barrel both pull in. The mock provider does not
// register here and does not live in this layer at all: it parses the prompt
// payload, so it knows what a translation is, and that knowledge is not allowed
// below this line. See `contract/mock.ts`.
registerProvider('codex', invokeCodex);
registerProvider('claude', invokeClaude);
