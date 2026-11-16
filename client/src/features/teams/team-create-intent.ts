/**
 * Creation-intent policy for the unified "new team" flow.
 *
 * A draft creation is a single idempotent request. While its outcome is still
 * unknown (sent, not confirmed), every retry must reuse the exact same request
 * key and payload, so a network failure can never create a second team. Once the
 * server has confirmed the creation, the intent is released and the next create
 * is a brand-new team.
 */

export const TEAM_CREATE_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export interface TeamCreateIntent {
  digest: string;
  key: string;
}

export type TeamCreateOutcome = 'pending' | 'confirmed';

/** Stable digest of the reviewed creation input (key order never changes it). */
export function teamCreateDigest(input: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return JSON.stringify(stable(input));
}

/**
 * Returns the intent to send with the create request, or null after confirmation.
 * - confirmed: the team exists, release the pending intent.
 * - pending + same digest: reuse the original key and payload.
 * - pending + changed digest: a different draft, so a fresh key is issued.
 */
export function nextTeamCreateIntent(input: Record<string, unknown>, previous: TeamCreateIntent | null, outcome: TeamCreateOutcome): TeamCreateIntent | null {
  if (outcome === 'confirmed') return null;
  const digest = teamCreateDigest(input);
  if (previous && previous.digest === digest) return previous;
  return { digest, key: crypto.randomUUID() };
}
