import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../../common/platform';
import { dataLibrarySources, dataLibraryVersions, financialDataConnections } from '../../../database/data-library.schema';
import { researchSourcePolicies } from '../../../database/research-artifacts.schema';
import type { DataFinancialQuery, DataFinancialQueryResult } from '../../../../shared/data-library.interface';
import { ToolConnectionsService } from '../../tool-connections/tool-connections.service';
import { DataDatasetService } from '../data-dataset.service';
import { canonicalJson, hashContent } from '../../research-artifacts/research-artifacts.rules';
import { AktoolsProvider } from './aktools.provider';
import { TushareProvider } from './tushare.provider';
import type { FinancialProviderQuery } from './financial-provider.interface';
import { ToolCapabilityGrantsService } from '../../tool-capabilities/tool-capability-grants.service';

@Injectable()
export class FinancialDatasetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly connections?: ToolConnectionsService,
    @Optional() private readonly grants?: ToolCapabilityGrantsService) {}
  private async aktools(owner: string) {
    const endpoint = process.env.FINANCIAL_AKTOOLS_MCP_URL;
    if (!endpoint || !this.connections) throw new Error('AKTOOLS_CONNECTION_REQUIRED');
    const managed = await this.connections.managed(owner, 'aktools');
    const grant = managed ? await this.grants?.require(owner, 'market_data', ['public']) : null;
    if (managed && !grant || !managed && process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED === 'true') throw new Error('TOOL_CAPABILITY_DISABLED');
    const candidates = managed ? [managed] : (await this.connections.list(owner)).filter(connection => connection.provider === 'mcp' &&
      connection.endpoint === new URL(endpoint).href && connection.status === 'configured');
    if (candidates.length !== 1) throw new Error('AKTOOLS_CONNECTION_REQUIRED');
    const connection = candidates[0];
    if (connection.endpoint !== new URL(endpoint).href || connection.status !== 'configured') throw new Error('AKTOOLS_CONNECTION_REQUIRED');
    const catalog = await this.connections.freezeCatalog(owner, managed ? 'aktools' : undefined);
    const tool = catalog.descriptors.find(descriptor => descriptor.connectionId === connection.id && descriptor.name === 'get_data');
    if (!tool || tool.effect !== 'read' || !tool.dataClasses.includes('public')) throw new Error('AKTOOLS_READ_PERMISSION_REQUIRED');
    return { connection, catalog, tool, grant };
  }
  async available(owner: string): Promise<boolean> { try { await this.aktools(owner); return true; } catch { return false; } }
  async query(owner: string, input: DataFinancialQuery, secret: string | null): Promise<Pick<DataFinancialQueryResult,
    'data' | 'dataset' | 'libraryReference' | 'sourceVersion' | 'status' | 'sources'>> {
    let [before] = await this.db.select().from(financialDataConnections).where(and(eq(financialDataConnections.owner, owner),
      eq(financialDataConnections.provider, input.provider)));
    if (!before && input.provider === 'aktools') {
      await this.db.insert(financialDataConnections).values({ owner, provider: input.provider, enabled: true }).onConflictDoNothing();
      [before] = await this.db.select().from(financialDataConnections).where(and(eq(financialDataConnections.owner, owner),
        eq(financialDataConnections.provider, input.provider)));
    }
    if (!before || !before.enabled) throw new Error('PROVIDER_DISABLED');
    const request: FinancialProviderQuery = { operation: input.operation as FinancialProviderQuery['operation'],
      market: input.market!, exchange: input.exchange, symbol: input.symbol, from: input.from, to: input.to,
      ...(input.adjustment ? { adjustment: input.adjustment } : {}) };
    const ak = input.provider === 'aktools' ? await this.aktools(owner) : null;
    const provider = ak ? new AktoolsProvider(async (name, args) => {
      if (name !== 'get_data') throw new Error('AKTOOLS_OPERATION_REJECTED');
      const result = await this.connections!.invokeFrozen(owner, ak.tool, ak.catalog.connectionRevisions[ak.connection.id], args,
        { invocationId: randomUUID(), beforeDispatch: async () => {
          if (ak.grant) await this.grants!.requireCurrent(owner, 'market_data', ak.grant.revision, ['public']);
          const [current] = await this.db.select().from(financialDataConnections).where(and(eq(financialDataConnections.owner, owner),
            eq(financialDataConnections.provider, input.provider)));
          if (!current?.enabled || current.updatedAt.getTime() !== before.updatedAt.getTime()) throw new Error('PROVIDER_CONNECTION_CHANGED');
        } });
      return result.output;
    }) : new TushareProvider(secret ?? '');
    const result = await provider.query(request);
    if (ak) {
      if (ak.grant) await this.grants!.requireCurrent(owner, 'market_data', ak.grant.revision, ['public']);
      const current = await this.connections!.detail(owner, ak.connection.id);
      if (current.revision !== ak.connection.revision || current.status !== 'configured') throw new Error('PROVIDER_CONNECTION_CHANGED');
    }
    return this.db.transaction(async tx => {
      if (ak?.grant) {
        // Hold owner authority through the publishing transaction so concurrent revoke wins or waits.
        await this.grants!.requireCurrent(owner, 'market_data', ak.grant.revision, ['public'], tx);
      }
      const [current] = await tx.select().from(financialDataConnections).where(and(eq(financialDataConnections.owner, owner),
        eq(financialDataConnections.provider, input.provider))).for('share');
      if (!current?.enabled || current.secretEnc !== before.secretEnc || current.updatedAt.getTime() !== before.updatedAt.getTime()) throw new Error('PROVIDER_CONNECTION_CHANGED');
      const originalHash = hashContent(result.rows);
      const [source] = await tx.insert(dataLibrarySources).values({ owner, kind: 'file', format: 'json',
        title: `${result.provider} · ${input.exchange ?? input.market} ${input.symbol} · ${input.operation}`,
        description: `${result.rows.length} rows · ${result.coverage.status}`, state: 'ready', versionCount: 1 }).returning();
      const [version] = await tx.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1,
        contentHash: originalHash, rawContent: canonicalJson(result.rows), extractedText: `${result.provider} ${input.symbol} ${input.operation}; ${result.rows.length} rows; coverage=${result.coverage.status}`,
        sections: [], byteLength: Buffer.byteLength(canonicalJson(result.rows)), extractionState: 'ready' }).returning();
      await tx.update(dataLibrarySources).set({ latestVersionId: version.id, lastSuccessAt: new Date() }).where(eq(dataLibrarySources.id, source.id));
      await tx.insert(researchSourcePolicies).values({ owner, sourceVersionId: version.id, dataClasses: ['public'],
        permittedUses: ['research'] });
      const datasets = new DataDatasetService(tx);
      const dataset = await datasets.create(owner, { rows: result.rows, metadata: {
        sourceVersion: { sourceId: source.id, sourceVersionId: version.id, contentHash: originalHash }, dependencies: [],
        schema: { fields: [...new Set(result.rows.flatMap(row => Object.keys(row)))], sourceUrl: result.sourceUrl,
          instrument: result.instrument, query: request }, schemaVersion: 'financial-row-v1',
        provider: result.provider, operation: result.operation, parameterVersion: result.parameterVersion, timing: result.timing,
        coverage: result.coverage, adjustment: result.adjustment, corporateActionsVersionId: null, dataClasses: ['public'],
        license: { termsRef: result.sourceUrl, permittedUses: ['research'], retentionUntil: null } } });
      const preview = await datasets.summary(owner, dataset.id, 12);
      return { status: result.coverage.status === 'complete' ? 'succeeded' : 'partial', data: { rows: preview.rows,
        timing: result.timing, adjustment: result.adjustment, instrument: result.instrument }, dataset: preview.summary,
        libraryReference: { sourceId: source.id, versionId: version.id },
        sourceVersion: dataset.sourceVersion,
        sources: [{ title: `${result.provider} · ${result.operation}`, url: result.sourceUrl, fetchedAt: result.timing.fetchedAt }] };
    });
  }
}
