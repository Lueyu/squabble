/**
 * research-web.service.ts — 通过 DeepSeek 官方 web search 工具抓取公开网页证据，
 * 带配额预留与采集进度上报。
 *
 * 职责边界：
 *  - 负责：调用 DeepSeek 搜索端点、解析/清洗结果（URL 白名单、文本净化、大小上限）、
 *    通过 ResearchToolsBudgetService 预留与结算请求槽位、通过 onAcquisition 上报采集状态。
 *  - 不负责：财报证据、行情或新闻 API（由其他 evidence 服务处理）。
 * 上下游：
 *  - 上游（谁调用这里）：EvidenceService 在收集网页证据阶段调用 search。
 *  - 下游（本文件调用谁）：SettingsService（读取用户的 DeepSeek 搜索配置）、
 *    ResearchToolsBudgetService（reserve/settle）、DeepSeek web search API、
 *    @shared/council.interface 的 ResearchAcquisition 类型。
 * 关键约定：
 *  - 只接受 https://api.deepseek.com 官方来源的配置，非官方配置直接跳过（skipped）。
 *  - 网页摘录永远不作为已核实财报使用（证据文案中明确标注）。
 *  - 槽位失败语义：结果不确定的失败也结算为 failed，不退还（由预算服务保证）。
 */
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ResearchToolsBudgetService } from './research-tools-budget.service';
import type { EvidenceCollectionOptions, EvidenceInput } from './evidence.service';
import type { ResearchAcquisition } from '@shared/council.interface';

// DeepSeek 官方搜索端点与响应体大小上限（2MiB）。
const SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
const MAX_BYTES = 2 * 1024 * 1024;

// 文本净化：剥掉 HTML 标签与控制字符、折叠空白、截断到 maximum 长度；非字符串一律空串。
function text(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum)
    : '';
}

// 来源 URL 白名单校验：仅 https、不带凭据、端口只允许空或 443、拒绝内网/本地/测试域、
// 拒绝纯数字 IP 形式的主机名、拒绝疑似携带密钥的查询参数；通过则剥离 hash 后返回。
function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url: URL = new URL(value);
    const host: string = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !host.includes('.') ||
      host.includes(':') ||
      /^[\d.]+$/.test(host) ||
      /(?:^|\.)(localhost|local|internal|invalid|test|example)$/.test(host)
    )
      return undefined;
    // 查询串里出现 token/api key/authorization/secret 之类参数视为泄漏风险，拒绝该来源
    if (
      [...url.searchParams.keys()].some((key: string) =>
        /^(token|api[_-]?key|authorization|secret)$/i.test(key),
      )
    )
      return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

// 把 DeepSeek 返回的 results 解析为证据条目：最多取 3 条，缺 URL/标题/摘录的条目丢弃。
function parseResults(raw: unknown): EvidenceInput[] {
  if (!raw || typeof raw !== 'object' || !('results' in raw) || !Array.isArray(raw.results)) {
    throw new Error('invalid_response');
  }
  return raw.results.slice(0, 3).flatMap((value: unknown): EvidenceInput[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row: Record<string, unknown> = value as Record<string, unknown>;
    const url: string | undefined = sourceUrl(row.url);
    const title: string = text(row.title, 160);
    const excerpt: string = text(row.summary || row.snippet || row.content, 600);
    if (!url || !title || !excerpt) return [];
    // 发布日期解析失败时回退为 "unknown"，不影响条目本身
    const date: string =
      typeof row.date === 'string' && Number.isFinite(Date.parse(row.date))
        ? new Date(row.date).toISOString().slice(0, 10)
        : 'unknown';
    return [
      {
        role: 'news',
        evidenceType: 'other',
        title,
        content: `Web search excerpt; not a verified financial statement. Published: ${date}. ${excerpt}`,
        sourceName: 'DeepSeek web search',
        sourceUrl: url,
        relevanceScore: 0.45,
      },
    ];
  });
}

// 读取响应体并做大小双保险（先看 Content-Length，再流式累计），超过 2MiB 即中断；只接受 JSON。
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('response_too_large');
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks: Uint8Array[] = [];
  let size: number = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    chunks.push(chunk.value);
  }
  const body: Uint8Array = new Uint8Array(size);
  let offset: number = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error('invalid_response');
  }
}

@Injectable()
export class ResearchWebService {
  constructor(
    private readonly settings: SettingsService,
    private readonly budget: ResearchToolsBudgetService,
  ) {}

