import { BadRequestException, ConflictException, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { canonicalHash } from '../../common/agent-contract';
import { toolCapabilityGrants, toolCapabilityReadiness } from '../../database/tool-capabilities.schema';
import { toolConnections } from '../../database/tool-connections.schema';
import { ToolConnectionsService } from '../tool-connections/tool-connections.service';
import { TOOL_CAPABILITY_PACK_IDS, type ToolCapabilityView } from '../../../shared/tool-capabilities.interface';
import { ToolCapabilityGrantsService } from './tool-capability-grants.service';
import { AKTOOLS_GET_DATA_SCHEMA, capabilityManifest, capabilityPackId, CAPABILITY_MANIFEST_VERSION, MAX_READINESS_AGE_MS } from './tool-capabilities.manifest';
import { ToolCapabilityReadinessService, type CapabilityReadinessPort } from './tool-capability-readiness.service';

const activation = z.strictObject({ grants: z.array(z.strictObject({ packId: z.enum(TOOL_CAPABILITY_PACK_IDS),
  revision: z.number().int().nonnegative(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  dataClasses: z.array(z.enum(['public', 'private_material', 'portfolio', 'application'])).min(1).max(4),
  catalogVersionId: z.uuid().nullable().optional(), schemaHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
})).min(1).max(4), publicNetwork: z.boolean() });

/** Preparation observes metadata. Only explicit activation changes business authority. */
@Injectable()
export class ToolCapabilitiesService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private preparing?: Promise<void>;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly connections: ToolConnectionsService, private readonly grants: ToolCapabilityGrantsService,
    @Inject(ToolCapabilityReadinessService) private readonly readiness: CapabilityReadinessPort) {}

  onModuleInit(): void {
    if (process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED !== 'true') return;
    void this.prepareFacts().catch(() => undefined);
    this.timer = setInterval(() => { void this.prepareFacts().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private owner(owner: string): void { if (!owner?.trim()) throw new BadRequestException('TOOL_OWNER_REQUIRED'); }
  private async prepareFacts(): Promise<void> {
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      const facts = await this.readiness.probe();
      for (const packId of TOOL_CAPABILITY_PACK_IDS) {
        const manifest = capabilityManifest(packId), result = facts[packId];
        const safeFacts = { ...result.facts, configurationHash: manifest.configurationHash };
        const record = { packId, manifestHash: canonicalHash({ configurationHash: manifest.configurationHash, facts: safeFacts }),
          ready: result.ready, facts: safeFacts, reasonCode: result.reasonCode ?? null, checkedAt: new Date() };
        await this.db.insert(toolCapabilityReadiness).values(record).onConflictDoUpdate({ target: toolCapabilityReadiness.packId, set: record });
      }
    })();
    try { await this.preparing; } finally { this.preparing = undefined; }
  }
  private reviewedAktools(catalog: Awaited<ReturnType<ToolConnectionsService['catalog']>>) {
    return catalog?.descriptors.find(tool => tool.name === 'get_data'
      && canonicalHash(tool.inputSchema) === canonicalHash(AKTOOLS_GET_DATA_SCHEMA));
  }
  async list(owner: string): Promise<ToolCapabilityView[]> {
    this.owner(owner);
    const [saved, preparations, connection] = await Promise.all([
      this.db.select().from(toolCapabilityGrants).where(eq(toolCapabilityGrants.owner, owner)),
      this.db.select().from(toolCapabilityReadiness), this.connections.managed(owner, 'aktools'),
    ]);
    const catalog = connection ? await this.connections.catalog(owner, connection.id) : null;
    return TOOL_CAPABILITY_PACK_IDS.map(packId => {
      const manifest = capabilityManifest(packId), preparation = preparations.find(item => item.packId === packId), grant = saved.find(item => item.packId === packId);
      const fresh = preparation && Date.now() - preparation.checkedAt.getTime() <= MAX_READINESS_AGE_MS;
      const prepared = Boolean(fresh && preparation.ready && preparation.facts.configurationHash === manifest.configurationHash);
      const catalogState: ToolCapabilityView['catalog'] = packId !== 'market_data' ? prepared ? 'verified' : 'unavailable'
        : !this.reviewedAktools(catalog) ? 'unavailable'
          : connection?.candidateCatalogVersionId && connection.catalogVersionId ? 'changed' : 'verified';
      const review = Boolean(grant?.enabled && (grant.manifestHash !== preparation?.manifestHash || catalogState === 'changed'
        || packId === 'market_data' && (connection?.status !== 'configured' || !connection.allowedToolIds.length)));
      const grantState: ToolCapabilityView['grant'] = !grant?.enabled ? 'disabled' : review ? 'review_required' : 'enabled';
      return { packId, manifestVersion: CAPABILITY_MANIFEST_VERSION,
        manifestHash: preparation?.facts.configurationHash === manifest.configurationHash ? preparation.manifestHash : manifest.configurationHash,
        installation: prepared ? 'ready' : preparation ? 'unavailable' : 'starting', catalog: catalogState, grant: grantState,
        revision: grant?.revision ?? 0, dataClasses: grant?.dataClasses ?? [], connectionId: packId === 'market_data' ? connection?.id ?? null : null,
        catalogVersionId: packId === 'market_data' ? catalog?.id ?? null : null, schemaHash: packId === 'market_data' ? catalog?.schemaHash ?? null : null,
        checkedAt: preparation?.checkedAt.toISOString() ?? null,
        reasonCode: !prepared ? preparation?.reasonCode ?? 'TOOL_CAPABILITY_PREPARATION_REQUIRED'
          : catalogState === 'unavailable' ? connection?.lastDiscoveryCode ?? 'TOOL_CAPABILITY_CATALOG_UNVERIFIED' : review ? 'TOOL_CAPABILITY_REVIEW_REQUIRED' : null,
        ready: prepared && catalogState === 'verified' && grantState === 'enabled', facts: preparation?.facts ?? {} };
    });
  }
  async refresh(owner: string): Promise<ToolCapabilityView[]> {
    this.owner(owner);
    await this.prepareFacts();
    const endpoint = this.readiness.aktoolsEndpoint();
    if (endpoint) {
      try {
        const connection = await this.connections.ensureManaged(owner, 'aktools', endpoint, this.readiness.aktoolsCredential());
        await this.connections.discover(owner, connection.id);
      } catch { /* Owner discovery state is recorded by connections; never poison another owner's deployment facts. */ }
    }
    const preparations = await this.db.select().from(toolCapabilityReadiness);
    const managed = await this.connections.managed(owner, 'aktools');
    for (const packId of TOOL_CAPABILITY_PACK_IDS) {
      const preparation = preparations.find(item => item.packId === packId);
      await this.db.insert(toolCapabilityGrants).values({ owner, packId, manifestHash: preparation?.manifestHash ?? capabilityManifest(packId).configurationHash,
        connectionId: packId === 'market_data' ? managed?.id ?? null : null }).onConflictDoNothing();
    }
    if (managed) await this.db.update(toolCapabilityGrants).set({ connectionId: managed.id, enabled: false,
      revision: sql`${toolCapabilityGrants.revision} + 1`, updatedAt: new Date() }).where(and(eq(toolCapabilityGrants.owner, owner),
      eq(toolCapabilityGrants.packId, 'market_data'), isNull(toolCapabilityGrants.connectionId)));
    return this.list(owner);
  }
  async activate(owner: string, input: unknown): Promise<ToolCapabilityView[]> {
    this.owner(owner);
    const parsed = activation.safeParse(input);
    if (!parsed.success || new Set(parsed.data.grants.map(item => item.packId)).size !== parsed.data.grants.length) throw new BadRequestException('INVALID_TOOL_CAPABILITY_ACTIVATION');
    const body = parsed.data;
    await this.db.transaction(async tx => {
      for (const desired of [...body.grants].sort((a, b) => a.packId.localeCompare(b.packId))) {
        const manifest = capabilityManifest(desired.packId);
        const [saved] = await tx.select().from(toolCapabilityGrants).where(and(eq(toolCapabilityGrants.owner, owner), eq(toolCapabilityGrants.packId, desired.packId))).for('update');
        const [preparation] = await tx.select().from(toolCapabilityReadiness).where(eq(toolCapabilityReadiness.packId, desired.packId)).for('share');
        if (!saved || !preparation?.ready || Date.now() - preparation.checkedAt.getTime() > MAX_READINESS_AGE_MS) throw new BadRequestException('TOOL_CAPABILITY_NOT_PREPARED');
        if (saved.revision !== desired.revision || desired.manifestHash !== preparation.manifestHash
          || preparation.facts.configurationHash !== manifest.configurationHash) throw new ConflictException('TOOL_CAPABILITY_REVISION_CHANGED');
        if (desired.dataClasses.some(kind => !manifest.dataClasses.includes(kind)) || new Set(desired.dataClasses).size !== desired.dataClasses.length) throw new BadRequestException('TOOL_CAPABILITY_DATA_NOT_AUTHORIZED');
        if (manifest.publicNetwork && !body.publicNetwork) throw new BadRequestException('TOOL_CAPABILITY_PUBLIC_NETWORK_REQUIRED');
        const sameGrant = saved.enabled && saved.manifestHash === desired.manifestHash
          && canonicalHash([...saved.dataClasses].sort()) === canonicalHash([...desired.dataClasses].sort())
          && saved.publicNetwork === (manifest.publicNetwork && body.publicNetwork);
        if (desired.packId !== 'market_data' && sameGrant) continue;
        if (desired.packId === 'market_data') {
          if (!saved.connectionId) throw new BadRequestException('TOOL_CAPABILITY_NOT_PREPARED');
          const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, saved.connectionId), eq(toolConnections.owner, owner),
            eq(toolConnections.managedPresetId, 'aktools'))).for('update');
          const catalog = connection ? await this.connections.catalog(owner, connection.id, true, tx) : null;
          const tool = this.reviewedAktools(catalog);
          if (!connection || !tool || !catalog) throw new BadRequestException('TOOL_CAPABILITY_CATALOG_UNVERIFIED');
          if (catalog.id !== desired.catalogVersionId || catalog.schemaHash !== desired.schemaHash) throw new ConflictException('TOOL_CATALOG_RECONFIRMATION_REQUIRED');
          if (!this.readiness.aktoolsEndpoint() || connection.endpoint !== new URL(this.readiness.aktoolsEndpoint()!).href) throw new ConflictException('MANAGED_TOOL_SERVICE_CHANGED');
          if (sameGrant && connection.status === 'configured' && connection.catalogVersionId === catalog.id && !connection.candidateCatalogVersionId
            && connection.allowedToolIds.length === 1 && connection.allowedToolIds[0] === tool.id
            && connection.allowedDataClasses.length === 1 && connection.allowedDataClasses[0] === 'public'
            && connection.toolEffects[tool.id] === 'read') continue;
          await this.connections.enable(owner, connection.id, { revision: connection.revision, catalogVersionId: catalog.id,
            schemaHash: catalog.schemaHash, toolIds: [tool.id], dataClasses: ['public'], effects: { [tool.id]: 'read' } }, tx);
        }
        await tx.update(toolCapabilityGrants).set({ enabled: true, manifestHash: desired.manifestHash, dataClasses: desired.dataClasses,
          publicNetwork: manifest.publicNetwork && body.publicNetwork, revision: saved.revision + 1, updatedAt: new Date() })
          .where(and(eq(toolCapabilityGrants.owner, owner), eq(toolCapabilityGrants.packId, desired.packId)));
      }
    });
    return this.list(owner);
  }
  async revoke(owner: string, packId: string, input: unknown): Promise<ToolCapabilityView[]> {
    this.owner(owner);
    const body = z.strictObject({ revision: z.number().int().positive() }).safeParse(input);
    if (!capabilityPackId(packId) || !body.success) throw new BadRequestException('INVALID_TOOL_CAPABILITY_REQUEST');
    await this.db.transaction(async tx => {
      const [saved] = await tx.update(toolCapabilityGrants).set({ enabled: false, revision: body.data.revision + 1, updatedAt: new Date() })
        .where(and(eq(toolCapabilityGrants.owner, owner), eq(toolCapabilityGrants.packId, packId), eq(toolCapabilityGrants.revision, body.data.revision))).returning();
      if (!saved) throw new ConflictException('TOOL_CAPABILITY_REVISION_CHANGED');
      if (packId === 'market_data' && saved.connectionId) {
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, saved.connectionId))).for('update');
        if (connection) await tx.update(toolConnections).set({ allowedToolIds: [], toolEffects: {}, status: 'restricted',
          revision: connection.revision + 1, updatedAt: new Date() }).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, connection.id)));
      }
    });
    return this.list(owner);
  }
}
