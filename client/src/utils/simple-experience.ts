export function simpleNavigation(language: string) {
  const zh = language.startsWith('zh');
  return [{ path: '/', label: zh ? '投资总览' : 'Overview', end: true },
    { path: '/paper', label: zh ? '模拟账户' : 'Simulations' },
    { path: '/analysis', label: zh ? '研究报告' : 'Research' },
    { path: '/council', label: zh ? '研究频道' : 'Channel' },
    { path: '/holdings', label: zh ? '资产与账本' : 'Assets & ledger' }];
}

// Historical context takes priority over any live security included in an old link.
export function contextFromSearch(params: URLSearchParams) {
  if (params.get('decisionId')) return { kind: 'decision' as const, orderId: params.get('decisionId')! };
  if (params.get('referenceVersionId')) return { kind: 'report' as const, documentId: params.get('referenceVersionId')! };
  if (params.get('date')) return { kind: 'portfolio' as const, date: params.get('date')! };
  if (params.get('ticker')) return { kind: 'stock' as const, ticker: params.get('ticker')! };
  return undefined;
}

export function highlightedAttention<T>(items: T[]): T[] { return items.slice(0, 3); }

/** Keep the request identity after an uncertain network outcome; clear only on success. */
export function createRequestIntent(generate: () => string) {
  let serialized: string | null = null;
  let requestKey: string | null = null;
  return {
    keyFor(payload: unknown) {
      const next = JSON.stringify(payload);
      if (next !== serialized || !requestKey) { serialized = next; requestKey = generate(); }
      return requestKey;
    },
    complete() { serialized = null; requestKey = null; },
  };
}

export function questionPath(context?: { ticker?: string; market?: string; date?: string; decisionId?: string; versionId?: string }) {
  const query = new URLSearchParams();
  if (context?.decisionId) query.set('decisionId', context.decisionId);
  else if (context?.versionId) query.set('referenceVersionId', context.versionId);
  else if (context?.date) query.set('date', context.date);
  else if (context?.ticker) { query.set('ticker', context.ticker); if (context.market) query.set('market', context.market); }
  return `/council${query.size ? `?${query}` : ''}`;
}
