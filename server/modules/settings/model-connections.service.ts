import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
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

  async save(owner: string, input: SaveModelConnection, id?: string): Promise<ModelConnection> {
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Enter model connection settings');
    const existing = id ? await this.row(owner, id) : null;
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
    if (!key && (!existing || !this.decrypt(existing)))
      throw new BadRequestException('Enter an API key');
    if (!key && existing && baseUrl !== existing.baseUrl) {
      throw new BadRequestException('Enter a new API key when changing the model endpoint');
    }
    const apiKeyEnc = key ? encryptSecret(key, this.secret()) : existing.apiKeyEnc;
    const values = { name, baseUrl, fastModel, slowModel, apiKeyEnc, updatedAt: new Date() };
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

  async remove(owner: string, id: string): Promise<{ removed: true }> {
    await this.row(owner, id);
    await this.db
      .delete(modelConnections)
      .where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, id)));
    return { removed: true };
  }
}
