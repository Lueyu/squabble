/**
 * @file utils/format.ts
 * @brief Display formatting helpers shared across pages.
 *
 * All functions are null/undefined-safe and return a stable placeholder string
 * for missing input rather than throwing. Currency helpers support multi-currency
 * display (USD / CNY / HKD) used by holdings across US/HK/CN markets.
 *
 * Coloring helpers (`plClass`, `ratingColor`, `signalColor`, `actionColor`)
 * return Tailwind class strings consumed directly in JSX; positive = success
 * green, negative = destructive red, neutral = muted.
 */

/**
 * Format a USD-denominated amount with adaptive magnitude suffix.
 * Large numbers are shortened to `X.XXB` / `X.XXM`; thousands use grouping.
 * @param value - Numeric amount (string accepted and parsed).
 * @returns e.g. `$1,234.56`, `$1.20M`, `$0.00` for empty input.
 */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '$0.00';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '$0.00';
  const abs = Math.abs(num);
  let formatted: string;
  if (abs >= 1e9) {
    formatted = (num / 1e9).toFixed(2) + 'B';
  } else if (abs >= 1e6) {
    formatted = (num / 1e6).toFixed(2) + 'M';
  } else if (abs >= 1e3) {
    formatted = num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else {
    formatted = num.toFixed(2);
  }
  return '$' + formatted;
}

/**
 * Format a per-share price with USD symbol and two decimals.
 * @param value - Price value.
 * @returns e.g. `$123.45`, or `—` for empty/invalid input.
 */
export function formatPrice(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return '$' + num.toFixed(2);
}

/**
 * Format a ratio as a signed percentage.
 * @param value - Percent number (e.g. `3.5` -> `+3.50%`).
 * @param digits - Decimal places; defaults to 2.
 * @returns e.g. `+2.15%`, `-0.80%`, `0.00%` for empty input.
 */
export function formatPercent(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '0.00%';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0.00%';
  const sign = num > 0 ? '+' : '';
  return sign + num.toFixed(digits) + '%';
}

/**
 * Format a plain number with thousands grouping and a fixed number of decimals.
 * @param value - Number to format.
 * @param digits - Decimal places; defaults to 2.
 * @returns Localized number string, or `0` for empty/invalid input.
 */
