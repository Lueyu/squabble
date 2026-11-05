import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ResearchWebService } from '../multi-agent/research-web.service';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import type { InvestmentConfig, VerifiedInvestmentSecurity } from '../../../shared/investment-policy.interface';

export interface DiscoveryIdentity {
  symbol: string; quoteType: string; exchange: string; sourceUrl: string; leveraged?: boolean; inverse?: boolean;
}
const candidateSchema = z.object({ ticker: z.string().min(1).max(20), sourceUrl: z.string().url(), summary: z.string().min(1).max(1000) }).strict();
const SPY_ISSUER = 'https://www.ssga.com/us/en/institutional/etfs/state-street-spdr-sp-500-etf-trust-spy';
/** Explicit issuer objective establishes positive single-index exposure; unknown funds stay excluded. */
export function verifiedIssuerEtfExposure(ticker: string, url: string, body: string): boolean {
  if (ticker !== 'SPY' || url !== SPY_ISSUER) return false;
  const plain = body.replace(/<[^>]+>/gu, ' ').replace(/&(?:amp|#38);/gu, '&').replace(/&(?:reg|#174);|®/gu, '').replace(/\s+/gu, ' ');
  return /\bSPY\b/u.test(plain) && /SPDR.{0,30}S&P\s*500.{0,30}ETF Trust/iu.test(plain)
    && /correspond generally to the price and yield performance of the S&P\s*500/iu.test(plain);
}

/** Discovery has its own parent-authorized scope. Ordinary stock tools are never broadened. */
@Injectable()
export class ResearchDiscoveryService {
  constructor(private readonly web: ResearchWebService, private readonly market: TradingMarketService) {}
  async lookupSecurity(ticker: string): Promise<DiscoveryIdentity | null> {
    const resolved = resolveTradingTicker(ticker); if (!resolved) return null;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(resolved.providerSymbol)}&quotesCount=5&newsCount=0`;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 200000) return null;
    const data = await response.json() as { quotes?: Array<{ symbol?: string; quoteType?: string; exchange?: string }> };
    const match = data.quotes?.find(q => q.symbol?.toUpperCase() === resolved.providerSymbol.toUpperCase());
    if (!match?.symbol || !match.quoteType || !match.exchange) return null;
    if (match.quoteType === 'ETF' && resolved.ticker === 'SPY') {
      const issuer = await fetch(SPY_ISSUER, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!issuer.ok || Number(issuer.headers.get('content-length') ?? 0) > 2_000_000) return null;
      const reader = issuer.body?.getReader(); if (!reader) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 2_000_000) { await reader.cancel(); return null; } chunks.push(next.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (!verifiedIssuerEtfExposure(resolved.ticker, SPY_ISSUER, new TextDecoder().decode(bytes))) return null;
      return { symbol: match.symbol, quoteType: match.quoteType, exchange: match.exchange, sourceUrl: SPY_ISSUER, leveraged: false, inverse: false };
    }
    return { symbol: match.symbol, quoteType: match.quoteType, exchange: match.exchange, sourceUrl: url };
  }
  async verify(raw: { ticker: string; sourceUrl: string; summary: string }, config: InvestmentConfig): Promise<VerifiedInvestmentSecurity | null> {
    const resolved = resolveTradingTicker(raw.ticker.toUpperCase());
    if (!resolved || !config.markets.includes(resolved.market)) return null;
    const identity = await this.lookupSecurity(resolved.ticker);
    if (!identity || identity.symbol.toUpperCase() !== resolved.providerSymbol.toUpperCase()) return null;
    const assetType = identity.quoteType === 'EQUITY' ? 'stock' : identity.quoteType === 'ETF' ? 'etf' : null;
    // A price or fund name cannot establish non-leverage. Unknown ETF attributes stay excluded.
    if (!assetType || !config.assetTypes.includes(assetType) || assetType === 'etf' && (identity.leveraged !== false || identity.inverse !== false)) return null;
    const quote = await this.market.getSnapshot(resolved.ticker);
    if (!quote.quoteUsable || !quote.price || !quote.quoteTimestamp || quote.market !== resolved.market || quote.currency !== resolved.currency
      || quote.providerSymbol.toUpperCase() !== resolved.providerSymbol.toUpperCase() || !Number.isInteger(quote.lotSize) || Number(quote.lotSize) <= 0) return null;
    return { ticker: resolved.ticker, market: resolved.market, currency: resolved.currency, assetType, identitySourceUrl: identity.sourceUrl,
      sourceUrl: raw.sourceUrl, summary: raw.summary, observedAt: new Date().toISOString(), providerSymbol: resolved.providerSymbol,
      lotSize: quote.lotSize!, leveraged: false, inverse: false };
  }
  async discoverCandidates(owner: string, config: InvestmentConfig, taskId: string, shouldContinue: () => Promise<boolean>,
    extract: (sources: unknown[]) => Promise<unknown>) {
    const sources: Array<{ sourceUrl: string; content: string; title: string }> = [];
    for (const market of config.markets) {
      if (!await shouldContinue()) throw new Error('INVESTMENT_CYCLE_CANCELLED');
      const acquired = await this.web.search(owner, market, 'en', { taskId, webResearch: true,
        query: `${market} ordinary listed stocks recent company filings investment candidates exclude leveraged inverse funds`, shouldContinue });
      sources.push(...acquired.flatMap(item => item.sourceUrl ? [{ sourceUrl: item.sourceUrl, content: item.content, title: item.title }] : []));
    }
    if (!sources.length) return { candidates: [] as VerifiedInvestmentSecurity[], excluded: [], reason: 'DISCOVERY_SOURCE_UNAVAILABLE' };
    const output = z.object({ candidates: z.array(candidateSchema).max(10) }).strict().parse(await extract(sources));
    const candidates: VerifiedInvestmentSecurity[] = []; const excluded: Array<{ ticker: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const raw of output.candidates.slice(0, Math.min(10, config.budget.maxDiscoveryCandidates))) {
      const identity = resolveTradingTicker(raw.ticker.toUpperCase());
      const key = identity ? `${identity.market}:${identity.providerSymbol}` : raw.ticker.toUpperCase();
      if (seen.has(key)) continue; seen.add(key);
      if (!sources.some(source => source.sourceUrl === raw.sourceUrl)) { excluded.push({ ticker: raw.ticker, reason: 'UNVERIFIED_DISCOVERY_SOURCE' }); continue; }
      if (!await shouldContinue()) throw new Error('INVESTMENT_CYCLE_CANCELLED');
      const verified = await this.verify(raw, config).catch(() => null);
      if (verified) candidates.push(verified); else excluded.push({ ticker: raw.ticker, reason: 'SECURITY_IDENTITY_ASSET_OR_QUOTE_UNVERIFIED' });
    }
    return { candidates, excluded, reason: candidates.length ? null : 'NO_VERIFIED_CANDIDATES' };
  }
}
