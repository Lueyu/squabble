/**
 * Settings service（集成设置服务）。
 *
 * 职责边界：管理用户的两组集成——LLM（baseUrl/fastModel/slowModel/apiKey）
 * 与行情数据源（Finnhub apiKey）。负责读状态视图（密钥只回脱敏尾 4 位）、
 * 写入（apiKey AES-256-GCM 加密落 user_api_settings）、清除、连通性测试，
 * 并向上游模块提供密钥解析（getLlmConfig/getFinnhubKey/
 * getResearchSearchConfig）。服务器级 DOUBAO_* 兜底配置也在这里裁决
 * （user > server > builtin）。不负责加解密细节（settings-security.ts）。
 *
 * 上下游：import DRIZZLE_DATABASE（common/platform）、userApiSettings
 * （database/schema）、QuoteService（quote 模块）、settings-security 三
 * 原语、ModelConnectionsService（可选注入，@Optional——未启用多连接时
 * 为 undefined）；由 settings.controller.ts 与 multi-agent/llm 调用方
 * （经 SettingsModule exports）使用。
 *
 * 关键约定：加密主密钥 SETTINGS_ENCRYPTION_KEY 优先、JWT_SECRET 兜底，
 * 拒绝 <16 字符或等于已知演示值 KNOWN_DEMO_JWT_SECRET 的密钥；默认
 * baseUrl 为火山方舟 ark.cn-beijing.volces.com/api/v3（fast=doubao-lite-4k、
 * slow=doubao-pro-32k）；LLM 换 baseUrl 时必须重输 apiKey（防止密钥
 * 搬家）；apiKey/model 输入清洗拒绝换行/控制字符、长度上限 4096/120；
 * Finnhub 测试走 stock/profile2?symbol=AAPL，10s 超时且 redirect:'error'。
 */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { userApiSettings } from '../../database/schema';
import { QuoteService } from '../quote/quote.service';
import type {
  IntegrationSettings,
  IntegrationTestResult,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';
import { decryptSecret, encryptSecret, normalizePublicLlmBaseUrl } from './settings-security';
import { ModelConnectionsService } from './model-connections.service';

/** 供 LLM 调用方的解析结果：来源（用户自配或服务器兜底）+ 完整连接参数。 */
export interface ResolvedLlmConfig {
  source: 'user' | 'server';
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  apiKey: string;
}

type SettingsRow = typeof userApiSettings.$inferSelect;

/** 默认 LLM 端点与模型（火山方舟；用户未配置时展示/兜底用）。 */
const DEFAULT_LLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_FAST_MODEL = 'doubao-lite-4k';
const DEFAULT_SLOW_MODEL = 'doubao-pro-32k';
/** Finnhub 公司档案端点（连通性测试用，请求量小）。 */
const FINNHUB_PROFILE_URL = 'https://finnhub.io/api/v1/stock/profile2';
/** 演示部署的示例 JWT_SECRET；保存密钥前必须换成私有值。 */
const KNOWN_DEMO_JWT_SECRET = 'change-me-in-production-0123456789abcdef';

/** 密钥脱敏展示：只暴露最后 4 位。 */
function maskedKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

/**
 * apiKey 输入清洗：空值按 required 决定报错或返回 null；拒绝超长（>4096）
 * 与换行/控制字符（防止把多行垃圾当密钥存）。
 */
function cleanApiKey(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException('Enter an API key');
    return null;
  }
  if (typeof value !== 'string') throw new BadRequestException('API key must be text');
  const key = value.trim();
  if (!key) {
    if (required) throw new BadRequestException('Enter an API key');
    return null;
  }
  if (key.length > 4096 || /[\r\n\u0000-\u001f]/u.test(key)) {
    throw new BadRequestException('Invalid API key');
  }
  return key;
}

