import type { BuilderProfile } from '../../../shared/api.interface';
import type { CouncilReport } from '../../../shared/council.interface';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';

/** Preserve complete evidence identifiers while packing a bounded subset of researched candidates. */
export function strategyPlanPrompt(profile: BuilderProfile, reports: CouncilReport[], snapshots: TradingMarketSnapshot[],
  expiresAt: string): { prompt: string; evidenceIds: string[]; tickers: string[] } {
  const instruction = `Derive at most 2 conservative daily PAPER rules from completed council reports. Return JSON {"summary":"short","rules":[{"id":"unique","ticker":"symbol","side":"buy|sell","trigger":{"kind":"price_above|price_below|sma20_above|sma20_below|rsi14_above|rsi14_below|volume_ratio_above","value":number},"referencePrice":number,"minPrice":number,"maxPrice":number,"maxPositionPct":number,"stopLossPrice":number,"expiresAt":"ISO UTC","evidenceIds":["exact id"],"rationale":"short"}]}. SMA value multiplies measured SMA20; RSI 0-100. stopLossPrice < minPrice <= referencePrice <= maxPrice. maxPositionPct <= ${profile.config.maxOrderPct}. Expiry after ${new Date().toISOString()} and <= ${expiresAt}. ${profile.config.template === 'guard' ? 'Sell only.' : ''} Empty rules is valid when evidence is insufficient. No invented facts. Language ${profile.config.language ?? 'zh-CN'}. Instructions: ${profile.config.customPrompt.slice(0, 150)}\n`;
  const candidates: Array<{ ticker: string; price: number; indicators: unknown; summary: string; evidence: unknown[] }> = [];
  const evidenceIds: string[] = [];
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    const snapshot = snapshots[index];
    if (!snapshot?.price || !snapshot.indicators || !snapshot.quoteTimestamp) continue;
    const evidence = report.evidence.slice(0, 2).map((item) => ({ id: item.id, title: item.title.slice(0, 45),
      content: item.content.slice(0, 100), fetchedAt: item.fetchedAt }));
    const candidate = { ticker: snapshot.ticker, price: snapshot.price,
      indicators: { sma20: snapshot.indicators.sma20, rsi14: snapshot.indicators.rsi14,
        volumeRatio: snapshot.indicators.volumeRatio }, summary: report.summary.slice(0, 180), evidence };
    if (Buffer.byteLength(instruction + JSON.stringify([...candidates, candidate]), 'utf8') > 4800) break;
    candidates.push(candidate); evidenceIds.push(...evidence.map((item) => item.id));
  }
  if (!candidates.length) throw new Error('No validated market/evidence context fits the strategy budget');
  return { prompt: instruction + JSON.stringify(candidates), evidenceIds, tickers: candidates.map((item) => item.ticker) };
}
