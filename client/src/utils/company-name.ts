/**
 * @file utils/company-name.ts
 * @description 双语公司名的展示名挑选（英文 UI 优先取英文名）。
 *
 * 职责边界：
 *  - 只做展示层挑选：绝不改写记录、也不猜测公司身份
 * 上下游：
 *  - 上游（谁调用这里）：AgentRunDetailModal、Dashboard/DailyPnLBreakdown、
 *    DashboardPage、Analysis/AnalysisRunner、Analysis/AnalysisPage
 *  - 下游（本文件调用谁）：无外部依赖（纯函数）
 * 关键约定：
 *  - 单语言/自定义名称原样保留；缺名与"和 ticker 同名"的情况返回 null（不展示）
 */

/**
 * 从双语公司标签中挑出英文名（英文 UI 场景）。
 * 单语言/自定义名称保持原样：展示层不得改写记录或猜测公司身份。
 * 缺名与 ticker 重名的情况一律返回 null。
 * @param company - 原始公司名（可能是"中文 (English)"双语形式）。
 * @param ticker - 该条目的 ticker，用于剔除与代码同名的占位名称。
 * @param language - 当前 UI 语言（'en' 开头时尝试提取括号内的英文名）。
 * @returns 可展示的名称；无合适名称时返回 null。
 */
export function displayCompanyName(
  company: string | null | undefined,
  ticker: string,
  language: string,
): string | null {
  // 步骤 1：trim 后空名直接返回 null。
  const name = (company ?? '').trim();
  if (!name) return null;

  // 步骤 2：与 ticker 基名（去后缀、大写）相同视为占位名，返回 null。
  const base = (value: string): string => value.split('.')[0].toUpperCase();
  if (base(name) === base(ticker)) return null;

  // 步骤 3：英文 UI 下尝试从"中文 (English)"括号里提取英文名。
  if (language.startsWith('en')) {
    // 匹配"主体 + 全角/半角括号"结构；主体须含汉字、括号内须是纯英文。
    const bilingual = name.match(/^(.*?)\s*[(（]([^()（）]+)[)）]$/u);
    if (
      bilingual &&
      /\p{Script=Han}/u.test(bilingual[1]) &&
      /[A-Za-z]/u.test(bilingual[2]) &&
      !/\p{Script=Han}/u.test(bilingual[2])
    ) {
      return bilingual[2].trim();
    }
  }
  return name;
}
