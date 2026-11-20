/**
 * 管理附加模型连接与测试回执。调用方通过 resolve 读取可用的明文凭据，
 * 列表与保存响应仅返回掩码。设置安全模块负责公网 HTTPS 校验与加密。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { modelConnections } from '../../database/model-connections.schema';
import { decryptSecret, encryptSecret, normalizePublicLlmBaseUrl } from './settings-security';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';
import type { ResolvedLlmConfig } from './settings.service';

type ConnectionRow = typeof modelConnections.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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

  /** 优先使用设置加密密钥，其次使用 JWT 密钥。拒绝已知的演示值。 */
  private secret(): string {
    const value = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!value || value.length < 16 || value === 'change-me-in-production-0123456789abcdef') {
      throw new BadRequestException('Set a private SETTINGS_ENCRYPTION_KEY before saving API keys');
    }
    return value;
  }

  private decrypt(row: ConnectionRow): string | null {
    try {
      return decryptSecret(row.apiKeyEnc, this.secret());
    } catch {
      return null;
    }
  }

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
      ...(key && row.testState ? { testState: row.testState } : {}),
      ...(key && row.testedAt ? { testedAt: row.testedAt.toISOString() } : {}),
      ...(key ? { maskedApiKey: `••••${key.slice(-4)}` } : { needsReentry: true }),
    };
  }

  async list(owner: string): Promise<ModelConnection[]> {
    const rows = await this.db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.owner, owner))
      .orderBy(asc(modelConnections.createdAt));
    return rows.map((row) => this.publicRow(row));
  }

  private async row(owner: string, id: string): Promise<ConnectionRow> {
    if (!UUID.test(id)) throw new BadRequestException('Invalid model connection ID');
    const [row] = await this.db
      .select()
      .from(modelConnections)
      .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)));
    if (!row) throw new NotFoundException('Model connection not found');
    return row;
  }

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

  /** 仅在待测端点、模型和凭据仍与读取时一致的情况下登记测试。 */
  async beginTest(owner: string, id: string): Promise<string> {
    const attemptId = randomUUID();
    const row = await this.row(owner, id);
    if (!this.decrypt(row))
      throw new BadRequestException(
        'Model connection unavailable; re-enter its API key in Settings',
      );
    const [claimed] = await this.db
      .update(modelConnections)
      .set({ testAttemptId: attemptId, testState: 'pending', testedAt: null })
      .where(
        and(
          eq(modelConnections.owner, owner),
          eq(modelConnections.id, id),
          eq(modelConnections.apiKeyEnc, row.apiKeyEnc),
          eq(modelConnections.baseUrl, row.baseUrl),
          eq(modelConnections.fastModel, row.fastModel),
          eq(modelConnections.slowModel, row.slowModel),
        ),
      )
      .returning({ id: modelConnections.id });
    if (!claimed)
      throw new BadRequestException('Model connection changed. Reload its settings before testing.');
    return attemptId;
  }

  private pendingTest(owner: string, id: string, attemptId: string) {
    return and(
      eq(modelConnections.owner, owner),
      eq(modelConnections.id, id),
      eq(modelConnections.testAttemptId, attemptId),
      eq(modelConnections.testState, 'pending'),
    );
  }

  async isTestCurrent(owner: string, id: string, attemptId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: modelConnections.id })
      .from(modelConnections)
      .where(this.pendingTest(owner, id, attemptId));
    return Boolean(row);
  }

  async finishTest(owner: string, id: string, attemptId: string, ok: boolean): Promise<boolean> {
    const [row] = await this.db
      .update(modelConnections)
      .set({ testState: ok ? 'passed' : 'failed', testedAt: ok ? new Date() : null })
      .where(this.pendingTest(owner, id, attemptId))
      .returning({ id: modelConnections.id });
    return Boolean(row);
  }

  async save(owner: string, input: SaveModelConnection, id?: string): Promise<ModelConnection> {
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Enter model connection settings');
    if (id && !UUID.test(id)) throw new BadRequestException('Invalid model connection ID');
    const name = boundedText(input.name, 'connection name', 60);
    const fastModel = boundedText(input.fastModel, 'fast model ID', 120);
    const slowModel = boundedText(input.slowModel, 'slow model ID', 120);
    let baseUrl: string;
    try {
      baseUrl = await normalizePublicLlmBaseUrl(input.baseUrl);
    } catch {
      throw new BadRequestException('API base URL must use a public HTTPS host');
    }
    const key =
      input.apiKey === undefined || input.apiKey === ''
        ? null
        : boundedText(input.apiKey, 'API key', 4096);
    const values = { name, baseUrl, fastModel, slowModel, updatedAt: new Date() };
    const saved = await this.db.transaction(async (tx) => {
      // 同一属主的保存串行化，避免并发新增突破八条上限。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`model-connections:${owner}`}))`,
      );
      if (id) {
        const owned = and(eq(modelConnections.owner, owner), eq(modelConnections.id, id));
        const [existing] = await tx.select().from(modelConnections).where(owned).for('update');
        if (!existing) throw new NotFoundException('Model connection not found');
        if (!key && !this.decrypt(existing)) throw new BadRequestException('Enter an API key');
        if (!key && baseUrl !== existing.baseUrl)
          throw new BadRequestException('Enter a new API key when changing the model endpoint');
        // 测试回执绑定端点、模型和凭据，单独重命名连接时仍有效。
        const changed =
          key ||
          baseUrl !== existing.baseUrl ||
          fastModel !== existing.fastModel ||
          slowModel !== existing.slowModel;
        const [updated] = await tx
          .update(modelConnections)
          .set({
            ...values,
            apiKeyEnc: key ? encryptSecret(key, this.secret()) : existing.apiKeyEnc,
            ...(changed ? { testAttemptId: null, testState: null, testedAt: null } : {}),
          })
          .where(owned)
          .returning();
        return updated;
      }
      if (!key) throw new BadRequestException('Enter an API key');
      const [counts] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(modelConnections)
        .where(eq(modelConnections.owner, owner));
      if (Number(counts.count) >= 8)
        throw new BadRequestException('Keep at most eight additional model connections');
      const [created] = await tx
        .insert(modelConnections)
        .values({ ...values, owner, apiKeyEnc: encryptSecret(key, this.secret()) })
        .returning();
      return created;
    });
    return this.publicRow(saved);
  }

  async remove(owner: string, id: string): Promise<{ removed: true }> {
    await this.row(owner, id);
    await this.db
      .delete(modelConnections)
      .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)));
    return { removed: true };
  }
}
