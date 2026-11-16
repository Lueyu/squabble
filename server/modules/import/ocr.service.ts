/**
 * @file server/modules/import/ocr.service.ts
 * @description Broker-screenshot OCR via the user's own multimodal LLM key.
 *
 * Privacy posture (docs/privacy.md): the API key arrives with the request,
 * is used for exactly one upstream call, and is never persisted or logged.
 * The screenshot itself goes from the user's browser to their own chosen
 * OpenAI-compatible endpoint via this proxy — it does not touch any other
 * server. This mirrors how the Finnhub token stays browser-side.
 *
 * Any OpenAI-compatible chat-completions endpoint with vision support
 * works: Volcengine Ark (doubao vision models), OpenAI (gpt-4o etc.),
 * DeepSeek-compatible gateways, etc.
 */
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { OcrExtractDto, OcrExtractResult } from '@shared/api.interface';

/** Upstream call timeout: vision models can be slow on large screenshots. */
const OCR_TIMEOUT_MS = 90_000;

/** Upper bound for the incoming base64 image (~8MB decoded). */
const MAX_IMAGE_BASE64_LENGTH = 11_000_000;

/** The extraction prompt sent along with the screenshot. */
const EXTRACTION_PROMPT = `你是一个券商持仓截图解析器。从截图中的持仓列表提取每一行数据，严格按以下 JSON 格式返回，不要输出 JSON 以外的任何内容：
{"broker":"识别到的券商或应用名，无法识别则为 null","rows":[{"ticker":"股票代码（按截图原样：美股如 AAPL；港股如 00700 或 700；A股如 600519）","company":"股票名称或 null","shares":100,"avgCost":"每股成本价（数字或 null）","currentPrice":"现价（数字或 null）","currency":"USD/HKD/CNY（可从界面判断，无法判断则为 null）"}]}
规则：
1. 只提取股票持仓行，忽略现金、基金、债券、汇总结、表头。
2. shares 必须是数字；成本若只显示总成本，除以股数换算为每股。
3. 代码去掉多余空格；名称保留原文。
4. 若截图不含任何持仓，返回 {"broker":null,"rows":[]}。`;

@Injectable()
export class OcrService {
  private readonly logger = new Logger('ImportOcr');

  constructor(private readonly httpService: HttpService) {}

  /**
   * Send the screenshot to the user's vision model and parse the structured
   * rows out of the reply. The key is transient — never stored, never logged.
   */
  async extract(dto: OcrExtractDto): Promise<OcrExtractResult> {
    const apiKey = (dto.apiKey ?? '').trim();
    const baseUrl = (dto.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3')
      .trim()
      .replace(/\/+$/, '');
    const model = (dto.model ?? '').trim();
    if (!apiKey) throw new BadRequestException('缺少大模型 API Key');
    if (!model) throw new BadRequestException('缺少模型名称');
    const imageBase64 = (dto.imageBase64 ?? '').trim();
    if (!imageBase64) throw new BadRequestException('缺少截图数据');
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      throw new BadRequestException('截图过大（>8MB），请裁剪后重试');
    }

    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    let content: unknown;
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/chat/completions`,
          {
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: EXTRACTION_PROMPT },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            temperature: 0,
          },
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: OCR_TIMEOUT_MS,
          },
        ),
      );
      content = response.data?.choices?.[0]?.message?.content;
    } catch (error) {
      const status = (error as { response?: { status?: number; data?: unknown } })?.response
        ?.status;
      const detail = (error as { response?: { data?: { error?: { message?: string } } } })?.response
        ?.data?.error?.message;
      this.logger.warn(`ocr upstream failed (status=${status ?? 'n/a'})`);
      throw new BadRequestException(
        `识别请求失败${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : '，请检查 Key、模型与接口地址'}`,
      );
    }

    return this.parseModelReply(typeof content === 'string' ? content : '');
  }

  /** Parse the model reply: strip code fences, locate the JSON object. */
  private parseModelReply(reply: string): OcrExtractResult {
    const cleaned = reply.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new BadRequestException('模型未返回可解析的结果，请换一张更清晰的截图或更换模型重试');
    }
    let parsed: { broker?: string | null; rows?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new BadRequestException('模型返回的 JSON 无法解析，请重试或更换模型');
    }
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const normalized = rows
      .map((r) => ({
        ticker: String(r.ticker ?? '').trim(),
        company: r.company == null ? null : String(r.company).trim(),
        shares: Number(r.shares),
        avgCost: r.avgCost == null ? null : Number(r.avgCost),
        currentPrice: r.currentPrice == null ? null : Number(r.currentPrice),
        currency: r.currency == null ? null : String(r.currency),
      }))
      .filter((r) => r.ticker && Number.isFinite(r.shares));
    if (normalized.length === 0) {
      throw new BadRequestException('截图中未识别出任何持仓行');
    }
    return { broker: parsed.broker ?? null, rows: normalized };
  }
}
