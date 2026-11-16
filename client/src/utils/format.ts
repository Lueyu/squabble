/**
 * @file utils/format.ts
 * @description 各页面共享的展示格式化工具。
 *
 * 所有函数对 null/undefined 安全：输入缺失时返回稳定的占位字符串而不是抛错。
 * 货币类函数支持多币种展示（USD / CNY / HKD），对应美/港/A 股持仓的原币种。
 *
 * 职责边界：
 *  - 只做"值 → 展示字符串/类名"的纯转换；不做任何请求或状态管理
 * 上下游：
 *  - 上游（谁调用这里）：多页面通用展示格式化（Dashboard/Holdings/Watchlist/
 *    Analysis 等）
 *  - 下游（本文件调用谁）：无外部依赖（纯函数）
 * 关键约定：
 *  - 着色类函数（plClass、ratingColor、signalColor、actionColor）直接返回
 *    Tailwind 类字符串供 JSX 使用：正=success 绿、负=destructive 红、中性=muted
 */

/**
 * 以自适应量级后缀格式化 USD 金额。
 * 大数缩写为 `X.XXB` / `X.XXM`；千位使用分组。空输入返回 `$0.00`。
 * @param value - 数值（接受字符串并解析）。
 * @returns 例如 `$1,234.56`、`$1.20M`；空输入返回 `$0.00`。
 */
