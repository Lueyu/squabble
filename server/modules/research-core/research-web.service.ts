import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ResearchToolsBudgetService } from './research-tools-budget.service';
import type { EvidenceCollectionOptions, EvidenceInput } from './evidence.service';
import type { ResearchAcquisition } from '@shared/council.interface';

const SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
const MAX_BYTES = 2 * 1024 * 1024;

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url: URL = new URL(value);
    const host: string = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host)
      || /(?:^|\.)(localhost|local|internal|invalid|test|example)$/.test(host)) return undefined;
    if ([...url.searchParams.keys()].some((key: string) => /^(token|api[_-]?key|authorization|secret)$/i.test(key))) return undefined;
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

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
    const date: string = typeof row.date === 'string' && Number.isFinite(Date.parse(row.date))
      ? new Date(row.date).toISOString().slice(0, 10) : 'unknown';
    return [{ role: 'news', evidenceType: 'other', title,
      content: `Web search excerpt; not a verified financial statement. Published: ${date}. ${excerpt}`,
      sourceName: 'DeepSeek web search', sourceUrl: url, relevanceScore: 0.45 }];
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await response.body?.cancel(); throw new Error('response_too_large');
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks: Uint8Array[] = [];
  let size: number = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('response_too_large'); }
    chunks.push(chunk.value);
  }
  const body: Uint8Array = new Uint8Array(size);
  let offset: number = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(body)) as unknown; }
  catch { throw new Error('invalid_response'); }
}

@Injectable()
export class ResearchWebService {
  constructor(private readonly settings: SettingsService, private readonly budget: ResearchToolsBudgetService) {}

  async search(userId: string, ticker: string, language: 'en' | 'zh-CN',
    options: EvidenceCollectionOptions): Promise<EvidenceInput[]> {
    const en: boolean = language === 'en';
    const emit = async (status: ResearchAcquisition['status'], detail: string): Promise<void> => {
      await options.onAcquisition?.({ source: 'DeepSeek web search', kind: 'web', status, detail });
    };
    if (!options.webResearch) {
      await emit('skipped', en ? 'Web research is disabled; no paid request was made.' : '未开启网页研究，本次未发送付费请求。');
      return [];
    }
    if (!options.taskId) throw new Error('Web research requires a task ID');
    if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/i.test(ticker)) throw new Error('Invalid research ticker');
    if (options.shouldContinue && !(await options.shouldContinue())) throw new Error('Research stopped');
    const config = await this.settings.getResearchSearchConfig(userId);
    if (!config || new URL(config.baseUrl).origin !== 'https://api.deepseek.com') {
      await emit('skipped', en ? 'Configure an official DeepSeek connection to enable web research.' : '请配置官方 DeepSeek 连接以启用网页研究。');
      return [];
    }
    const query: string = [...`${ticker.toUpperCase()} ${text(options.query, 500) || 'latest company filings earnings risks'}`]
      .slice(0, 128).join('');
    let reservation: string;
    try { reservation = await this.budget.reserve(userId, options.taskId); }
    catch (error) {
      const code: string = error instanceof Error && /^RESEARCH_(TASK|DAILY)_LIMIT$/.test(error.message)
        ? error.message : 'RESEARCH_BUDGET_UNAVAILABLE';
      await emit('failed', `${code}: ${en ? 'Web search request limit reached or unavailable; no request was sent.' : '网页检索请求额度已用完或暂不可用，本次未发送请求。'}`);
      throw new Error(code);
    }
    try {
      if (options.shouldContinue && !(await options.shouldContinue())) {
        await this.budget.settle(userId, reservation, 'cancelled');
        throw new Error('Research stopped');
      }
      await emit('started', en ? 'Searching public web sources (separate request-based provider fee may apply).' : '正在检索公开网页来源（供应商可能按请求单独计费）。');
      if (options.shouldContinue && !(await options.shouldContinue())) {
        await this.budget.settle(userId, reservation, 'cancelled');
        throw new Error('Research stopped');
      }
      const response: Response = await fetch(SEARCH_URL, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ query, count: 3, need_content: true }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const items: EvidenceInput[] = parseResults(await boundedJson(response));
      await this.budget.settle(userId, reservation, 'succeeded');
      await emit(items.length ? 'succeeded' : 'partial', en
        ? `Retrieved ${items.length} public source excerpts; these do not replace verified financial statements.`
        : `已取得 ${items.length} 条公开来源摘录；网页线索不会替代已核实财报。`);
      return items;
    } catch (error) {
      await this.budget.settle(userId, reservation, 'failed').catch(() => undefined);
      const reason: string = error instanceof Error && /^(http_\d{3}|invalid_response|response_too_large|Research stopped)$/.test(error.message)
        ? error.message : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error';
      await emit('failed', `[DeepSeek search:${reason}] ${en ? 'No automatic retry was made.' : '未进行自动重试。'}`);
      throw new Error(`DeepSeek search ${reason}`);
    }
  }
}
