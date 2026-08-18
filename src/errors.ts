// The failure vocabulary, and the only module every other layer may import.
//
// It exists as its own file because two layers need it and neither may depend
// on the other: the subprocess layer raises these, and the validation layer
// raises them too, without knowing that subprocesses exist. Putting them where
// the subprocess layer lives is what forced validation to import it once
// before, which is exactly the edge the layer boundary now forbids.

/**
 * Why an attempt did not produce a usable answer.
 *
 * The distinctions are the ones a batch runner has to act on, not a taxonomy
 * for its own sake:
 *
 * - `quota` pauses the whole batch. Retrying costs the same refusal.
 * - `timeout` and `launcher` are worth retrying, and must stay apart: a timeout
 *   means the agent ran and was too slow, a launcher failure means it never
 *   started, and confusing them hides a broken installation behind a
 *   plausible-looking slow row.
 * - `invalid_json`, `invalid_shape`, `blank_contract` and `identifier_mismatch`
 *   are the agent answering badly rather than failing. They retry, and a row
 *   that keeps producing them is a prompt problem, not an infrastructure one.
 * - `missing_output` is the agent exiting cleanly having written nothing.
 * - `exit_code` is everything else the process reported.
 */
export type FailureCategory =
  | 'quota'
  | 'timeout'
  | 'launcher'
  | 'invalid_json'
  | 'invalid_shape'
  | 'missing_output'
  | 'exit_code'
  | 'identifier_mismatch'
  | 'blank_contract';

/**
 * One attempt failed in a way worth another attempt. Carries the category so
 * the caller can decide, and the process exit code where there was one.
 */
export class TransientFailure extends Error {
  readonly category: FailureCategory;
  readonly exitCode: number | null;
  constructor(category: FailureCategory, message: string, exitCode: number | null = null) {
    super(message);
    this.name = 'TransientFailure';
    this.category = category;
    this.exitCode = exitCode;
  }
}

/**
 * Whether a message from an agent CLI means "you have run out of allowance"
 * rather than "that request was bad".
 *
 * Matched on wording rather than on an exit code because the CLIs do not agree
 * on one, and a batch that mistakes a quota refusal for a retryable error will
 * burn its remaining allowance discovering the same thing several times per
 * row. The three phrases are the forms actually observed in the wild; `status`
 * covers the case where a structured API error is available instead.
 */
export function isQuotaError(message: string, status?: number | null): boolean {
  const text = message.toLowerCase();
  return (
    status === 429 || ['usage limit', 'rate limit', 'session limit'].some((m) => text.includes(m))
  );
}
