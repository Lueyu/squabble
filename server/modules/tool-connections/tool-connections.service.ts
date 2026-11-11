import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { toolCatalogVersions, toolConnections, toolRemoteJobs, toolOAuthStates } from '../../database/tool-connections.schema';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import type { AgentConnectionStatus, AgentDataClass, AgentToolConnection, AgentToolDescriptor, AgentToolEffect } from '../../../shared/agent-tooling.interface';
import { catalogSnapshot, toolHash } from './tool-catalog.service';
import { ToolAdapterError, type ToolAdapterContext, type ToolAdapterConnection, type ToolAdapterResult,
  type TrustedToolAdapter } from './tool-adapter.contract';
import { ToolTransportPolicy } from './tool-transport-policy';
import { FirecrawlAdapter } from './providers/firecrawl.adapter';
import { ProviderHttp } from './providers/search-provider.contract';

export const TOOL_CONNECTION_ADAPTERS = Symbol('TOOL_CONNECTION_ADAPTERS');
export interface PublicToolConnection extends AgentToolConnection { endpoint: string | null; hasCredential: boolean; toolEffects: Record<string, AgentToolEffect>; authKind: 'none' | 'bearer' | 'oauth' }
type ConnectionRow = typeof toolConnections.$inferSelect;
type ConnectionDatabase = Pick<PostgresJsDatabase, 'select' | 'update' | 'insert'>;
const configSchema = z.object({ provider: z.string().min(1).max(50), endpoint: z.string().max(500).optional(),
  credential: z.string().min(1).max(16_000).optional(),
  providerConfig: z.object({ connectedAccountId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u).optional(),
    authConfigId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u).optional(),
    toolVersions: z.record(z.string().regex(/^[A-Z0-9_]+$/u), z.string().regex(/^\d{8}_\d+$/u)).optional() }).strict().optional(),
  oauth: z.object({ clientId: z.string().min(1).max(500), authorizationUrl: z.string().max(500), tokenUrl: z.string().max(500),
    scopes: z.array(z.string().min(1).max(200)).max(20) }).strict().optional() }).strict();
const enableSchema = z.object({ revision: z.number().int().positive(), catalogVersionId: z.string().uuid(),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/u), toolIds: z.array(z.string().min(1).max(250)).max(100),
  dataClasses: z.array(z.enum(['public', 'private_material', 'portfolio', 'application'])).min(1).max(4),
  effects: z.record(z.string(), z.enum(['read', 'compute', 'external_write'])).optional() }).strict();

export function toolEncryptionKey(): string {
  const key = process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
  if (!key || key.length < 16) throw new Error('TOOL_CREDENTIAL_ENCRYPTION_UNAVAILABLE');
  return key;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('INVALID_TOOL_CONNECTION_REQUEST');
  return result.data;
}
function ownerRequired(owner: string): void { if (!owner?.trim()) throw new BadRequestException('TOOL_OWNER_REQUIRED'); }