export function formatCurrency(value: string | number | null | undefined): string {
  // 步骤 1：空值与非数字一律回退 $0.00。
  if (value === null || value === undefined || value === '') return '$0.00';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '$0.00';
  const abs = Math.abs(num);

  // 步骤 2：按量级选缩写格式（B/M/千分位/两位小数）。
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
 * 以 USD 符号 + 两位小数格式化每股价格。
 * @param value - 价格数值。
 * @returns 例如 `$123.45`；空/非法输入返回 `—`。
 */
export function formatPrice(value: string | number | null | undefined): string {
  // 空值与非数字回退占位符 —。
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return '$' + num.toFixed(2);
}

/**
 * 把比率格式化为带符号的百分比。
 * @param value - 百分数（如 `3.5` → `+3.50%`）。
 * @param digits - 小数位数；默认 2。
 * @returns 例如 `+2.15%`、`-0.80%`；空输入返回 `0.00%`。
 */
export function formatPercent(value: string | number | null | undefined, digits = 2): string {
  // 空值与非数字回退 0.00%。
  if (value === null || value === undefined || value === '') return '0.00%';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0.00%';
  // 正数补 + 号；负数自带 - 号。
  const sign = num > 0 ? '+' : '';
  return sign + num.toFixed(digits) + '%';
}

/**
 * 把普通数字格式化为千位分组 + 固定小数位。
 * @param value - 要格式化的数字。
 * @param digits - 小数位数；默认 2。
 * @returns 本地化数字字符串；空/非法输入返回 `0`。
 */
export function formatNumber(value: string | number | null | undefined, digits = 2): string {
  // 空值与非数字回退 '0'。
  if (value === null || value === undefined || value === '') return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 格式化股数：整数股不带小数，碎股最多保留 4 位小数。
 * @param value - 股数。
 * @returns 例如 `120` 或 `45.5625`。
 */
export function formatShares(value: string | number | null | undefined): string {
  // 空值与非数字回退 '0'。
  if (value === null || value === undefined || value === '') return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

/**
 * 把字符串/Date 强转为合法 Date，非法输入返回 null。
 * @param value - ISO 字符串或 Date 实例。
 * @returns 合法 Date；缺失/非法时返回 null。
 */
export function toDate(value: string | Date | null | undefined): Date | null {
  // 步骤 1：空值直接 null。
  if (!value) return null;
  // 步骤 2：Date 实例校验时间有效性。
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  // 步骤 3：字符串尝试解析并校验。
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * 把日期格式化为本地化的 `YYYY/MM/DD`。
 * @param value - 要格式化的日期。
 * @returns 例如 `2026/10/10`；非法输入返回 `—`。
 */
export function formatDate(value: string | Date | null | undefined): string {
  // 先强转；失败回退占位符。
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * 格式化"日期 + 24 小时制时间"。
 * @param value - 要格式化的日期。
 * @returns 例如 `2026/10/10 14:30`；非法输入返回 `—`。
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  // 先强转；失败回退占位符。
  const date = toDate(value);
  if (!date) return '—';
  // 分别取日期与时间部分再拼接。
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
 * 把 Date 格式化为 `HH:mm:ss` 时钟字符串。
 * @param date - 要格式化的 Date。
 * @returns 例如 `14:30:05`。
 */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 根据盈亏值返回 Tailwind 文字颜色类。
 * @param value - 带符号的盈亏金额。
 * @returns 正数 `text-success`，负数 `text-destructive`，
 *          零/空返回 `text-muted-foreground`。
 */
export function plClass(value: string | number | null | undefined): string {
  // 空值返回空类串。
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  // 非数字或 0 归为中性色。
  if (isNaN(num) || num === 0) return 'text-muted-foreground';
  return num > 0 ? 'text-success' : 'text-destructive';
}

/**
 * 根据英文分析师评级返回徽章类。
 * @param rating - `Strong Buy | Buy | Hold | Sell | Strong Sell`。
 * @returns Tailwind `bg-* text-*` 组合；未知值默认 muted。
 */
export function ratingColor(rating: string | null | undefined): string {
  if (!rating) return 'bg-muted text-muted-foreground';
  // 评级 → 颜色映射。
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
 * 根据中文买卖信号返回徽章类。
 * @param signal - `强烈买入 | 买入 | 观望 | 回避` 之一。
 * @returns Tailwind `bg-* text-*` 组合。
 */
export function signalColor(signal: string | null | undefined): string {
  if (!signal) return 'bg-muted text-muted-foreground';
  // 信号 → 颜色映射。
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
 * 根据中文组合操作建议返回徽章类。
 * @param action - `加仓 | 买入 | 持有 | 减仓 | 卖出 | 观望` 之一。
 * @returns Tailwind `bg-* text-*` 组合。
 */
export function actionColor(action: string | null | undefined): string {
  if (!action) return 'bg-muted text-muted-foreground';
  // 操作建议 → 颜色映射。
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
 * 按给定 ISO 币种代码用正确符号格式化金额。
 * CNY 用 `¥`，HKD 用 `HK$`，其余回退 `$`。
 * @param value - 数值金额。
 * @param currency - ISO 币种代码；默认 USD。
 * @returns 带货币符号的格式化金额。
 */
export function formatCurrencyWithCode(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  // 步骤 1：空值/非法输入递归格式化 '0'（保证币种符号仍正确）。
  if (value === null || value === undefined || value === '')
    return formatCurrencyWithCode('0', currency);
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return formatCurrencyWithCode('0', currency);
  const abs = Math.abs(num);

  // 步骤 2：按量级选缩写格式（与 formatCurrency 同一套阈值）。
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

  // 步骤 3：按币种挑符号。
  const cur = currency.toUpperCase();
  if (cur === 'CNY') return '¥' + formatted;
  if (cur === 'HKD') return 'HK$' + formatted;
  return '$' + formatted;
}

/**
 * 解析 ISO 币种代码对应的展示符号。
 * @param currency - ISO 币种代码。
 * @returns CNY → `CN¥`，HKD → `HK$`，其余 → `$`。
 */
function currencySymbol(currency: string): string {
  const cur = currency.toUpperCase();
  if (cur === 'CNY') return 'CN¥';
  if (cur === 'HKD') return 'HK$';
  return '$';
}

/**
 * 按报价币种选符号格式化每股价格。
 * @param value - 价格数值。
 * @param currency - ISO 币种代码；默认 USD。
 * @returns 例如 `HK$38.50`；空输入返回 `—`。
 */
export function formatPriceWithCurrency(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  // 空值与非数字回退占位符 —。
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return currencySymbol(currency) + num.toFixed(2);
}

/**
 * 带自适应量级后缀 + 正确货币符号的金额格式化。
 * 用于渲染原币种市值（USD / CNY / HKD）。
 * @param value - 数值金额。
 * @param currency - ISO 币种代码；默认 USD。
 * @returns 格式化金额，例如 `HK$1.20M`、`¥3,456.78`。
 */
export function formatCurrencyWithCurrency(
  value: string | number | null | undefined,
  currency: string = 'USD',
): string {
  // 步骤 1：空值/非法输入递归格式化 '0'（保证币种符号仍正确）。
  if (value === null || value === undefined || value === '') {
    return formatCurrencyWithCurrency('0', currency);
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return formatCurrencyWithCurrency('0', currency);
  const abs = Math.abs(num);

  // 步骤 2：按量级选缩写格式（与 formatCurrency 同一套阈值）。
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

  // 步骤 3：按币种挑符号。
  return currencySymbol(currency) + formatted;
}

/**
 * 拼接条件类名，跳过假值。
 * 注意：这只是简单的字符串拼接工具；需要 Tailwind 类冲突消解时请改用
 * `lib/utils.ts` 的 `cn`。
 * @param classes - 要合并的类名。
 * @returns 空格分隔的类名串。
 */
export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