  async search(
    userId: string,
    ticker: string,
    language: 'en' | 'zh-CN',
    options: EvidenceCollectionOptions,
  ): Promise<EvidenceInput[]> {
    // emit：把一次采集状态（skipped/started/succeeded/partial/failed）回传给调用方
    const en: boolean = language === 'en';
    const emit = async (status: ResearchAcquisition['status'], detail: string): Promise<void> => {
      await options.onAcquisition?.({ source: 'DeepSeek web search', kind: 'web', status, detail });
    };

    // 前置闸门：未开启网页研究 → 直接跳过，不产生任何付费请求
    if (!options.webResearch) {
      await emit(
        'skipped',
        en
          ? 'Web research is disabled; no paid request was made.'
          : '未开启网页研究，本次未发送付费请求。',
      );
      return [];
    }

    // 参数与取消点校验：必须有 taskId、ticker 形态合法、调用方未中途取消
    if (!options.taskId) throw new Error('Web research requires a task ID');
    if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/i.test(ticker)) throw new Error('Invalid research ticker');
    if (options.shouldContinue && !(await options.shouldContinue()))
      throw new Error('Research stopped');

    // 只允许官方 DeepSeek 连接：配置缺失或 origin 不匹配时跳过并上报
    const config = await this.settings.getResearchSearchConfig(userId);
    if (!config || new URL(config.baseUrl).origin !== 'https://api.deepseek.com') {
      await emit(
        'skipped',
        en
          ? 'Configure an official DeepSeek connection to enable web research.'
          : '请配置官方 DeepSeek 连接以启用网页研究。',
      );
      return [];
    }

    // 构造检索词：ticker + 调用方查询文本（缺省用财报/业绩/风险向的固定短语），总长截断到 128
    const query: string = [
      ...`${ticker.toUpperCase()} ${text(options.query, 500) || 'latest company filings earnings risks'}`,
    ]
      .slice(0, 128)
      .join('');

    // 先预留请求槽位；限额类错误透传原始码，其余包装为 RESEARCH_BUDGET_UNAVAILABLE
    let reservation: string;
    try {
      reservation = await this.budget.reserve(userId, options.taskId);
    } catch (error) {
      const code: string =
        error instanceof Error && /^RESEARCH_(TASK|DAILY)_LIMIT$/.test(error.message)
          ? error.message
          : 'RESEARCH_BUDGET_UNAVAILABLE';
      await emit(
        'failed',
        `${code}: ${en ? 'Web search request limit reached or unavailable; no request was sent.' : '网页检索请求额度已用完或暂不可用，本次未发送请求。'}`,
      );
      throw new Error(code);
    }

    // 从这里开始任何出口都必须结算槽位（cancelled / succeeded / failed）
    try {
      // 取消点 1：调用方在预留后立刻取消 → 结算为 cancelled 并中止
      if (options.shouldContinue && !(await options.shouldContinue())) {
        await this.budget.settle(userId, reservation, 'cancelled');
        throw new Error('Research stopped');
      }
      // 发起前的状态上报（提示可能存在按请求计费）
      await emit(
        'started',
        en
          ? 'Searching public web sources (separate request-based provider fee may apply).'
          : '正在检索公开网页来源（供应商可能按请求单独计费）。',
      );
      // 取消点 2：真正发请求前再查一次取消状态
      if (options.shouldContinue && !(await options.shouldContinue())) {
        await this.budget.settle(userId, reservation, 'cancelled');
        throw new Error('Research stopped');
      }
      // 调用官方搜索端点：15s 超时、禁止重定向，固定取 3 条并要求正文
      const response: Response = await fetch(SEARCH_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ query, count: 3, need_content: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      // 解析成功 → 结算为 succeeded；0 条结果上报 partial
      const items: EvidenceInput[] = parseResults(await boundedJson(response));
      await this.budget.settle(userId, reservation, 'succeeded');
      await emit(
        items.length ? 'succeeded' : 'partial',
        en
          ? `Retrieved ${items.length} public source excerpts; these do not replace verified financial statements.`
          : `已取得 ${items.length} 条公开来源摘录；网页线索不会替代已核实财报。`,
      );
      return items;
    } catch (error) {
      // 失败路径：结算为 failed（结算自身失败则吞掉，不影响原错误），再归一化失败原因
      await this.budget.settle(userId, reservation, 'failed').catch(() => undefined);
      const reason: string =
        error instanceof Error &&
        /^(http_\d{3}|invalid_response|response_too_large|Research stopped)$/.test(error.message)
          ? error.message
          : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'timeout'
            : 'network_error';
      await emit(
        'failed',
        `[DeepSeek search:${reason}] ${en ? 'No automatic retry was made.' : '未进行自动重试。'}`,
      );
      throw new Error(`DeepSeek search ${reason}`);
    }
  }
}
