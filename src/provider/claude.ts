// The Claude invoker. Unlike Codex there is no native structured output here:
// the CLI returns a JSON envelope whose `result` is the model's prose reply, so
// the answer has to be dug back out of it and the model held to the schema by
// instruction rather than by the harness.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isQuotaError, TransientFailure } from '../errors.ts';
import { launcher, run } from './run.ts';
import type { InvokeArgs, Platform, ProviderResult } from './types.ts';

/**
 * Recover the JSON object from a model's reply.
 *
 * Tolerant on purpose: a model asked for bare JSON still wraps it in a fence or
 * adds a sentence often enough that failing the row over it wastes an attempt
 * on something recoverable. Strips a leading code fence, then takes the span
 * between the first `{` and the last `}`. Anything left that will not parse is
 * a genuine `invalid_json`.
 */
export function extractJsonObject(text: string): unknown {
  let s = String(text ?? '').trim();
  if (s.startsWith('```')) {
    s = s
      .replace(/^```[a-zA-Z0-9]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) {
    throw new TransientFailure('invalid_json', 'provider output contained no JSON object');
  }
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch (error) {
    throw new TransientFailure('invalid_json', (error as Error).message);
  }
}

export const CLAUDE_SYSTEM_PROMPT =
  'You are a non-interactive translation function. Do not use tools, read files, or browse. ' +
  'Reply with exactly one JSON object that satisfies the schema below and nothing else: ' +
  'no prose, no explanation, no markdown code fences.';

export async function invokeClaude(
  { prompt, responsePath, schemaPath, options }: InvokeArgs,
  platform?: Platform,
): Promise<ProviderResult> {
  rmSync(responsePath, { force: true });
  const systemPrompt = `${CLAUDE_SYSTEM_PROMPT}\n\nOUTPUT SCHEMA:\n${readFileSync(schemaPath, 'utf8')}`;
  const systemPromptPath = `${responsePath.replace(/\.json$/, '')}.system-prompt.txt`;
  writeFileSync(systemPromptPath, systemPrompt, 'utf8');

  const { cmd, pre } = launcher('claude', platform);
  const args = [
    ...pre,
    '--print',
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--append-system-prompt-file',
    systemPromptPath,
  ];
  if (options.model) args.push('--model', options.model);

  const started = Date.now();
  const res = await run(cmd, args, prompt, options, platform);
  if (res.launchError) throw new TransientFailure('launcher', res.launchError.message);
  if (res.timedOut)
    throw new TransientFailure('timeout', `Claude exceeded ${options.timeoutSeconds} seconds`);
  const duration = (Date.now() - started) / 1000;

  const raiseForMessage = (message: string, apiStatus?: number | null): never => {
    const text = (message || 'Claude exited without diagnostics').trim().slice(-2000);
    throw new TransientFailure(
      isQuotaError(text, apiStatus) ? 'quota' : 'exit_code',
      text,
      res.status,
    );
  };

  if (res.status !== 0) raiseForMessage(res.stderr || res.stdout);
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new TransientFailure(
      'invalid_json',
      `Claude envelope was not JSON: ${(error as Error).message}`,
    );
  }
  if (envelope.is_error || envelope.subtype !== 'success') {
    raiseForMessage(
      String(envelope.result ?? envelope.subtype ?? res.stderr),
      envelope.api_error_status as number | null,
    );
  }
  // A silent model substitution is not a failure the CLI reports, and a batch
  // whose provenance says one model while another did the work is worse than a
  // batch that stopped. The bracketed form covers the id-with-suffix the
  // envelope sometimes carries.
  if (options.model?.startsWith('claude-')) {
    const usedModels = Object.keys((envelope.modelUsage as Record<string, unknown>) ?? {});
    const used = usedModels.some((m) => m === options.model || m.startsWith(`${options.model}[`));
    if (!used) {
      throw new TransientFailure(
        'exit_code',
        `Claude used ${usedModels.join(', ') || 'an unreported model'} instead of requested model ${options.model}`,
        res.status,
      );
    }
  }
  const value = extractJsonObject(String(envelope.result ?? ''));
  writeFileSync(responsePath, JSON.stringify(value, null, 2), 'utf8');
  return { value, stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 0, duration };
}