@Injectable()
export class ToolConnectionsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject(TOOL_CONNECTION_ADAPTERS) private readonly adapters: TrustedToolAdapter[] = [],
    @Optional() private readonly policy: ToolTransportPolicy = new ToolTransportPolicy()) {}

  private adapter(provider: string): TrustedToolAdapter {
    const adapter = this.adapters.find(item => item.provider === provider);
    if (!adapter) throw new BadRequestException('TOOL_PROVIDER_UNAVAILABLE');
    return adapter;
  }
  private project(row: ConnectionRow): PublicToolConnection {
    return { id: row.id, provider: row.provider, transport: row.transport as 'streamable_http' | 'adapter',
      revision: row.revision, status: row.status as AgentConnectionStatus, allowedToolIds: row.allowedToolIds,
      allowedDataClasses: row.allowedDataClasses, catalogVersionId: row.catalogVersionId,
      verifiedAt: row.verifiedAt?.toISOString() ?? null, endpoint: row.endpoint, hasCredential: row.secretEnc !== null, toolEffects: row.toolEffects,
      candidateCatalogVersionId: row.candidateCatalogVersionId, managedPresetId: row.managedPresetId,
      lastDiscoveryAt: row.lastDiscoveryAt?.toISOString() ?? null, lastDiscoveryCode: row.lastDiscoveryCode,
      authKind: row.oauthConfig ? 'oauth' : row.secretEnc ? 'bearer' : 'none' };
  }
  private async row(owner: string, id: string, db: ConnectionDatabase = this.db): Promise<ConnectionRow> {
    ownerRequired(owner);
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException('TOOL_CONNECTION_NOT_FOUND');
    const [row] = await db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id)));
    if (!row) throw new NotFoundException('TOOL_CONNECTION_NOT_FOUND');
    return row;
  }
  private credential(row: ConnectionRow): ToolAdapterConnection {
    return { id: row.id, provider: row.provider, endpoint: row.endpoint,
      secret: row.secretEnc ? decryptSecret(row.secretEnc, toolEncryptionKey()) : null,
      externalUserId: row.provider === 'composio' ? createHmac('sha256', toolEncryptionKey()).update(`squabble-composio-v1\0${row.owner}`).digest('hex') : undefined,
      config: row.providerConfig ?? undefined };
  }

  /** GET methods are projections of saved state and never perform discovery or paid execution. */
  async list(owner: string): Promise<PublicToolConnection[]> {
    ownerRequired(owner);
    return (await this.db.select().from(toolConnections).where(eq(toolConnections.owner, owner))).map(row => this.project(row));
  }
  async detail(owner: string, id: string): Promise<PublicToolConnection> { return this.project(await this.row(owner, id)); }
  async catalog(owner: string, id: string, candidate = true, db: ConnectionDatabase = this.db) {
    const row = await this.row(owner, id, db), catalogId = candidate ? row.candidateCatalogVersionId ?? row.catalogVersionId : row.catalogVersionId;
    if (!catalogId) return null;
    const [catalog] = await db.select().from(toolCatalogVersions).where(and(eq(toolCatalogVersions.owner, owner),
      eq(toolCatalogVersions.connectionId, id), eq(toolCatalogVersions.id, catalogId)));
    return catalog ?? null;
  }
  async reviewCatalog(owner: string, id: string) {
    const connection = await this.row(owner, id), active = await this.catalog(owner, id, false);
    const latest = await this.catalog(owner, id);
    const candidate = connection.candidateCatalogVersionId ? latest : null;
    const before = active?.descriptors ?? [], after = candidate?.descriptors ?? before;
    return { active, candidate, changes: {
      added: after.filter(tool => !before.some(previous => previous.id === tool.id)).map(tool => tool.id),
      removed: before.filter(tool => !after.some(next => next.id === tool.id)).map(tool => tool.id),
      changed: after.filter(tool => { const previous = before.find(item => item.id === tool.id);
        return previous && toolHash({ ...previous, catalogVersionId: '' }) !== toolHash({ ...tool, catalogVersionId: '' }); }).map(tool => tool.id),
    } };
  }

  /** Stable deployer-owned identity. Metadata reconciliation never enables a managed tool. */
  async ensureManaged(owner: string, presetId: string, endpointInput: string, secret?: string): Promise<PublicToolConnection> {
    ownerRequired(owner);
    if (presetId !== 'aktools') throw new BadRequestException('MANAGED_TOOL_PRESET_RESTRICTED');
    const endpoint = await this.policy.normalizeEndpoint(endpointInput);
    await this.db.insert(toolConnections).values({ id: randomUUID(), owner, provider: 'mcp', transport: 'streamable_http',
      managedPresetId: presetId, endpoint, secretEnc: secret ? encryptSecret(secret, toolEncryptionKey()) : null })
      .onConflictDoNothing({ target: [toolConnections.owner, toolConnections.managedPresetId] });
    const [row] = await this.db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.managedPresetId, presetId)));
    if (!row) throw new ConflictException('MANAGED_TOOL_CONNECTION_UNAVAILABLE');
    const oldSecret = row.secretEnc ? decryptSecret(row.secretEnc, toolEncryptionKey()) : undefined;
    if (row.endpoint !== endpoint || oldSecret !== secret) {
      const [updated] = await this.db.update(toolConnections).set({ endpoint, secretEnc: secret ? encryptSecret(secret, toolEncryptionKey()) : null,
        revision: row.revision + 1, status: 'configured', allowedToolIds: [], toolEffects: {}, catalogVersionId: null,
        candidateCatalogVersionId: null, verifiedAt: null, updatedAt: new Date() }).where(and(eq(toolConnections.owner, owner),
        eq(toolConnections.id, row.id), eq(toolConnections.revision, row.revision))).returning();
      if (!updated) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
      return this.project(updated);
    }
    return this.project(row);
  }

  async managed(owner: string, presetId: string): Promise<PublicToolConnection | null> {
    ownerRequired(owner);
    const [row] = await this.db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.managedPresetId, presetId)));
    return row ? this.project(row) : null;
  }
  async create(owner: string, input: unknown): Promise<PublicToolConnection> {
    ownerRequired(owner);
    const config = parse(configSchema, input);
    this.adapter(config.provider);
    const endpoint = config.provider === 'mcp' ? await this.policy.normalizeEndpoint(config.endpoint ?? '') : null;
    if (config.provider !== 'mcp' && (config.endpoint || config.oauth)) throw new BadRequestException('FIXED_PROVIDER_ENDPOINT_REQUIRED');
    if (config.provider !== 'composio' && config.providerConfig) throw new BadRequestException('TOOL_PROVIDER_CONFIG_RESTRICTED');
    if (config.oauth && config.credential) throw new BadRequestException('TOOL_AUTH_METHOD_CONFLICT');
    const oauth = config.oauth ? { ...config.oauth,
      authorizationUrl: await this.policy.normalizeEndpoint(config.oauth.authorizationUrl),
      tokenUrl: await this.policy.normalizeEndpoint(config.oauth.tokenUrl) } : null;
    if (oauth && new URL(oauth.authorizationUrl).origin !== new URL(oauth.tokenUrl).origin) throw new BadRequestException('OAUTH_ISSUER_MISMATCH');
    const [saved] = await this.db.insert(toolConnections).values({ id: randomUUID(), owner, provider: config.provider,
      transport: config.provider === 'mcp' ? 'streamable_http' : 'adapter', endpoint,
      providerConfig: config.providerConfig ?? null,
      secretEnc: config.credential ? encryptSecret(config.credential, toolEncryptionKey()) : null,
      status: config.oauth || (config.provider !== 'mcp' && !config.credential) ? 'authorization_required' : 'configured', oauthConfig: oauth }).returning();
    return this.project(saved);
  }

  async setCredential(owner: string, id: string, input: unknown): Promise<PublicToolConnection> {
    const body = parse(z.object({ revision: z.number().int().positive(), credential: z.string().min(1).max(16_000) }).strict(), input);
    const row = await this.row(owner, id);
    const [saved] = await this.db.update(toolConnections).set({ secretEnc: encryptSecret(body.credential, toolEncryptionKey()),
      revision: row.revision + 1, status: 'configured', allowedToolIds: [], catalogVersionId: null, candidateCatalogVersionId: null, verifiedAt: null, updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, body.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return this.project(saved);
  }

  async disconnect(owner: string, id: string): Promise<PublicToolConnection> {
    const row = await this.row(owner, id);
    const [saved] = await this.db.update(toolConnections).set({ secretEnc: null, status: 'unconfigured',
      revision: row.revision + 1, allowedToolIds: [], catalogVersionId: null, candidateCatalogVersionId: null, verifiedAt: null, updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, row.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return this.project(saved);
  }

  /** Explicit discovery can contact a server; it only initializes and lists, never calls a tool. */
  async discover(owner: string, id: string) {
    const row = await this.row(owner, id);
    if (row.status === 'unconfigured' || row.status === 'authorization_required') throw new BadRequestException('TOOL_AUTHORIZATION_REQUIRED');
    let descriptors: AgentToolDescriptor[];
    try {
      const connection = this.credential(row);
      descriptors = await this.adapter(row.provider).discover(connection);
      if (connection.secret && JSON.stringify(descriptors).includes(connection.secret)) throw new ToolAdapterError('TOOL_CATALOG_RESTRICTED');
    }
    catch (error) {
      const code = error instanceof ToolAdapterError ? error.code : 'TOOL_DISCOVERY_FAILED';
      await this.db.update(toolConnections).set({ lastDiscoveryAt: new Date(), lastDiscoveryCode: code,
        ...(code === 'TOOL_AUTHORIZATION_REQUIRED' ? { status: 'authorization_required' } : row.catalogVersionId ? {} : { status: 'unavailable' }), updatedAt: new Date() })
        .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, row.revision)));
      throw new BadRequestException(code);
    }
    const catalogId = randomUUID();
    descriptors = descriptors.map(tool => ({ ...tool, catalogVersionId: catalogId })).sort((a, b) => a.id.localeCompare(b.id));
    const schemaHash = toolHash(descriptors.map(tool => ({ ...tool, catalogVersionId: '' })));
    return this.db.transaction(async tx => {
      const [latest] = await tx.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id))).for('update');
      if (!latest || latest.revision !== row.revision) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
      const [active] = latest.catalogVersionId ? await tx.select().from(toolCatalogVersions).where(and(eq(toolCatalogVersions.owner, owner), eq(toolCatalogVersions.id, latest.catalogVersionId))) : [];
      const [candidate] = latest.candidateCatalogVersionId ? await tx.select().from(toolCatalogVersions).where(and(eq(toolCatalogVersions.owner, owner), eq(toolCatalogVersions.id, latest.candidateCatalogVersionId))) : [];
      const same = active?.schemaHash === schemaHash ? active : candidate?.schemaHash === schemaHash ? candidate : null;
      if (same) {
        const [saved] = await tx.update(toolConnections).set({ lastDiscoveryAt: new Date(), lastDiscoveryCode: null,
          ...(active?.id === same.id ? { candidateCatalogVersionId: null,
            status: latest.status === 'reconfirmation_required' ? latest.allowedToolIds.length ? 'configured' : 'restricted' : latest.status } : {}),
          verifiedAt: new Date(), updatedAt: new Date() }).where(eq(toolConnections.id, id)).returning();
        return { connection: this.project(saved), catalog: same };
      }
      const affected = active && latest.allowedToolIds.some(toolId => {
        const previous = active.descriptors.find(tool => tool.id === toolId), next = descriptors.find(tool => tool.id === toolId);
        return !previous || !next || toolHash({ ...previous, catalogVersionId: '' }) !== toolHash({ ...next, catalogVersionId: '' });
      });
      const [saved] = await tx.update(toolConnections).set({ candidateCatalogVersionId: catalogId,
        status: affected ? 'reconfirmation_required' : active ? latest.status : 'discovered',
        revision: affected ? latest.revision + 1 : latest.revision, lastDiscoveryAt: new Date(), lastDiscoveryCode: null,
        verifiedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, row.revision))).returning();
      if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
      const [catalog] = await tx.insert(toolCatalogVersions).values({ id: catalogId, owner, connectionId: id,
        connectionRevision: saved.revision, schemaHash, descriptors }).returning();
      return { connection: this.project(saved), catalog };
    });
  }

  async enable(owner: string, id: string, input: unknown, db: ConnectionDatabase = this.db): Promise<PublicToolConnection> {
    const body = parse(enableSchema, input), row = await this.row(owner, id, db);
    const catalog = await this.catalog(owner, id, true, db);
    if (!catalog || catalog.id !== body.catalogVersionId || catalog.schemaHash !== body.schemaHash || row.revision !== body.revision) {
      throw new ConflictException('TOOL_CATALOG_RECONFIRMATION_REQUIRED');
    }
    if (new Set(body.toolIds).size !== body.toolIds.length || body.toolIds.some(toolId => !catalog.descriptors.some(tool => tool.id === toolId))
      || Object.keys(body.effects ?? {}).some(toolId => !body.toolIds.includes(toolId))) throw new BadRequestException('TOOL_NOT_IN_CATALOG');
    if (row.provider !== 'mcp' && catalog.descriptors.some(tool => body.effects?.[tool.id] && body.effects[tool.id] !== tool.effect)) {
      throw new BadRequestException('TRUSTED_TOOL_EFFECT_IMMUTABLE');
    }
    const [saved] = await db.update(toolConnections).set({ catalogVersionId: catalog.id, candidateCatalogVersionId: null,
      allowedToolIds: body.toolIds, allowedDataClasses: body.dataClasses as AgentDataClass[],
      toolEffects: (body.effects ?? {}) as Record<string, AgentToolEffect>, revision: row.revision + 1,
      status: body.toolIds.length ? 'configured' : 'restricted', updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, body.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return this.project(saved);
  }
  private enabledDescriptors(row: ConnectionRow, descriptors: AgentToolDescriptor[]): AgentToolDescriptor[] {
    return descriptors.filter(tool => row.allowedToolIds.includes(tool.id)).map(tool => ({ ...tool,
      effect: row.toolEffects[tool.id] ?? tool.effect, dataClasses: [...row.allowedDataClasses] }));
  }
  async freezeCatalog(owner: string, managedPresetId?: string) {
    ownerRequired(owner);
    return this.db.transaction(async tx => {
      // Repeatable transaction read through row locks keeps catalog references and permission revisions coherent.
      const rows = await tx.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.status, 'configured'),
        managedPresetId ? eq(toolConnections.managedPresetId, managedPresetId) : isNull(toolConnections.managedPresetId))).for('share');
      const descriptors: AgentToolDescriptor[] = [], revisions: Record<string, number> = {};
      for (const row of rows) {
        if (!row.catalogVersionId || !row.allowedToolIds.length) continue;
        const [catalog] = await tx.select().from(toolCatalogVersions).where(and(eq(toolCatalogVersions.owner, owner), eq(toolCatalogVersions.id, row.catalogVersionId), eq(toolCatalogVersions.connectionId, row.id)));
        if (!catalog) throw new ConflictException('TOOL_CATALOG_UNAVAILABLE');
        descriptors.push(...this.enabledDescriptors(row, catalog.descriptors)); revisions[row.id] = row.revision;
      }
      return catalogSnapshot(descriptors, revisions);
    });
  }

  /** Only called by the runtime after durable invocation/budget reservation and approval checks. */
  async invokeFrozen(owner: string, tool: AgentToolDescriptor, expectedRevision: number, args: Record<string, unknown>,
    context: ToolAdapterContext): Promise<ToolAdapterResult> {
    const row = await this.row(owner, tool.connectionId ?? '');
    if (row.revision !== expectedRevision || row.status !== 'configured' || row.catalogVersionId !== tool.catalogVersionId) {
      throw new ToolAdapterError('TOOL_CONNECTION_REVISION_CHANGED');
    }
    const catalog = await this.catalog(owner, row.id, false);
    const current = catalog ? this.enabledDescriptors(row, catalog.descriptors).find(item => item.id === tool.id) : null;
    if (!current || toolHash(current) !== toolHash(tool)) throw new ToolAdapterError('TOOL_NOT_ENABLED');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 64_000) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    try {
      if (!new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    } catch { throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS'); }
    try {
      const connection = this.credential(row);
      const result = await this.adapter(row.provider).invoke(connection, tool, args, { ...context,
        beforeDispatch: async () => {
          const latest = await this.row(owner, row.id);
          if (latest.revision !== expectedRevision || latest.status !== 'configured') throw new ToolAdapterError('TOOL_CONNECTION_REVISION_CHANGED');
          await context.beforeDispatch?.();
        },
        onReceipt: async receipt => {
          if (receipt.remoteJobId) await this.db.insert(toolRemoteJobs).values({ id: randomUUID(), owner, connectionId: row.id,
            connectionRevision: row.revision, invocationId: context.invocationId, remoteJobId: receipt.remoteJobId, state: receipt.state,
            limits: { maxPages: args.maxPages, maxDepth: args.maxDepth, maxCredits: args.maxCredits } }).onConflictDoNothing();
          await context.onReceipt?.(receipt);
        } });
      // A hostile remote server can echo its Authorization header in content; do not forward known secrets.
      return connection.secret ? JSON.parse(JSON.stringify(result).replaceAll(JSON.stringify(connection.secret).slice(1, -1), '[REDACTED]')) : result;
    } catch (error) {
      if (error instanceof ToolAdapterError && ['TOOL_RECONFIRMATION_REQUIRED', 'TOOL_AUTHORIZATION_REQUIRED'].includes(error.code)) {
        await this.db.update(toolConnections).set({ status: error.code === 'TOOL_RECONFIRMATION_REQUIRED' ? 'reconfirmation_required' : 'authorization_required',
          revision: sql`${toolConnections.revision} + 1`, allowedToolIds: [], updatedAt: new Date() })
          .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, row.id), eq(toolConnections.revision, row.revision)));
      }
      throw error;
    }
  }

  async remoteJob(owner: string, id: string, cancel = false): Promise<ToolAdapterResult> {
    ownerRequired(owner);
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException('TOOL_JOB_NOT_FOUND');
    const [job] = await this.db.select().from(toolRemoteJobs).where(and(eq(toolRemoteJobs.owner, owner), eq(toolRemoteJobs.id, id)));
    if (!job) throw new NotFoundException('TOOL_JOB_NOT_FOUND');
    const row = await this.row(owner, job.connectionId);
    if (row.revision !== job.connectionRevision || row.status !== 'configured') throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    const adapter = this.adapter(row.provider);
    if (!(adapter instanceof FirecrawlAdapter)) throw new BadRequestException('TOOL_JOB_UNSUPPORTED');
    const result = cancel ? await adapter.cancel(this.credential(row), job.remoteJobId) : await adapter.status(this.credential(row), job.remoteJobId);
    await this.db.update(toolRemoteJobs).set({ state: result.receipt.state, updatedAt: new Date() })
      .where(and(eq(toolRemoteJobs.owner, owner), eq(toolRemoteJobs.id, id)));
    return result;
  }

  /** Connecting an app changes authorization only; it does not execute an application tool. */
  async authorizeComposio(owner: string, id: string): Promise<{ authorizationUrl: string }> {
    const row = await this.row(owner, id), connection = this.credential(row);
    if (row.provider !== 'composio' || !row.providerConfig?.authConfigId) throw new BadRequestException('COMPOSIO_AUTH_CONFIG_REQUIRED');
    if (process.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED !== '1') throw new BadRequestException('COMPOSIO_CALLBACK_VERIFIER_REQUIRED');
    const value = await new ProviderHttp(this.policy).json('https://backend.composio.dev/api/v3.1/connected_accounts/link', connection.secret,
      { auth_config_id: row.providerConfig.authConfigId, user_id: connection.externalUserId }, undefined, 'x-api-key');
    if (typeof value.redirect_url !== 'string' || typeof value.connected_account_id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,120}$/u.test(value.connected_account_id)) throw new BadRequestException('COMPOSIO_AUTH_RESPONSE_INVALID');
    const authorization = new URL(value.redirect_url), validation = new URL(value.redirect_url); validation.search = '';
    await new ToolTransportPolicy([]).normalizeEndpoint(validation.href);
    const [saved] = await this.db.update(toolConnections).set({ providerConfig: { ...row.providerConfig, connectedAccountId: value.connected_account_id },
      revision: row.revision + 1, status: 'authorization_required', allowedToolIds: [], catalogVersionId: null, candidateCatalogVersionId: null, updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, row.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return { authorizationUrl: authorization.href };
  }
  async completeComposio(owner: string, id: string, input: unknown): Promise<PublicToolConnection> {
    const body = parse(z.object({ sessionUri: z.string().min(1).max(2000) }).strict(), input), row = await this.row(owner, id);
    if (row.provider !== 'composio' || row.status !== 'authorization_required' || !row.providerConfig?.connectedAccountId || process.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED !== '1') {
      throw new BadRequestException('COMPOSIO_CALLBACK_VERIFIER_REQUIRED');
    }
    const connection = this.credential(row), http = new ProviderHttp(this.policy);
    const [claimed] = await this.db.insert(toolOAuthStates).values({ id: randomUUID(), owner, connectionId: id, connectionRevision: row.revision,
      stateHash: toolHash(body.sessionUri), verifierEnc: encryptSecret('composio-callback-verification', toolEncryptionKey()),
      consumedAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) }).onConflictDoNothing().returning();
    if (!claimed) throw new BadRequestException('TOOL_OAUTH_STATE_INVALID');
    const result = await http.json('https://backend.composio.dev/api/v3.1/connected_accounts/complete_auth', connection.secret,
      { session_uri: body.sessionUri, user_id: connection.externalUserId }, undefined, 'x-api-key');
    if (result.connected_account_id !== row.providerConfig.connectedAccountId) throw new BadRequestException('COMPOSIO_ACCOUNT_OWNER_MISMATCH');
    const account = await http.json(`https://backend.composio.dev/api/v3.1/connected_accounts/${row.providerConfig.connectedAccountId}`,
      connection.secret, null, undefined, 'x-api-key', 'GET');
    if (account.user_id !== connection.externalUserId || account.status !== 'ACTIVE' || account.is_disabled === true) throw new BadRequestException('COMPOSIO_ACCOUNT_OWNER_MISMATCH');
    const [saved] = await this.db.update(toolConnections).set({ revision: row.revision + 1, status: 'configured', updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, id), eq(toolConnections.revision, row.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return this.project(saved);
  }
}