export function formatNumber(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Format a share count: whole shares shown without decimals, fractional
 * positions up to 4 decimal places.
 * @param value - Number of shares.
 * @returns e.g. `120` or `45.5625`.
 */
export function formatShares(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

/**
 * Coerce a string/Date value into a valid Date, returning null on bad input.
 * @param value - ISO string or Date instance.
 * @returns A valid Date, or null when missing/invalid.
 */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Format a date as a localized `YYYY/MM/DD` string.
 * @param value - Date to format.
 * @returns e.g. `2026/10/10`, or `—` for invalid input.
 */
export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Format a date with both date and 24h time components.
 * @param value - Date to format.
 * @returns e.g. `2026/10/10 14:30`, or `—` for invalid input.
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const dateStr = date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeStr = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${dateStr} ${timeStr}`;
}

/**
 * Format a Date as a `HH:mm:ss` wall-clock string.
 * @param date - Date to format.
 * @returns e.g. `14:30:05`.
 */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Return the Tailwind text color class for a P/L value.
 * @param value - Signed P/L amount.
 * @returns `text-success` for positive, `text-destructive` for negative,
 *          `text-muted-foreground` for zero/empty.
 */
export function plClass(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || num === 0) return 'text-muted-foreground';
  return num > 0 ? 'text-success' : 'text-destructive';
}

/**
 * Return badge classes for an English analyst rating.
 * @param rating - `Strong Buy | Buy | Hold | Sell | Strong Sell`.
 * @returns Tailwind `bg-* text-*` pair; default muted for unknown values.
 */
export function ratingColor(rating: string | null | undefined): string {
  if (!rating) return 'bg-muted text-muted-foreground';
  switch (rating) {
    case 'Strong Buy':
    case 'Buy':
      return 'bg-muted text-success';
    case 'Hold':
      return 'bg-muted text-warning';
    case 'Sell':
    case 'Strong Sell':
      return 'bg-muted text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Return badge classes for a Chinese buy/hold/sell signal.
 * @param signal - One of `强烈买入 | 买入 | 观望 | 回避`.
 * @returns Tailwind `bg-* text-*` pair.
 */
export function signalColor(signal: string | null | undefined): string {
  if (!signal) return 'bg-muted text-muted-foreground';
  switch (signal) {
    case '强烈买入':
    case '买入':
      return 'bg-muted text-success';
    case '观望':
      return 'bg-muted text-warning';
    case '回避':
      return 'bg-muted text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Return badge classes for a Chinese portfolio action recommendation.
 * @param action - One of `加仓 | 买入 | 持有 | 减仓 | 卖出 | 观望`.
 * @returns Tailwind `bg-* text-*` pair.
 */
export function actionColor(action: string | null | undefined): string {
  if (!action) return 'bg-muted text-muted-foreground';
  switch (action) {
    case '加仓':
    case '买入':
      return 'bg-muted text-success';
    case '持有':
      return 'bg-muted text-warning';
    case '减仓':
    case '卖出':
      return 'bg-muted text-destructive';
    case '观望':
      return 'bg-muted text-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Format an amount with the correct currency symbol for the given ISO code.
 * CNY uses `¥`, HKD uses `HK$`, anything else falls back to `$`.
 * @param value - Numeric amount.
 * @param currency - ISO currency code; defaults to USD.
 * @returns Formatted amount with currency symbol.
 */
export function formatCurrencyWithCode(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  if (value === null || value === undefined || value === '')
    return formatCurrencyWithCode('0', currency);
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return formatCurrencyWithCode('0', currency);
  const abs = Math.abs(num);
  let formatted: string;
  if (abs >= 1e9) {
    formatted = (num / 1e9).toFixed(2) + 'B';
  } else if (abs >= 1e6) {
    formatted = (num / 1e6).toFixed(2) + 'M';
  } else if (abs >= 1e3) {
    formatted = num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else {
    formatted = num.toFixed(2);
  }
  const cur = currency.toUpperCase();
  if (cur === 'CNY') return '¥' + formatted;
  if (cur === 'HKD') return 'HK$' + formatted;
  return '$' + formatted;
}

/**
 * Resolve the display symbol for an ISO currency code.
 * @param currency - ISO currency code.
 * @returns `CN¥` for CNY, `HK$` for HKD, otherwise `$`.
 */
function currencySymbol(currency: string): string {
  const cur = currency.toUpperCase();
  if (cur === 'CNY') return 'CN¥';
  if (cur === 'HKD') return 'HK$';
  return '$';
}

/**
 * Format a per-share price with the currency symbol appropriate to its quote currency.
 * @param value - Price value.
 * @param currency - ISO currency code; defaults to USD.
 * @returns e.g. `HK$38.50`, or `—` for empty input.
 */
export function formatPriceWithCurrency(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return currencySymbol(currency) + num.toFixed(2);
}

/**
 * Format an amount with adaptive magnitude suffix and the correct currency symbol.
 * Used when rendering native-currency market values (USD / CNY / HKD).
 * @param value - Numeric amount.
 * @param currency - ISO currency code; defaults to USD.
 * @returns Formatted amount, e.g. `HK$1.20M`, `¥3,456.78`.
 */
export function formatCurrencyWithCurrency(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  if (value === null || value === undefined || value === '') {
    return formatCurrencyWithCurrency('0', currency);
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return formatCurrencyWithCurrency('0', currency);
  const abs = Math.abs(num);
  let formatted: string;
  if (abs >= 1e9) {
    formatted = (num / 1e9).toFixed(2) + 'B';
  } else if (abs >= 1e6) {
    formatted = (num / 1e6).toFixed(2) + 'M';
  } else if (abs >= 1e3) {
    formatted = num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else {
    formatted = num.toFixed(2);
  }
  return currencySymbol(currency) + formatted;
}

/**
 * Join conditional class names, dropping falsy values.
 * Note: this is a simple string-join helper; for Tailwind conflict resolution
 * use `cn` from `lib/utils.ts` instead.
 * @param classes - Class names to merge.
 * @returns Space-separated class string.
 */
export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
