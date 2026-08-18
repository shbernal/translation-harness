// Prompt assembly, and the two hashes that give a row and a run their identity.

import { createHash } from 'node:crypto';
import { canonicalFields, type Fields, type TranslationJob, translatableFields } from '../job.ts';

/** Marker that precedes the source-row JSON payload in every prompt. */
export const SOURCE_ROW_MARKER = 'SOURCE ROW JSON:';

/**
 * The identity of a run's prompt.
 *
 * Hashed rather than stored so a resume can tell in one comparison whether the
 * standing guidance has changed since the rows it is about to skip were
 * produced. It covers the template plus the job's `promptSalt`, which is how
 * inputs that shape a run without always appearing in its text still count.
 */
export function promptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The prompt-identity string for a job: the template plus whatever salts it. */
export function jobPromptHash(job: TranslationJob): string {
  return promptHash(`${job.promptTemplate}${job.promptSalt ?? ''}`);
}

/**
 * A row's canonical form: the identifier plus every field in sorted key order,
 * with absent and null treated alike. Sorting is what makes the hash stable
 * against a host that reads its fields in a different order tomorrow.
 */
function canonical(identifier: string, source: Readonly<Fields>): string {
  return JSON.stringify({ identifier, ...canonicalFields(source) });
}

/**
 * The stable per-row input hash. Comparing it on re-read is how a corpus that
 * changed under a half-finished run is noticed rather than silently mixed.
 */
export function hashInput(identifier: string, source: Readonly<Fields>): string {
  return createHash('sha256').update(canonical(identifier, source), 'utf8').digest('hex');
}

/**
 * Compose the full per-row prompt: domain guidance, per-row extras, the output
 * contract, and the payload.
 *
 * `extras` is whatever `job.promptExtras` returned for this row, empty when
 * there is no hook or it matched nothing. It sits after the template and before
 * the output contract, so the standing guidance reads first and the
 * row-specific material reads last before the payload. A row that produces no
 * extras yields byte-identical output to a job with no hook at all, which is
 * what makes adding one to a corpus already half-translated safe.
 */
export function buildPrompt(
  job: TranslationJob,
  identifier: string,
  source: Readonly<Fields>,
  extras = '',
): string {
  const fields = translatableFields(job);
  const fieldList = fields.map((f) => `- ${f.key}: ${f.label}`).join('\n');
  const payload = JSON.stringify({
    identifier,
    fields: Object.fromEntries(fields.map((f) => [f.key, source[f.key] ?? null])),
  });
  return `${job.promptTemplate.trimEnd()}
${extras ? `\n${extras}\n` : ''}
Translate from ${job.sourceLang} into ${job.targetLang}. Translate these fields:
${fieldList}

Reply with EXACTLY ONE JSON object matching the output schema and nothing else:
no prose, no explanation, no markdown code fences. Preserve the identifier exactly.
When a field's source value is null, its translation MUST be null.

${SOURCE_ROW_MARKER}
${payload}`;
}

/** The extras block for one row, or `''` when the job has no hook. */
export function promptExtrasFor(job: TranslationJob, source: Readonly<Fields>): string {
  return job.promptExtras?.(source) ?? '';
}
