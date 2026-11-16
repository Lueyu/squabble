/**
 * OCR service（券商截图 OCR 提取服务）。
 *
 * 职责边界：把券商持仓截图发给用户自选的多模态大模型，解析出结构化持仓
 * 行；只做一次上游转发与回复解析，不做行情校验、不落库（行由
 * ImportService.commit 持久化）。
 *
 * 上下游：import @nestjs/axios 的 HttpService、@nestjs/common、rxjs 的
 * firstValueFrom、@shared/api.interface 的 DTO；由 import.controller.ts
 * 调用（/api/import/ocr/extract）。
 *
 * 关键约定（隐私敏感，见 docs/privacy.md）：
 *  - API Key 随请求到达，只用于这一次上游调用，绝不持久化或写日志；
 *  - 截图从用户浏览器经此代理直达其自选的 OpenAI 兼容端点，不经过任何
 *    其他服务器（与 Finnhub token 保持在浏览器侧同一隐私姿态）；
 *  - 支持任何带视觉能力的 OpenAI 兼容 chat-completions 端点：火山方舟
 *    （doubao vision 系列）、OpenAI（gpt-4o 等）、DeepSeek 兼容网关等；
 *  - 上游超时 OCR_TIMEOUT_MS=90s（大截图视觉模型较慢）；入站 base64
 *    上限 MAX_IMAGE_BASE64_LENGTH=11,000,000 字符（约 8MB 解码后）；
 *  - 模型回复 temperature=0，保证抽取结果确定性。
 */
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { OcrExtractDto, OcrExtractResult } from '@shared/api.interface';

/** 上游调用超时：大截图上视觉模型可能较慢（毫秒）。 */
const OCR_TIMEOUT_MS = 90_000;

/** 入站 base64 图片上限（约 8MB 解码后）。 */
const MAX_IMAGE_BASE64_LENGTH = 11_000_000;

/** 随截图一起发送的提取 prompt。 */
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
   * 把截图发给用户的视觉模型并从回复中解析结构化行。
   * Key 是瞬态的——不存储、不记录日志。
   */
  async extract(dto: OcrExtractDto): Promise<OcrExtractResult> {
    // 第一步：入参校验与归一化（baseUrl 去尾斜杠，默认火山方舟）。
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

    // 第二步：包装成 data URL（已是 data: 开头则原样使用）。
    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    // 第三步：发起唯一的上游调用；Key 只出现在本次请求头里。
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
      // 失败路径：记录上游状态码（不含 Key/截图内容），把上游细节透传给用户。
      const status = (error as { response?: { status?: number; data?: unknown } })?.response
        ?.status;
      const detail = (error as { response?: { data?: { error?: { message?: string } } } })?.response
        ?.data?.error?.message;
      this.logger.warn(`ocr upstream failed (status=${status ?? 'n/a'})`);
      throw new BadRequestException(
        `识别请求失败${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : '，请检查 Key、模型与接口地址'}`,
      );
    }

    // 第四步：解析模型回复。
    return this.parseModelReply(typeof content === 'string' ? content : '');
  }

  /** 解析模型回复：剥代码围栏，定位 JSON 对象并规范化行。 */
  private parseModelReply(reply: string): OcrExtractResult {
    // 剥掉 markdown 代码围栏后取首尾大括号之间的内容。
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
    // 规范化每行类型并过滤无效行（ticker 为空或 shares 非有限数）。
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
