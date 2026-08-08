// The offline reviewer: the whole review loop, end to end, for free and in
// milliseconds.
//
// It lives here rather than under `provider/` for the reason `contract/mock.ts`
// does: it finds ROW_SNAPSHOT_MARKER in the prompt and answers in the review
// response shape, so it knows what a review is, and that knowledge is not
// allowed in the provider layer. It is a review mock, not a provider mock.
//
// What it judges is deliberately mechanical: **stray whitespace, and nothing
// else.** A mock that guessed at meaning would produce proposals a reader might
// half believe, which is worse than useless in an example. Collapsing runs of
// whitespace is a defect anyone can verify by looking, it is language
// agnostic, and it is a function of the row - so a corpus reviewed twice
// produces the same verdicts, which is the property the offline loop exists to
// demonstrate.

import { readFileSync, writeFileSync } from 'node:fs';
import { TransientFailure } from '../errors.ts';
import { registerProvider } from '../provider/registry.ts';
import type { InvokeArgs, ProviderResult } from '../provider/types.ts';
import { ROW_SNAPSHOT_MARKER } from './prompt.ts';

/** The name {@link registerReviewMockProvider} registers under. */
export const REVIEW_MOCK_PROVIDER_NAME = 'review-mock';

/** The one defect the offline reviewer claims to find. */
const tidy = (value: string): string => value.trim().replace(/\s+/g, ' ');

/**
 * The levels a graded field may take, read from the schema the runner wrote.
 *
 * From the schema rather than from `DEFAULT_SEVERITY_LEVELS`, because the
 * vocabularies are overridable per job and a mock that answered `minor` to a
 * job whose scale is `low|high` would fail its own validator. Reading them is
 * also what a provider honouring the schema would do, which is the behaviour
 * worth mimicking. Anything unreadable yields no levels, and the answer is then
 * ungraded rather than wrong.
 */
function levelsOf(schemaPath: string, field: 'severity' | 'confidence'): string[] {
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: Record<string, { enum?: unknown[] }>;
    };
    const values = schema.properties?.[field]?.enum ?? [];
    return values.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

/**
 * Review a row without a subprocess.
 *
 * Proposes the whitespace-collapsed form of every field that is not already
 * collapsed, and passes the row when there is nothing to collapse. A proposal
 * grades as the mildest severity the schema allows and the highest confidence,
 * which is honest for a mechanical finding: certain about a small thing.
 *
 * `async` only to share the invoker signature. The body launches nothing, so
 * the offline path stays instant however many workers are pulling on it.
 */
export async function invokeReviewMock({
  prompt,
  responsePath,
  schemaPath,
}: InvokeArgs): Promise<ProviderResult> {
  const marker = prompt.lastIndexOf(ROW_SNAPSHOT_MARKER);
  if (marker === -1)
    throw new TransientFailure('missing_output', 'review mock: prompt had no row snapshot');
  const payloadText = prompt.slice(marker + ROW_SNAPSHOT_MARKER.length).trim();
  let payload: { identifier?: unknown; fields?: Record<string, { current?: unknown }> };
  try {
    payload = JSON.parse(payloadText) as typeof payload;
  } catch (error) {
    throw new TransientFailure('invalid_json', `review mock: ${(error as Error).message}`);
  }

  const proposals: Record<string, string | null> = {};
  const issues: string[] = [];
  for (const [field, cell] of Object.entries(payload.fields ?? {})) {
    const current = cell?.current;
    const collapsed = typeof current === 'string' ? tidy(current) : null;
    if (collapsed === null || collapsed === current) {
      proposals[field] = null;
      continue;
    }
    proposals[field] = collapsed;
    issues.push(`${field}: stray whitespace`);
  }

  const changed = issues.length > 0;
  const value = {
    identifier: String(payload.identifier ?? ''),
    verdict: changed ? 'change_proposed' : 'pass',
    severity: changed ? (levelsOf(schemaPath, 'severity')[0] ?? null) : null,
    confidence: changed ? (levelsOf(schemaPath, 'confidence').at(-1) ?? null) : null,
    proposals,
    issues,
  };
  writeFileSync(responsePath, JSON.stringify(value, null, 2), 'utf8');
  return { value, stdout: '', stderr: '', exitCode: 0, duration: 0 };
}

/**
 * Put the offline reviewer in the registry, under `review-mock` or a name you
 * choose.
 *
 * Opt-in rather than automatic, for the reason `registerMockProvider` is: a
 * provider that fabricates verdicts should never be one typo away from a run
 * whose proposals somebody will adopt. It registers under a different default
 * name than the translation mock so a host can have both, which is the ordinary
 * case - the corpus a review reads is the one a translation pass wrote.
 */
export function registerReviewMockProvider(name: string = REVIEW_MOCK_PROVIDER_NAME): void {
  registerProvider(name, invokeReviewMock);
}