/** model 标识清洗：1-120 字符、无换行/控制字符。 */
function cleanModel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.trim().length > 120 ||
    /[\r\n\u0000-\u001f]/u.test(value)
  ) {
    throw new BadRequestException('Enter a valid model identifier');
  }
  return value.trim();
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quotes: QuoteService,
    // 多模型连接服务是可选依赖：未启用连接管理时保持 undefined。
    @Optional() private readonly connections?: ModelConnectionsService,
  ) {}

  /** 加密主密钥：专用变量优先、JWT_SECRET 兜底；演示值/短密钥直接拒绝。 */
  private encryptionSecret(): string {
    const dedicated = process.env.SETTINGS_ENCRYPTION_KEY;
    const secret = dedicated || process.env.JWT_SECRET;
    if (!secret || secret.length < 16 || secret === KNOWN_DEMO_JWT_SECRET) {
      throw new BadRequestException(
        'Set a private SETTINGS_ENCRYPTION_KEY (at least 16 characters) before saving API keys',
      );
    }
    return secret;
  }

  /** 取该属主的设置行（每属主最多一行，owner 即主键）。 */
  private async rowFor(userId: string): Promise<SettingsRow | null> {
    const [row] = await this.db
      .select()
      .from(userApiSettings)
      .where(eq(userApiSettings.owner, userId));
    return row ?? null;
  }

  /** 尽力解密：密文损坏或主密钥已轮换时返回 null（而不是抛错炸掉读路径）。 */
  private tryDecrypt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    try {
      return decryptSecret(stored, this.encryptionSecret());
    } catch {
      return null;
    }
  }

  /**
   * 设置状态视图（密钥永不回传原文）。LLM 三态：用户密钥可解密 → user
   * 可用；有密文但解不开（密钥已轮换）→ user 但 needsReentry；无密文 →
   * 服务器 DOUBAO_* 兜底或 builtin（basic 引擎）。行情两态：user(finnhub)
   * 或 builtin(public)。
   */
  async getSettings(userId: string): Promise<IntegrationSettings> {
    const row = await this.rowFor(userId);
    const userLlmKey = this.tryDecrypt(row?.llmApiKeyEnc);
    const serverLlmKey = process.env.DOUBAO_API_KEY || null;
    const finnhubKey = this.tryDecrypt(row?.finnhubApiKeyEnc);
    return {
      llm: userLlmKey
        ? {
            source: 'user',
            engine: 'llm',
            available: true,
            baseUrl: row?.llmBaseUrl || DEFAULT_LLM_BASE_URL,
            fastModel: row?.llmFastModel || DEFAULT_FAST_MODEL,
            slowModel: row?.llmSlowModel || DEFAULT_SLOW_MODEL,
            hasApiKey: true,
            maskedApiKey: maskedKey(userLlmKey),
          }
        : row?.llmApiKeyEnc
          ? {
              source: 'user',
              engine: 'llm',
              // 有密文但解不开：提示用户重新录入密钥。
              available: false,
              baseUrl: row.llmBaseUrl || DEFAULT_LLM_BASE_URL,
              fastModel: row.llmFastModel || DEFAULT_FAST_MODEL,
              slowModel: row.llmSlowModel || DEFAULT_SLOW_MODEL,
              hasApiKey: false,
              needsReentry: true,
            }
          : {
              // 未配置用户密钥：有 DOUBAO_API_KEY 则走服务器配置，否则 basic。
              source: serverLlmKey ? 'server' : 'builtin',
              engine: serverLlmKey ? 'llm' : 'basic',
              available: true,
              baseUrl: serverLlmKey ? process.env.DOUBAO_BASE_URL || DEFAULT_LLM_BASE_URL : '',
              fastModel: serverLlmKey ? process.env.DOUBAO_MODEL_FAST || DEFAULT_FAST_MODEL : '',
              slowModel: serverLlmKey ? process.env.DOUBAO_MODEL_SLOW || DEFAULT_SLOW_MODEL : '',
              hasApiKey: Boolean(serverLlmKey),
            },
      financial: {
        source: row?.finnhubApiKeyEnc ? 'user' : 'builtin',
        provider: row?.finnhubApiKeyEnc ? 'finnhub' : 'public',
        available: !row?.finnhubApiKeyEnc || Boolean(finnhubKey),
        hasApiKey: Boolean(finnhubKey),
        ...(finnhubKey ? { maskedApiKey: maskedKey(finnhubKey) } : {}),
        ...(row?.finnhubApiKeyEnc && !finnhubKey ? { needsReentry: true } : {}),
      },
    };
  }

  /**
   * 解析一次 LLM 调用应使用的完整连接参数。指定 connectionId 时走多连接
   * 表（ModelConnectionsService）；否则用户配置优先、服务器 DOUBAO_*
   * 兜底；都无则返回 null（调用方按 basic 引擎处理）。
   */
  async getLlmConfig(userId: string, connectionId?: string): Promise<ResolvedLlmConfig | null> {
    if (connectionId) {
      if (!this.connections) throw new BadRequestException('Model connections are unavailable');
      return this.connections.resolve(userId, connectionId);
    }
    const row = await this.rowFor(userId);
    if (row?.llmApiKeyEnc) {
      const userKey = this.tryDecrypt(row.llmApiKeyEnc);
      // 密文解不开视为不可用（交由调用方降级）。
      if (!userKey) return null;
      return {
        source: 'user',
        baseUrl: row.llmBaseUrl || DEFAULT_LLM_BASE_URL,
        fastModel: row.llmFastModel || DEFAULT_FAST_MODEL,
        slowModel: row.llmSlowModel || DEFAULT_SLOW_MODEL,
        apiKey: userKey,
      };
    }
    const apiKey = process.env.DOUBAO_API_KEY;
    if (!apiKey) return null;
    return {
      source: 'server',
      baseUrl: process.env.DOUBAO_BASE_URL || DEFAULT_LLM_BASE_URL,
      fastModel: process.env.DOUBAO_MODEL_FAST || DEFAULT_FAST_MODEL,
      slowModel: process.env.DOUBAO_MODEL_SLOW || DEFAULT_SLOW_MODEL,
      apiKey,
    };
  }

  /** 解密当前用户的 Finnhub key；未配置或解不开返回 null。 */
  async getFinnhubKey(userId: string): Promise<string | null> {
    const row = await this.rowFor(userId);
    return this.tryDecrypt(row?.finnhubApiKeyEnc);
  }

  /**
   * 深度研究联网搜索的专用配置：仅 https://api.deepseek.com 支持
   * search 参数。当前主 LLM 不满足时，在多连接表里找第一个可用的
   * DeepSeek 连接。
   */
  async getResearchSearchConfig(userId: string): Promise<ResolvedLlmConfig | null> {
    const current = await this.getLlmConfig(userId);
    const supportsSearch = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'api.deepseek.com';
      } catch {
        return false;
      }
    };
    if (current && supportsSearch(current.baseUrl)) return current;
    if (!this.connections) return null;
    const available = (await this.connections.list(userId)).find(
      (item) => item.available && supportsSearch(item.baseUrl),
    );
    return available ? this.connections.resolve(userId, available.id) : null;
  }

  /**
   * 保存 LLM 集成：URL 必须通过公网 HTTPS 校验；模型名/密钥清洗后，
   * apiKey 加密落库（upsert 按 owner 冲突更新）。换 baseUrl 且未提供新
   * 密钥时拒绝——密钥不允许跨端点复用。
   */
  async saveLlm(userId: string, input: UpdateLlmIntegrationRequest): Promise<IntegrationSettings> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('Enter the LLM connection settings');
    }
    // 第一步：URL 归一化 + SSRF 校验（错误消息直接透传给用户）。
    let baseUrl: string;
    try {
      baseUrl = await normalizePublicLlmBaseUrl(input.baseUrl);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid base URL');
    }
    // 第二步：清洗模型名；沿用旧密文（解密成功即视为保留）。
    const fastModel = cleanModel(input.fastModel);
    const slowModel = cleanModel(input.slowModel);
    const row = await this.rowFor(userId);
    const retainedKey = this.tryDecrypt(row?.llmApiKeyEnc);
    const apiKey = cleanApiKey(input.apiKey, !retainedKey);
    // 第三步：换端点必须换密钥（旧密钥是绑定旧端点的，不允许静默搬家）。
    if (
      !apiKey &&
      retainedKey &&
      row?.llmBaseUrl &&
      baseUrl !== row.llmBaseUrl.replace(/\/+$/u, '')
    ) {
      throw new BadRequestException('Enter a new API key when changing the model endpoint');
    }
    // 第四步：新密钥加密，或沿用旧密文；二者皆无则拒绝。
    const encrypted = apiKey ? encryptSecret(apiKey, this.encryptionSecret()) : row?.llmApiKeyEnc;
    if (!encrypted) throw new BadRequestException('Enter an API key');
    // 第五步：按 owner upsert。
    await this.db
      .insert(userApiSettings)
      .values({
        owner: userId,
        llmBaseUrl: baseUrl,
        llmFastModel: fastModel,
        llmSlowModel: slowModel,
        llmApiKeyEnc: encrypted,
      })
      .onConflictDoUpdate({
        target: userApiSettings.owner,
        set: {
          llmBaseUrl: baseUrl,
          llmFastModel: fastModel,
          llmSlowModel: slowModel,
          llmApiKeyEnc: encrypted,
          updatedAt: new Date(),
        },
      });
    return this.getSettings(userId);
  }

  /** 清除 LLM 集成（整组字段置 null，保留行本身）。 */
  async clearLlm(userId: string): Promise<IntegrationSettings> {
    await this.db
      .update(userApiSettings)
      .set({
        llmBaseUrl: null,
        llmFastModel: null,
        llmSlowModel: null,
        llmApiKeyEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(userApiSettings.owner, userId));
    return this.getSettings(userId);
  }

  /** 保存 Finnhub key（目前唯一支持的行情数据源 provider）。 */
  async saveFinancial(
    userId: string,
    input: UpdateFinancialIntegrationRequest,
  ): Promise<IntegrationSettings> {
    if (!input || input.provider !== 'finnhub') {
      throw new BadRequestException('Select a supported financial data provider');
    }
    const row = await this.rowFor(userId);
    const retainedKey = this.tryDecrypt(row?.finnhubApiKeyEnc);
    const apiKey = cleanApiKey(input.apiKey, !retainedKey);
    const encrypted = apiKey
      ? encryptSecret(apiKey, this.encryptionSecret())
      : row?.finnhubApiKeyEnc;
    if (!encrypted) throw new BadRequestException('Enter an API key');
    await this.db
      .insert(userApiSettings)
      .values({ owner: userId, finnhubApiKeyEnc: encrypted })
      .onConflictDoUpdate({
        target: userApiSettings.owner,
        set: { finnhubApiKeyEnc: encrypted, updatedAt: new Date() },
      });
    return this.getSettings(userId);
  }

  /** 清除 Finnhub key。 */
  async clearFinancial(userId: string): Promise<IntegrationSettings> {
    await this.db
      .update(userApiSettings)
      .set({ finnhubApiKeyEnc: null, updatedAt: new Date() })
      .where(eq(userApiSettings.owner, userId));
    return this.getSettings(userId);
  }

  /**
   * 行情数据源连通性测试：public 模式直接打共享行情（AAPL 报价），
   * 不把失败误报成成功；finnhub 模式用真实 key 请求公司档案（10s 超时、
   * 拒绝重定向），并校验返回确实是 AAPL 的档案。
   */
  async testFinancial(userId: string): Promise<IntegrationTestResult> {
    const settings = await this.getSettings(userId);
    // public 模式：证明公共行情可用即可，无需密钥。
    if (settings.financial.provider === 'public') {
      try {
        const quote = await this.quotes.getQuote('AAPL');
        if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
          return {
            ok: true,
            code: 'public_ready',
            message: 'Public market data returned an AAPL quote. No API key is required.',
          };
        }
      } catch {
        // A failed provider must never be reported as a successful connection.
        // （失败的供应商绝不能被报告为连接成功。）
      }
      return {
        ok: false,
        code: 'public_unavailable',
        message: 'Public quote providers are unavailable. Retry when the server network recovers.',
      };
    }
    // finnhub 模式：密文解不开时要求重录。
    const key = await this.getFinnhubKey(userId);
    if (!key)
      return {
        ok: false,
        code: 'credential_unreadable',
        message: 'The saved API key cannot be read. Re-enter or remove it.',
      };
    // 真实上游探测：AAPL 档案请求（token 走查询参数，Finnhub 官方约定）。
    const url = new URL(FINNHUB_PROFILE_URL);
    url.searchParams.set('symbol', 'AAPL');
    url.searchParams.set('token', key);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        return { ok: false, message: `Finnhub rejected the request (HTTP ${response.status}).` };
      }
      // 校验返回形状：必须是带 ticker 字段的对象（说明 key 有档案权限）。
      const profile: unknown = await response.json();
      if (
        !profile ||
        typeof profile !== 'object' ||
        Array.isArray(profile) ||
        typeof (profile as Record<string, unknown>).ticker !== 'string'
      ) {
        return { ok: false, message: 'Finnhub returned no AAPL profile. Check key access.' };
      }
      return { ok: true, message: 'Finnhub returned the AAPL company profile.' };
    } catch {
      return { ok: false, message: 'Could not reach Finnhub. Check the server network.' };
    }
  }
}
