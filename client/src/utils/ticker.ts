/**
 * @file client/src/utils/ticker.ts
 * @description 跨数据源归一化 ticker 代码的工具。
 *
 * 同一只股票在不同数据源里的写法不一致：持仓表把港股代码按 4 位补零存储
 * （'0700'），行情源返回 5 位代码（'00700'）或带后缀形式（'700.HK'），
 * A 股行情带后缀返回（'600519.SH'）而持仓表存裸代码。任何需要"用持仓
 * ticker 查行情（或反过来）"的地方都通过 {@link tickerVariants} 解析 ——
 * 它枚举出全部等价写法，于是用任意一种写法建索引，其余写法也都能命中。
 *
 * 职责边界：
 *  - 只做代码形态枚举；市场推断（inferMarket）在 hooks/use-market-quotes.ts
 * 上下游：
 *  - 上游（谁调用这里）：hooks/use-market-quotes.ts 以
 *    tickerVariants(q.symbol, q.market ?? market) 建行情索引键
 *  - 下游（本文件调用谁）：无外部依赖（纯函数）
 * 关键约定：
 *  - 返回数组永远包含输入本身（trim + 大写后的形式）
 */
import type { Market } from '@shared/api.interface';

/**
 * 枚举一个 ticker 的全部等价写法。
 *  - HK: '0700' -> ['0700', '00700', '700', '700.HK', '00700.HK']
 *  - CN: '600519.SH' -> ['600519.SH', '600519']
 *  - US: 'NVDA' -> ['NVDA']（大写原样）
 * 输入本身永远包含在返回值里。
 */
export function tickerVariants(rawTicker: string, _market?: Market): string[] {
  // 统一 trim + 大写，并以输入本身为种子。
  const s = (rawTicker ?? '').trim().toUpperCase();
  const out = new Set<string>([s]);

  // 港股：1-5 位数字，可带 .HK 后缀。
  const hkMatch = /^(\d{1,5})(?:\.HK)?$/.exec(s);
  if (hkMatch) {
    const digits = hkMatch[1];
    // 去掉前导零得到裸数字；全零时保留原样。
    const unpadded = digits.replace(/^0+/, '') || digits;
    out.add(unpadded); // '700'
    out.add(unpadded.padStart(4, '0')); // '0700'（持仓存储形态）
    out.add(unpadded.padStart(5, '0')); // '00700'（行情源形态）
    out.add(`${unpadded}.HK`);
    out.add(`${unpadded.padStart(5, '0')}.HK`);
    out.add(digits);
  }

  // A 股：6 位数字，可带 .SH/.SZ/.BJ 后缀。
  const cnMatch = /^(\d{6})(?:\.(SH|SZ|BJ))?$/.exec(s);
  if (cnMatch) {
    const code = cnMatch[1];
    out.add(code); // 裸代码（持仓存储形态）
    out.add(`${code}.${cnMatch[2] ?? 'SH'}`); // 行情源形态（缺后缀按 SH）
  }

  return [...out];
}
