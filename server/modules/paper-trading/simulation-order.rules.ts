import type { Market } from '../../../shared/api.interface';

/** Exchange lot rules verified 2026-11-05; see docs/mcp-paper-accounts.md. */
export function simulationLotRejection(ticker: string, market: Market, side: 'buy' | 'sell', quantity: number,
  sellable: number, verifiedLotSize?: number | null): string | null {
  if (market === 'US') return null;
  if (market === 'HK') {
    if (!Number.isSafeInteger(verifiedLotSize) || Number(verifiedLotSize) <= 0) return 'HK board lot is unknown; verified instrument metadata required';
    return quantity % Number(verifiedLotSize) ? 'HK odd-lot matching is unsupported; use a verified board lot' : null;
  }
  if (/^68[89]/.test(ticker)) {
    if (quantity > 50_000) return 'STAR market order exceeds 50,000 shares';
    return quantity >= 200 || (side === 'sell' && quantity === sellable) ? null : 'STAR order requires at least 200 shares or the entire residual holding';
  }
  if (quantity > 1_000_000) return 'CN order exceeds 1,000,000 shares';
  if (quantity % 100 === 0) return null;
  return side === 'sell' && quantity === sellable ? null : 'CN board lot requires multiples of 100; odd residual must be sold together';
}
