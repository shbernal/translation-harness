// The offline provider: the whole loop, end to end, for free and in
// milliseconds.
//
// It lives here rather than under `provider/` because of what it does. It finds
// SOURCE_ROW_MARKER in the prompt and answers in the job's response shape,
// which means it knows what a translation is, and that knowledge is not allowed
// in the provider layer: the `translation-harness/providers` subpath export
// promises a domain-free half, and this file would break the promise. It is a
// translation mock, not a provider mock.

import { writeFileSync } from 'node:fs';
import { TransientFailure } from '../errors.ts';
import { registerProvider } from '../provider/registry.ts';
import type { InvokeArgs, ProviderResult } from '../provider/types.ts';
import { SOURCE_ROW_MARKER } from './prompt.ts';

/** The name `registerMockProvider` registers under. */
export const MOCK_PROVIDER_NAME = 'mock';

/**
 * Answer a prompt without a subprocess.
 *
 * Parses the source-row payload the contract embeds in the prompt and echoes
 * each non-null field with a `mock: ` prefix: non-empty, brackets and
 * references preserved, so a well-formed row validates as succeeded. Trivially
 * short fields may still land in review via the length-ratio guardrail; that is
 * a valid outcome and not a bug in the mock.
 *
 * `async` only to share the invoker signature. The body launches nothing and
 * runs to completion synchronously, so the offline path stays instant and
 * deterministic however many workers are pulling on it.
 */
export async function invokeMock({ prompt, responsePath }: InvokeArgs): Promise<ProviderResult> {
  const marker = prompt.lastIndexOf(SOURCE_ROW_MARKER);
  if (marker === -1)
    throw new TransientFailure('missing_output', 'mock provider: prompt had no source payload');
  const payloadText = prompt.slice(marker + SOURCE_ROW_MARKER.length).trim();
  let payload: { identifier?: unknown; fields?: Record<string, unknown> };
  try {
    payload = JSON.parse(payloadText) as typeof payload;
  } catch (error) {
    throw new TransientFailure('invalid_json', `mock provider: ${(error as Error).message}`);
  }
  const translations: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(payload.fields ?? {})) {
    translations[key] = raw == null ? null : `mock: ${String(raw)}`;
  }
  const value = { identifier: String(payload.identifier ?? ''), translations, warnings: [] };
  writeFileSync(responsePath, JSON.stringify(value, null, 2), 'utf8');
  return { value, stdout: '', stderr: '', exitCode: 0, duration: 0 };
}

/**
 * Put the offline provider in the registry, under `mock` or a name you choose.
 *
 * Opt-in rather than automatic. A provider that fabricates plausible-looking
 * translations should never be one typo away from a production run, so it is
 * absent until a test suite or a dry-run asks for it by name.
 */
export function registerMockProvider(name: string = MOCK_PROVIDER_NAME): void {
  registerProvider(name, invokeMock);
}
