/**
 * Research tools registry（研究工具注册表）。
 *
 * 职责边界：定义 council/研究会话允许 LLM 调用的全部研究工具白名单——
 * 每个工具的名字、描述、超时、输入 zod schema、research kind 与
 * openWorld 标志；同时给出执行边界共用的输出 schema 与请求/输出校验
 * 函数。工具的具体执行在 research-tools.service.ts，本文件只做声明。
 *
 * 上下游：import zod、@shared/research-tools.interface（描述符类型）、
 * @shared/council.interface（CouncilResearchKind）；RESEARCH_TOOLS/
 * toolDescriptor/validRequest/validOutput 被 research-tools.service.ts
 * （执行边界）与 multi-agent/mcp 桥（工具清单下发）使用。
 *
 * 关键约定：RESULT_LIMIT_BYTES=24_000——单个工具结果序列化后的字节上限
 * （超出由 service 截断并置 truncated）；annotations 恒为
 * readOnlyHint=true/destructiveHint=false（全部只读）；kind 用于把工具
 * 映射到 council 的 research 维度（financials/valuation/news/web）。
 */
import { z } from 'zod';
import type { ResearchToolDescriptor } from '@shared/research-tools.interface';
import type { CouncilResearchKind } from '@shared/council.interface';

/** 单个工具结果允许的最大字节数（超出截断）。 */
export const RESULT_LIMIT_BYTES = 24_000;
const emptyInput = z.strictObject({});
const evidenceInput = z.strictObject({ limit: z.number().int().min(1).max(10).optional() });
const output = z.strictObject({
  status: z.enum(['succeeded', 'partial', 'unavailable', 'failed', 'cancelled']),
  data: z.record(z.string().max(64), z.json()),
  sources: z
    .array(
      z.strictObject({
        title: z.string().max(160),
        url: z.string().max(2000).optional(),
        fetchedAt: z.string().max(40),
      }),
    )
    .max(12),
  asOf: z.string().max(40),
  truncated: z.boolean(),
  errorCode: z.string().max(80).optional(),
});

export interface ResearchToolDefinition {
  name: string;
  description: string;
  source: string;
  timeoutMs: number;
  input: z.ZodType;
  kind?: CouncilResearchKind;
  openWorld: boolean;
}

/** 该白名单同时也是执行边界使用的 schema 注册表。 */
export const RESEARCH_TOOLS: readonly ResearchToolDefinition[] = [
  {
    name: 'get_quotes',
    description:
      'Latest available quote for this discussion ticker, with currency and retrieval time.',
    source: 'Configured market-data provider (exact provider is not reported)',
    timeoutMs: 20_000,
    input: emptyInput,
    openWorld: true,
  },
  {
    name: 'get_financials',
    description: 'Verified reported financial evidence; missing fields remain explicit gaps.',
    source: 'Configured financial evidence providers and SEC filings',
    timeoutMs: 45_000,
    input: evidenceInput,
    kind: 'financials',
    openWorld: true,
  },
  {
    name: 'get_valuation',
    description: 'Available sourced valuation evidence for this discussion ticker.',
    source: 'Configured valuation evidence provider',
    timeoutMs: 25_000,
    input: evidenceInput,
    kind: 'valuation',
    openWorld: true,
  },
  {
    name: 'get_news',
    description: 'Available sourced company news; no inferred sentiment or fabricated headlines.',
    source: 'Configured company-news evidence provider',
    timeoutMs: 25_000,
    input: evidenceInput,
    kind: 'news',
    openWorld: true,
  },
  {
    name: 'get_research_report',
    description: 'Recent saved research reports owned by this account for the assigned ticker.',
    source: 'Saved account research reports',
    timeoutMs: 10_000,
    input: z.strictObject({ limit: z.number().int().min(1).max(3).optional() }),
    openWorld: false,
  },
  {
    name: 'get_discussion_context',
    description: 'Bounded public discussion history and dated saved evidence from this session.',
    source: 'Assigned discussion session',
    timeoutMs: 10_000,
    input: z.strictObject({ limit: z.number().int().min(1).max(12).optional() }),
    openWorld: false,
  },
  {
    name: 'search_research_web',
    description:
      'Search public sources for this ticker using the existing task and daily request budgets.',
    source: 'Configured DeepSeek web search',
    timeoutMs: 25_000,
    input: z.strictObject({
      query: z
        .string()
        .trim()
        .max(200)
        // 禁止任何 C0 控制字符进入搜索词。
        .regex(/^[^\u0000-\u001f]*$/u)
        .optional(),
    }),
    kind: 'web',
    openWorld: true,
  },
];

/** 把工具定义转换为下发用的描述符（zod schema 转 JSON Schema）。 */
export function toolDescriptor(tool: ResearchToolDefinition): ResearchToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(output) as Record<string, unknown>,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: tool.openWorld },
  };
}

/** 执行边界请求校验：callId/name/arguments 三元组，callId 字符集受限。 */
export function validRequest(
  value: unknown,
): value is { callId: string; name: string; arguments: Record<string, unknown> } {
  return z
    .strictObject({
      callId: z
        .string()
        .min(1)
        .max(128)
        // 只允许字母数字与 _ . : -（防止把控制字符/空白塞进调用 id）。
        .regex(/^[a-zA-Z0-9_.:-]+$/u),
      name: z.string().min(1).max(64),
      arguments: z.record(z.string(), z.unknown()),
    })
    .safeParse(value).success;
}

/** 执行边界输出校验：结果必须匹配统一 output schema。 */
export function validOutput(value: unknown): boolean {
  return output.safeParse(value).success;
}
