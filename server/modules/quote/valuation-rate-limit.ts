import { isAxiosError } from 'axios';

export class ValuationSourceThrottled extends Error {
    constructor(readonly retryAfterMs: number) {
        super('Valuation quote source requested a cooldown');
    }
}

export function valuationRetryDelay(error: unknown, at = Date.now()): number | null {
    if (!isAxiosError(error))
        return null;
    const response = error.response;
    const header = response?.headers?.['retry-after'];
    if (response?.status !== 429 && !(response?.status === 503 && header))
        return null;
    const delay = Number(header);
    const requested = typeof header === 'string' && !Number.isFinite(delay) ? Date.parse(header) - at : 1000 * delay;
    // Avoid overflowing the wall clock on a malformed provider response.
    return Number.isFinite(requested) ? Math.min(Math.max(0, requested), 86_400_000) : 0;
}

export function throwOnValuationThrottle(error: unknown, at: number): void {
    const retryAfterMs = valuationRetryDelay(error, at);
    if (retryAfterMs !== null)
        throw new ValuationSourceThrottled(retryAfterMs);
}
