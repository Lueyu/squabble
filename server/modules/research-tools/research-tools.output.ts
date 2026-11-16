/**
 * Research tools output shaping（研究工具结果整形）。
 *
 * 职责边界：把各研究工具的原始产出规整为可下发 LLM 的安全形态——剥控制
 * 字符、把时间统一为 ISO、构造"仅引用"性质的来源链接、统一失败结果、
 * 并按字节预算（RESULT_LIMIT_BYTES）递归裁剪结果体。不负责执行工具。
 *
 * 上下游：import @shared/research-tools.interface 类型、RESULT_LIMIT_BYTES
 * 与 validOutput（./research-tools.registry）；本文件导出的工具函数主要
 * 被 research-tools.service.ts 使用。
 *
 * 关键约定：citationUrl 只保留 http/https 且不含凭据的 URL（用户名/密码/
 * 疑似 token 的查询参数一律丢弃、剥离 #fragment）——来源链接只是引用，
 * 绝不是抓取目标或凭据容器；字节上限按 UTF-8 计（含中日韩文本，超出
 * ASCII 的估算不可靠）。
 */
import type { ResearchSource, ResearchToolResult } from '@shared/research-tools.interface';
import { RESULT_LIMIT_BYTES, validOutput } from './research-tools.registry';

/** 字符串裁剪：去掉 C0 控制字符（保留 \t\n\r），截断到 maximum 字符。 */
export function clipped(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ' ').slice(0, maximum)
    : '';
}

/** 任意输入转 ISO 时间串；无法解析返回 null。 */
export function isoDate(value: unknown): string | null {
  const date: Date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 来源链接只是引用，绝不是抓取目标或凭据容器。 */
export function citationUrl(value: unknown): string | undefined {
  // 长度护栏：超 2000 字符直接放弃。
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url: URL = new URL(value);
    // 仅 http/https；带用户名/密码（URL 内嵌凭据）的链接直接丢弃。
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    // 查询参数名疑似携带凭据（token/api key/authorization/secret 等）则丢弃整条链接。
    if (
      [...url.searchParams.keys()].some((key: string) =>
        /token|api[_-]?key|authorization|secret|password|signature/i.test(key),
      )
    )
      return undefined;
    // 剥掉 #fragment（往往含一次性状态），返回净化后的 URL。
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** 构造一条来源引用：标题裁剪 160 字符，URL 经 citationUrl 净化。 */
export function researchSource(title: unknown, url: unknown, fetchedAt: string): ResearchSource {
  const link: string | undefined = citationUrl(url);
  return {
    title: clipped(title, 160) || 'Source not reported',
    fetchedAt,
    ...(link ? { url: link } : {}),
  };
}

/**
 * 构造统一的失败结果。started=true 表示上游请求可能已经发出——补一条
 * completion 说明：该请求可能仍在继续，其完成状态与供应商计费未知。
 */
export function researchFailure(
  status: ResearchToolResult['status'],
  errorCode: string,
  started = false,
): ResearchToolResult {
  return {
    status,
    errorCode,
    data: {
      message: errorCode,
      ...(started
        ? {
            completion:
              'The upstream request may still continue; its completion and any provider charge are unknown.',
          }
        : {}),
    },
    sources: [],
    asOf: new Date().toISOString(),
    truncated: false,
  };
}

/** 结果裁剪后仍是合法结构化 JSON；字节上限按含 CJK 的 UTF-8 计算。 */
export function boundedResult(result: ResearchToolResult): ResearchToolResult {
  // 第一步：结构化清洗——字符串剥控制字符并限长、数组限 12 项、对象限 32
  // 键、深度限 8 层；任何被裁剪的动作都置 shortened。
  let shortened: boolean = result.truncated;
  const clean = (value: unknown, depth = 0, stringLimit = 3000): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length > stringLimit) shortened = true;
      return clipped(value, stringLimit);
    }
    if (Array.isArray(value)) {
      if (value.length > 12) shortened = true;
      return value.slice(0, 12).map((item: unknown) => clean(item, depth + 1, stringLimit));
    }
    if (value && typeof value === 'object' && depth < 8) {
      const entries: [string, unknown][] = Object.entries(value);
      if (entries.length > 32) shortened = true;
      return Object.fromEntries(
        entries
          .slice(0, 32)
          .map(([key, item]: [string, unknown]) => [key, clean(item, depth + 1, stringLimit)]),
      );
    }
    // 其余类型（函数/undefined/超深对象）不安全，替换为 null 并标记。
    shortened = true;
    return null;
  };
  // 第二步：sources 先按 12 条截断。
  let data: unknown = clean(result.data);
  const sources: ResearchSource[] = result.sources.slice(0, 12);
  if (sources.length < result.sources.length) shortened = true;
  let bounded: ResearchToolResult = { ...result, data, sources, truncated: shortened };
  // 第三步：逐级压缩——字符串上限 1500→700→300→100，直到字节预算满足。
  for (const maximum of [1500, 700, 300, 100]) {
    if (Buffer.byteLength(JSON.stringify(bounded)) <= RESULT_LIMIT_BYTES) break;
    data = clean(data, 0, maximum);
    bounded = { ...bounded, data, truncated: true };
  }
  // 第四步：仍然超预算则退化为 partial 失败；schema 校验不过则退化为 failed。
  if (Buffer.byteLength(JSON.stringify(bounded)) > RESULT_LIMIT_BYTES) {
    return { ...researchFailure('partial', 'RESEARCH_RESULT_LIMIT'), truncated: true };
  }
  return validOutput(bounded) ? bounded : researchFailure('failed', 'RESEARCH_INVALID_RESULT');
}
