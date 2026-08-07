// The Codex invoker. Uses the CLI's native structured output, so the answer
// arrives as a file the CLI wrote against the schema rather than as prose this
// package has to parse back out.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isQuotaError, TransientFailure } from '../errors.ts';
import { launcher, run } from './run.ts';
import type { InvokeArgs, Platform, ProviderResult } from './types.ts';

/**
 * Context the Codex harness injects into every `exec` call that a single-shot
 * translation row can never use, and what each costs.
 *
 * Measured 2026-08-06 against codex-cli 0.145.0 and `gpt-5.6-sol` at reasoning
 * effort `high`, on one real row of a technical standard, by flipping one entry
 * at a time and reading `turn.completed.usage.input_tokens`: **29,382 tokens as
 * shipped, 14,586 with all of these off** - a 50% cut with the translated
 * output unchanged in substance and still schema-valid. Of what remains,
 * ~12,350 is Codex's own base instructions, which no CLI flag reaches
 * (`base_instructions` and `experimental_instructions_file` were both measured
 * inert via `-c`), and ~2,230 was the caller's actual prompt.
 *
 * `--ignore-rules` does NOT cover the project doc - it skips execpolicy
 * `.rules` files only. `run()` spawns with `cwd` set, so without
 * `project_doc_max_bytes=0` every single row carries whatever agent
 * instructions live in that directory. In the measured case that was a 53 KB
 * file: 8,060 tokens of instructions about how to work on a codebase, shipped
 * to a model whose entire job was to render one sentence into another language.
 *
 * Written as `-c features.X=false` rather than the equivalent `--disable X`
 * on purpose: `--disable` rejects a name the running build does not know
 * ("Unknown feature flag", exit 1), so a Codex upgrade that retires any one of
 * these would fail every row of a pass. The config path ignores unknown keys,
 * which is the behaviour a batch runner wants from a pure optimization.
 *
 * The numbers are from one build. `ProviderOptions.codexTrims` replaces this
 * list and `codexConfig` appends to it, so a consumer on a build that has moved
 * a flag adjusts instead of forking.
 */
export const CODEX_CONTEXT_TRIMS: readonly string[] = [
  // 8,060 tokens - the agent instructions discovered from cwd.
  'project_doc_max_bytes=0',
  // 4,047 - cross-session memories, when enabled in the user's Codex config.
  'features.memories=false',
  // 1,714 together - apps, plugins, hooks, tool suggestion, web search.
  'features.apps=false',
  'features.enable_mcp_apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.hooks=false',
  'features.tool_suggest=false',
  'features.code_mode_host=false',
  'features.guardian_approval=false',
  'features.personality=false',
  'features.goals=false',
  // 540 - shell and apply_patch tool definitions. A single-shot prompt forbids
  // tools; shipping their schemas and then asking for restraint is the same
  // mistake the Claude side was measured making at 19k tokens a row.
  'features.shell_tool=false',
  'features.unified_exec=false',
  // 435 - browser, computer use, image generation, in-app browser.
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.browser_use_full_cdp_access=false',
  'features.computer_use=false',
  'features.image_generation=false',
  'features.in_app_browser=false',
];

/**
 * The trim list in effect for one call: the defaults, none at all, or the
 * caller's own list outright.
 */
export function codexTrimsFor(
  codexTrims?: 'default' | 'none' | readonly string[],
): readonly string[] {
  if (codexTrims === 'none') return [];
  if (codexTrims === undefined || codexTrims === 'default') return CODEX_CONTEXT_TRIMS;
  return codexTrims;
}

export async function invokeCodex(
  { prompt, responsePath, schemaPath, options }: InvokeArgs,
  platform?: Platform,
): Promise<ProviderResult> {
  rmSync(responsePath, { force: true });
  const { cmd, pre } = launcher('codex', platform);
  const args = [
    ...pre,
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--ignore-rules',
    ...codexTrimsFor(options.codexTrims).flatMap((trim) => ['--config', trim]),
    ...(options.codexConfig ?? []).flatMap((entry) => ['--config', entry]),
    '--output-schema',
    schemaPath,
    '--output-last-message',
    responsePath,
  ];
  if (options.model) args.push('--model', options.model);
  if (options.reasoningEffort)
    args.push('--config', `model_reasoning_effort="${options.reasoningEffort}"`);
  args.push('-');

  const started = Date.now();
  const res = await run(cmd, args, prompt, options, platform);
  if (res.launchError) throw new TransientFailure('launcher', res.launchError.message);
  if (res.timedOut)
    throw new TransientFailure('timeout', `Codex exceeded ${options.timeoutSeconds} seconds`);
  const duration = (Date.now() - started) / 1000;

  if (res.status !== 0) {
    const message = (res.stderr || res.stdout || 'Codex exited without diagnostics')
      .trim()
      .slice(-2000);
    if (isQuotaError(message)) {
      const quotaLine = message
        .split('\n')
        .reverse()
        .find((l) => l.toLowerCase().includes('usage limit'));
      throw new TransientFailure(
        'quota',
        quotaLine?.trim() || 'Codex usage limit reached',
        res.status,
      );
    }
    throw new TransientFailure('exit_code', message, res.status);
  }
  if (!existsSync(responsePath)) {
    throw new TransientFailure('missing_output', 'Codex did not create the response file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(responsePath, 'utf8'));
  } catch (error) {
    throw new TransientFailure('invalid_json', (error as Error).message);
  }
  return { value, stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 0, duration };
}
