/**
 * Composite request keys for the guided team flow.
 *
 * One key shape serves two server contracts at once: the teams module accepts
 * any trimmed non-empty key, while the paper-trading investment module enforces
 * ^[a-zA-Z0-9_-]{8,128}$ (investment-policy.rules.ts) and rejects ':' outright.
 * The '--' separator keeps every guided composite inside the strict alphabet,
 * so the same key stays valid for both APIs.
 */
export const GUIDED_REQUEST_KEY_SEPARATOR = '--';

/** Joins the stable flow key, a step name, and an optional review epoch into one server-safe idempotency key. */
export function guidedRequestKey(...parts: Array<string | number>): string {
  return parts.filter(part => part !== '').join(GUIDED_REQUEST_KEY_SEPARATOR);
}
