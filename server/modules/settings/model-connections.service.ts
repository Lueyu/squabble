/**
 * Model connections service（附加模型连接服务）。
 *
 * 职责边界：管理用户在主 LLM 配置之外的附加模型连接（每条：名称、
 * baseUrl、fast/slow 模型、加密 apiKey），提供列表（脱敏视图）、解析
 * （给调用方的完整参数）、保存（新增/更新）、删除。安全规则与
 * settings-security.ts 一致——公网 HTTPS 校验、AES-256-GCM 加密、演示
 * 密钥拒绝。每属主上限 8 条，由事务内 advisory lock 串行化保护。
 *
 * 上下游：import DRIZZLE_DATABASE（common/platform）、modelConnections
 * （database/model-connections.schema）、settings-security 三原语、
 * ResolvedLlmConfig（settings.service）；由 model-connections.controller.ts
 * 与 SettingsService.getLlmConfig(connectionId) / getResearchSearchConfig
 * 调用。
 *
 * 关键约定：id 必须是 UUID 格式（先挡掉无效 id）；名称 ≤60、模型 ID
 * ≤120、apiKey ≤4096 字符且无控制字符；换 baseUrl 必须重输 apiKey；
 * 保存事务内用 pg_advisory_xact_lock(hashtext('model-connections:<owner>'))
 * 串行化，防并发创建突破 8 条上限。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { modelConnections } from '../../database/model-connections.schema';
import { decryptSecret, encryptSecret, normalizePublicLlmBaseUrl } from './settings-security';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';
import type { ResolvedLlmConfig } from './settings.service';

type ConnectionRow = typeof modelConnections.$inferSelect;
/** id 形态校验：标准 UUID。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 文本字段清洗：1–max 字符、无控制字符（统一错误文案）。 */
function boundedText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new BadRequestException(`Enter a valid ${name} (1–${max} characters)`);
  }
  return value.trim();
}

@Injectable()
export class ModelConnectionsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 加密主密钥：SETTINGS_ENCRYPTION_KEY 优先、JWT_SECRET 兜底，演示值拒绝。 */
  private secret(): string {
    const value = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!value || value.length < 16 || value === 'change-me-in-production-0123456789abcdef') {
      throw new BadRequestException('Set a private SETTINGS_ENCRYPTION_KEY before saving API keys');
    }
    return value;
  }

  /** 尽力解密（密文损坏/密钥轮换返回 null，由调用方决定报错方式）。 */
  private decrypt(row: ConnectionRow): string | null {
    try {
      return decryptSecret(row.apiKeyEnc, this.secret());
    } catch {
      return null;
    }
  }

  /** 行 → 对外脱敏视图：只回"有密钥"布尔与尾 4 位，密文解不开标 needsReentry。 */
  private publicRow(row: ConnectionRow): ModelConnection {
    const key = this.decrypt(row);
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      fastModel: row.fastModel,
      slowModel: row.slowModel,
      hasApiKey: Boolean(key),
      available: Boolean(key),
      ...(key ? { maskedApiKey: `••••${key.slice(-4)}` } : { needsReentry: true }),
    };
  }

  /** 当前属主的连接列表（按创建时间正序）。 */
  async list(owner: string): Promise<ModelConnection[]> {
    const rows = await this.db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.owner, owner))
      .orderBy(asc(modelConnections.createdAt));
    return rows.map((row) => this.publicRow(row));
  }

  /** 按属主+id 取行；id 非 UUID 直接拒绝（不查库），找不到 404。 */
  private async row(owner: string, id: string): Promise<ConnectionRow> {
    if (!UUID.test(id)) throw new BadRequestException('Invalid model connection ID');
    const [row] = await this.db
      .select()
      .from(modelConnections)
      .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)));
    if (!row) throw new NotFoundException('Model connection not found');
    return row;
  }

  /** 解析为可调用配置；密钥解不开时报"请在设置里重新录入"。 */
  async resolve(owner: string, id: string): Promise<ResolvedLlmConfig> {
    const row = await this.row(owner, id);
    const key = this.decrypt(row);
    if (!key)
      throw new BadRequestException(
        'Model connection unavailable; re-enter its API key in Settings',
      );
    return {
      source: 'user',
      baseUrl: row.baseUrl,
      fastModel: row.fastModel,
      slowModel: row.slowModel,
      apiKey: key,
    };
  }

  /**
   * 保存（id 缺省=新增，指定=更新）。校验链：名称/模型清洗 → URL 公网
   * 校验 → 密钥规则（无新密钥但旧密文也解不开则拒绝；换 baseUrl 必须
   * 重输密钥）→ 事务内 advisory lock + 上限 8 条（仅新增时检查）。
   */
  async save(owner: string, input: SaveModelConnection, id?: string): Promise<ModelConnection> {
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Enter model connection settings');
    const existing = id ? await this.row(owner, id) : null;
    // 第一步：文本字段清洗与 URL 校验。
    const name = boundedText(input.name, 'connection name', 60);
    const fastModel = boundedText(input.fastModel, 'fast model ID', 120);
    const slowModel = boundedText(input.slowModel, 'slow model ID', 120);
    let baseUrl: string;
    try {
      baseUrl = await normalizePublicLlmBaseUrl(input.baseUrl);
    } catch {
      throw new BadRequestException('API base URL must use a public HTTPS host');
    }
    // 第二步：密钥规则——空值允许沿用旧密文，但换端点必须重输。
    const key =
      input.apiKey === undefined || input.apiKey === ''
        ? null
        : boundedText(input.apiKey, 'API key', 4096);
    if (!key && (!existing || !this.decrypt(existing)))
      throw new BadRequestException('Enter an API key');
    if (!key && existing && baseUrl !== existing.baseUrl) {
      throw new BadRequestException('Enter a new API key when changing the model endpoint');
    }
    // 第三步：新密钥加密或沿用旧密文。
    const apiKeyEnc = key ? encryptSecret(key, this.secret()) : existing.apiKeyEnc;
    const values = { name, baseUrl, fastModel, slowModel, apiKeyEnc, updatedAt: new Date() };
    // 第四步：事务内先取属主级 advisory lock，再更新/新增（新增时校验 8 条上限）。
    const saved = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`model-connections:${owner}`}))`,
      );
      if (id) {
        const [updated] = await tx
          .update(modelConnections)
          .set(values)
          .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)))
          .returning();
        if (!updated) throw new NotFoundException('Model connection not found');
        return updated;
      }
      const [counts] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(modelConnections)
        .where(eq(modelConnections.owner, owner));
      // 每属主最多 8 条附加连接。
      if (Number(counts.count) >= 8)
        throw new BadRequestException('Keep at most eight additional model connections');
      const [created] = await tx
        .insert(modelConnections)
        .values({ ...values, owner })
        .returning();
      return created;
    });
    return this.publicRow(saved);
  }

  /** 删除一条连接（先经 row() 校验属主与 UUID）。 */
  async remove(owner: string, id: string): Promise<{ removed: true }> {
    await this.row(owner, id);
    await this.db
      .delete(modelConnections)
      .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)));
    return { removed: true };
  }
}
