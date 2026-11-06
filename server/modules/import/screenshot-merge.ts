import type { ImportBatchRow } from '../../../shared/screenshot-import.interface';
export function securityIdentity(
  ticker: string,
  explicitMarket?: string,
): {
  key: string;
  ticker: string;
  market: 'US' | 'HK' | 'CN';
  currency: string;
} | null {
  const raw = ticker.trim().toUpperCase();
  if (!raw) return null;
  const market =
    explicitMarket ??
    (/^\d{1,5}\.HK$/.test(raw) || /^\d{4,5}$/.test(raw)
      ? 'HK'
      : /^\d{6}(?:\.(?:SH|SS|SZ|BJ))?$/.test(raw)
        ? 'CN'
        : /^[A-Z][A-Z0-9.-]{0,19}$/.test(raw)
          ? 'US'
          : null);
  if (!market || !['US', 'HK', 'CN'].includes(market)) return null;
  const code =
    market === 'HK'
      ? String(Number(raw.replace(/\.HK$/, ''))).padStart(4, '0')
      : market === 'CN'
        ? raw.replace(/\.(?:SH|SS|SZ|BJ)$/, '')
        : raw;
  if (
    (market === 'US' && !/^[A-Z][A-Z0-9.-]{0,19}$/.test(code)) ||
    (market === 'HK' && !/^\d{4,5}$/.test(code)) ||
    (market === 'CN' && !/^\d{6}$/.test(code))
  )
    return null;
  return {
    key: `${market}:${code}`,
    ticker: code,
    market: market as 'US' | 'HK' | 'CN',
    currency: market === 'HK' ? 'HKD' : market === 'CN' ? 'CNY' : 'USD',
  };
}
/** Repeated page rows carry corroborating sources, never additional shares. */
export function mergeScreenshotRows(input: ImportBatchRow[]): ImportBatchRow[] {
  const result: ImportBatchRow[] = [];
  const identities = new Map<string, ImportBatchRow>();
  for (const incoming of input) {
    const row = structuredClone(incoming),
      identity = securityIdentity(row.ticker, row.market);
    if (!identity) {
      result.push(row);
      continue;
    }
    row.ticker = identity.ticker;
    row.market = identity.market;
    const existing = identities.get(identity.key);
    if (!existing) {
      identities.set(identity.key, row);
      result.push(row);
      continue;
    }
    const oldSources = [...existing.sourceImageIds];
    existing.sourceImageIds = [
      ...new Set([...oldSources, ...row.sourceImageIds]),
    ];
    for (const field of ['shares', 'avgCost', 'currency'] as const) {
      const left = existing[field] ?? null,
        right = row[field] ?? null;
      const same =
        field === 'currency'
          ? left === right
          : left === null || right === null
            ? left === right
            : Number(left) === Number(right);
      if (same) continue;
      // A late recognizer can suggest a value but never overwrite an edited/confirmed one.
      existing.conflicts ??= [];
      let conflict = existing.conflicts.find((item) => item.field === field);
      if (!conflict) {
        conflict = {
          field,
          candidates: [{ value: left, sourceImageIds: oldSources }],
        };
        existing.conflicts.push(conflict);
      }
      const candidate = conflict.candidates.find(
        (item) => JSON.stringify(item.value) === JSON.stringify(right),
      );
      if (candidate)
        candidate.sourceImageIds = [
          ...new Set([...candidate.sourceImageIds, ...row.sourceImageIds]),
        ];
      else
        conflict.candidates.push({
          value: right,
          sourceImageIds: row.sourceImageIds,
        });
      existing.confirmed = false;
    }
  }
  return result;
}
