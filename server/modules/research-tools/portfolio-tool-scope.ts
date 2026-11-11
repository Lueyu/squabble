export interface FrozenPortfolioInstrument {
  instrumentId: string; ticker: string; market: 'CN' | 'HK' | 'US'; exchange: string | null;
}

/** Only saved owner-context facts grant portfolio query scope; live ledger rows are never consulted. */
export function frozenPortfolioInstruments(evidence: Array<{ sourceName: string; content: string }>,
  allowedIds?: readonly string[]): FrozenPortfolioInstrument[] {
  const instruments = new Map<string, FrozenPortfolioInstrument>();
  for (const item of evidence.filter(source => source.sourceName === 'Frozen owner context')) {
    let payload: unknown;
    try { payload = JSON.parse(item.content); } catch { throw new Error('FROZEN_PORTFOLIO_INVALID'); }
    if (!payload || typeof payload !== 'object' || !('holdings' in payload) || !Array.isArray(payload.holdings)) throw new Error('FROZEN_PORTFOLIO_INVALID');
    for (const raw of payload.holdings) {
      if (!raw || typeof raw !== 'object' || typeof raw.ticker !== 'string' || !['CN','HK','US'].includes(raw.market)
        || !/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(raw.ticker.toUpperCase())) throw new Error('FROZEN_PORTFOLIO_INVALID');
      const instrumentId = `${raw.market}:${raw.ticker.toUpperCase()}`;
      if (allowedIds && !allowedIds.some(id => id.toUpperCase() === instrumentId)) continue;
      instruments.set(instrumentId, { instrumentId, ticker: raw.ticker.toUpperCase(), market: raw.market,
        exchange: typeof raw.exchange === 'string' ? raw.exchange : null });
    }
  }
  return [...instruments.values()];
}

export function requireFrozenInstrument(instruments: FrozenPortfolioInstrument[], id: string): FrozenPortfolioInstrument {
  const instrument = instruments.find(item => item.instrumentId === id.toUpperCase());
  if (!instrument) throw new Error('INSTRUMENT_OUTSIDE_FROZEN_PORTFOLIO');
  return instrument;
}
