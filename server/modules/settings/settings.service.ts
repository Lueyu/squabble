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
import {
  decryptSecret,
  encryptSecret,
  normalizePublicLlmBaseUrl,
} from './settings-security';
import { ModelConnectionsService } from './model-connections.service';
import { ModuleRef } from '@nestjs/core';
import type { ModelRoute } from '../../../shared/model-route.interface';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import { parseModelRoute } from './model-route.rules';
import { financialProviderEnabled } from '../../database/financial-provider-visibility';

export interface ResolvedLlmConfig {
  source: 'user' | 'server';
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  apiKey: string;
}

type SettingsRow = typeof userApiSettings.$inferSelect;

const DEFAULT_LLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_FAST_MODEL = 'doubao-lite-4k';
const DEFAULT_SLOW_MODEL = 'doubao-pro-32k';
const FINNHUB_PROFILE_URL = 'https://finnhub.io/api/v1/stock/profile2';
const KNOWN_DEMO_JWT_SECRET = 'change-me-in-production-0123456789abcdef';

function maskedKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

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

function cleanModel(value: unknown): string {
  if (
    typeof value !== 'string' || value.trim().length < 1
    || value.trim().length > 120 || /[\r\n\u0000-\u001f]/u.test(value)
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
    @Optional() private readonly connections?: ModelConnectionsService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private localAgents(): LocalAgentsService {
    try {
      // Resolve lazily: native research tools themselves depend on SettingsService.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const token = (require('../local-agents/local-agents.service') as typeof import('../local-agents/local-agents.service')).LocalAgentsService;
      const agents = this.moduleRef?.get<LocalAgentsService>(token, { strict: false });
      if (agents) return agents;
    } catch { /* Module may be unavailable in a reduced server configuration. */ }
    throw new BadRequestException('LOCAL_UNAVAILABLE');
  }

  async getDefaultModelRoute(userId: string): Promise<ModelRoute> {
    const row = await this.rowFor(userId);
    if (row?.llmRoute) return parseModelRoute(row.llmRoute);
    return row?.llmApiKeyEnc || process.env.DOUBAO_API_KEY ? { mode: 'api' } : { mode: 'basic' };
  }

  async saveLlmRoute(userId: string, input: unknown): Promise<IntegrationSettings> {
    const route = parseModelRoute(input);
    if (route.mode === 'api' && !await this.getLlmConfig(userId)) {
      throw new BadRequestException('No LLM API key configured');
    }
    if (route.mode === 'local') await this.localAgents().validate(userId, route.agentId, route.agentSettings);
    await this.db.insert(userApiSettings).values({ owner: userId, llmRoute: route })
      .onConflictDoUpdate({ target: userApiSettings.owner, set: { llmRoute: route, updatedAt: new Date() } });
    return this.getSettings(userId);
  }

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

  private async rowFor(userId: string): Promise<SettingsRow | null> {
    const [row] = await this.db.select().from(userApiSettings)
      .where(eq(userApiSettings.owner, userId));
    return row ?? null;
  }

  private tryDecrypt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    try {
      return decryptSecret(stored, this.encryptionSecret());
    } catch {
      return null;
    }
  }

  async getSettings(userId: string): Promise<IntegrationSettings> {
    const row = await this.rowFor(userId);
    const userLlmKey = this.tryDecrypt(row?.llmApiKeyEnc);
    const serverLlmKey = process.env.DOUBAO_API_KEY || null;
    const finnhubKey = this.tryDecrypt(row?.finnhubApiKeyEnc);
    const route = row?.llmRoute ? parseModelRoute(row.llmRoute)
      : row?.llmApiKeyEnc || serverLlmKey ? { mode: 'api' as const } : { mode: 'basic' as const };
    const local = route.mode === 'local';
    let localAvailable = false;
    if (local) {
      try {
        await this.localAgents().validate(userId, route.agentId, route.agentSettings);
        localAvailable = true;
      } catch { localAvailable = false; }
    }
    const llm = userLlmKey ? {
      source: 'user' as const, engine: 'llm' as const, available: true,
      baseUrl: row?.llmBaseUrl || DEFAULT_LLM_BASE_URL,
      fastModel: row?.llmFastModel || DEFAULT_FAST_MODEL,
      slowModel: row?.llmSlowModel || DEFAULT_SLOW_MODEL,
      hasApiKey: true, maskedApiKey: maskedKey(userLlmKey),
    } : row?.llmApiKeyEnc ? {
      source: 'user' as const, engine: 'llm' as const, available: false,
      baseUrl: row.llmBaseUrl || DEFAULT_LLM_BASE_URL,
      fastModel: row.llmFastModel || DEFAULT_FAST_MODEL,
      slowModel: row.llmSlowModel || DEFAULT_SLOW_MODEL,
      hasApiKey: false, needsReentry: true,
    } : {
      source: serverLlmKey ? 'server' as const : 'builtin' as const,
      engine: serverLlmKey ? 'llm' as const : 'basic' as const,
      available: true,
      baseUrl: serverLlmKey ? process.env.DOUBAO_BASE_URL || DEFAULT_LLM_BASE_URL : '',
      fastModel: serverLlmKey ? process.env.DOUBAO_MODEL_FAST || DEFAULT_FAST_MODEL : '',
      slowModel: serverLlmKey ? process.env.DOUBAO_MODEL_SLOW || DEFAULT_SLOW_MODEL : '',
      hasApiKey: Boolean(serverLlmKey),
    };
    return {
      llm: local ? { ...llm, source: 'local', engine: 'llm', available: localAvailable, route }
        : route.mode === 'basic' ? { ...llm, source: 'builtin', engine: 'basic', available: true, route }
          : { ...llm, engine: 'llm', available: llm.hasApiKey && llm.available, route },
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

  async getLlmConfig(userId: string, connectionId?: string): Promise<ResolvedLlmConfig | null> {
    if (connectionId) {
      if (!this.connections) throw new BadRequestException('Model connections are unavailable');
      return this.connections.resolve(userId, connectionId);
    }
    const row = await this.rowFor(userId);
    if (row?.llmApiKeyEnc) {
      const userKey = this.tryDecrypt(row.llmApiKeyEnc);
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

  async getFinnhubKey(userId: string): Promise<string | null> {
    if (!await financialProviderEnabled(this.db, userId, 'finnhub')) return null;
    const row = await this.rowFor(userId);
    return this.tryDecrypt(row?.finnhubApiKeyEnc);
  }

  isFinancialProviderEnabled(userId: string, provider: string): Promise<boolean> {
    return financialProviderEnabled(this.db, userId, provider);
  }

  async getResearchSearchConfig(userId: string): Promise<ResolvedLlmConfig | null> {
    const current = await this.getLlmConfig(userId);
    const supportsSearch = (url: string): boolean => {
      try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'api.deepseek.com'; }
      catch { return false; }
    };
    if (current && supportsSearch(current.baseUrl)) return current;
    if (!this.connections) return null;
    const available = (await this.connections.list(userId)).find(item => item.available && supportsSearch(item.baseUrl));
    return available ? this.connections.resolve(userId, available.id) : null;
  }

  async saveLlm(userId: string, input: UpdateLlmIntegrationRequest): Promise<IntegrationSettings> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('Enter the LLM connection settings');
    }
    let baseUrl: string;
    try {
      baseUrl = await normalizePublicLlmBaseUrl(input.baseUrl);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid base URL');
    }
    const fastModel = cleanModel(input.fastModel);
    const slowModel = cleanModel(input.slowModel);
    const row = await this.rowFor(userId);
    const retainedKey = this.tryDecrypt(row?.llmApiKeyEnc);
    const apiKey = cleanApiKey(input.apiKey, !retainedKey);
    if (!apiKey && retainedKey && row?.llmBaseUrl
      && baseUrl !== row.llmBaseUrl.replace(/\/+$/u, '')) {
      throw new BadRequestException('Enter a new API key when changing the model endpoint');
    }
    const encrypted = apiKey ? encryptSecret(apiKey, this.encryptionSecret()) : row?.llmApiKeyEnc;
    if (!encrypted) throw new BadRequestException('Enter an API key');
    await this.db.insert(userApiSettings)
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

  async clearLlm(userId: string): Promise<IntegrationSettings> {
    const route = await this.getDefaultModelRoute(userId);
    await this.db.update(userApiSettings)
      .set({
        llmBaseUrl: null,
        llmFastModel: null,
        llmSlowModel: null,
        llmApiKeyEnc: null,
        ...(route.mode === 'api' ? { llmRoute: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(userApiSettings.owner, userId));
    return this.getSettings(userId);
  }

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
    const encrypted = apiKey ? encryptSecret(apiKey, this.encryptionSecret()) : row?.finnhubApiKeyEnc;
    if (!encrypted) throw new BadRequestException('Enter an API key');
    await this.db.insert(userApiSettings)
      .values({ owner: userId, finnhubApiKeyEnc: encrypted })
      .onConflictDoUpdate({
        target: userApiSettings.owner,
        set: { finnhubApiKeyEnc: encrypted, updatedAt: new Date() },
      });
    return this.getSettings(userId);
  }

  async clearFinancial(userId: string): Promise<IntegrationSettings> {
    await this.db.update(userApiSettings)
      .set({ finnhubApiKeyEnc: null, updatedAt: new Date() })
      .where(eq(userApiSettings.owner, userId));
    return this.getSettings(userId);
  }

  async testFinancial(userId: string): Promise<IntegrationTestResult> {
    const settings = await this.getSettings(userId);
    if (settings.financial.provider === 'public') {
      try {
        const quote = await this.quotes.getQuote('AAPL');
        if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
          return { ok: true, code: 'public_ready', message: 'Public market data returned an AAPL quote. No API key is required.' };
        }
      } catch {
        // A failed provider must never be reported as a successful connection.
      }
      return { ok: false, code: 'public_unavailable', message: 'Public quote providers are unavailable. Retry when the server network recovers.' };
    }
    const key = await this.getFinnhubKey(userId);
    if (!key) return { ok: false, code: 'credential_unreadable', message: 'The saved API key cannot be read. Re-enter or remove it.' };
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
      const profile: unknown = await response.json();
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)
        || typeof (profile as Record<string, unknown>).ticker !== 'string') {
        return { ok: false, message: 'Finnhub returned no AAPL profile. Check key access.' };
      }
      return { ok: true, message: 'Finnhub returned the AAPL company profile.' };
    } catch {
      return { ok: false, message: 'Could not reach Finnhub. Check the server network.' };
    }
  }
}
