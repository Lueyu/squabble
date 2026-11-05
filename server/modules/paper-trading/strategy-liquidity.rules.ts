import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';

/** Conservative participation proxy; completed daily volume is not a live order book. */
export function measuredLiquidityRisk(snapshot: TradingMarketSnapshot | null | undefined, shares: number): boolean {
  const volumes = snapshot?.candles.slice(-20).map(c => c.volume).filter(v => Number.isFinite(v) && v > 0) ?? [];
  if (volumes.length < 20 || !Number.isFinite(shares) || shares <= 0) return true;
  const sorted = [...volumes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return shares >= median * 0.01;
}
