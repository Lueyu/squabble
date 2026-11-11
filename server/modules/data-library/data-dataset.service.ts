import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchDatasetVersions } from '../../database/research-artifacts.schema';
import type { ResearchDatasetVersion, ResearchDatasetSummary } from '../../../shared/research-dataset.interface';
import { assertSourceVersions, earliestRetention, intersectUses, sourceRefs,
  type SourceDatabase } from '../research-artifacts/research-artifacts.rules';
import { datasetContentHash, validateDataset, type DatasetCreate } from './data-dataset.rules';

export async function readDataset(db: SourceDatabase, owner: string, id: string): Promise<{
  metadata: ResearchDatasetVersion; rows: Record<string, unknown>[];
}> {
  const [row] = await db.select().from(researchDatasetVersions).where(and(
    eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, id))).for('share');
  if (!row) throw new Error('DATASET_NOT_FOUND');
  if (row.status !== 'active') throw new Error('DATASET_REVOKED');
  const policies = await assertSourceVersions(db, owner, [row.metadata.sourceVersion, ...row.metadata.dependencies]);
  const retentionUntil = earliestRetention([row.metadata.license.retentionUntil, ...policies.map(policy => policy.retentionUntil)]);
  if (retentionUntil && Date.parse(retentionUntil) <= Date.now()) {
    throw new Error('DATASET_RETENTION_EXPIRED');
  }
  return { metadata: { ...row.metadata, status: 'active',
    dataClasses: [...new Set([...row.metadata.dataClasses, ...policies.flatMap(policy => policy.dataClasses)])].sort(),
    license: { ...row.metadata.license, retentionUntil,
      permittedUses: intersectUses([row.metadata.license.permittedUses, ...policies.map(policy => policy.permittedUses)]) } }, rows: row.rows };
}
@Injectable()
export class DataDatasetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async create(owner: string, input: DatasetCreate): Promise<ResearchDatasetVersion> {
    validateDataset(input);
    return this.db.transaction(async tx => {
      const refs = sourceRefs([input.metadata.sourceVersion, ...input.metadata.dependencies]);
      const policies = await assertSourceVersions(tx, owner, refs);
      const metadata = { ...input.metadata, dependencies: refs.filter(ref => ref.sourceVersionId !== input.metadata.sourceVersion.sourceVersionId),
        dataClasses: [...new Set([...input.metadata.dataClasses, ...policies.flatMap(policy => policy.dataClasses)])].sort(),
        license: { ...input.metadata.license,
          permittedUses: intersectUses([input.metadata.license.permittedUses, ...policies.map(policy => policy.permittedUses)]),
          retentionUntil: earliestRetention([input.metadata.license.retentionUntil, ...policies.map(policy => policy.retentionUntil)]) } };
      // Mutable inherited permissions are evaluated on every read, not part of immutable content identity.
      const contentHash = datasetContentHash(metadata, input.rows);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${owner}:${metadata.sourceVersion.sourceVersionId}:${contentHash}`},54))`);
      const [existing] = await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner),
        eq(researchDatasetVersions.sourceVersionId, metadata.sourceVersion.sourceVersionId), eq(researchDatasetVersions.contentHash, contentHash)));
      if (existing) { if (existing.status !== 'active') throw new Error('DATASET_REVOKED'); return existing.metadata; }
      const id = crypto.randomUUID();
      const saved: ResearchDatasetVersion = { ...metadata, id, owner, contentHash, status: 'active', storageRef: `dataset:${id}` };
      await tx.insert(researchDatasetVersions).values({ id, owner, sourceId: metadata.sourceVersion.sourceId,
        sourceVersionId: metadata.sourceVersion.sourceVersionId, contentHash, metadata: saved, rows: input.rows });
      return saved;
    });
  }
  async read(owner: string, id: string): Promise<ResearchDatasetVersion> {
    return this.db.transaction(async tx => (await readDataset(tx, owner, id)).metadata);
  }
  async rows(owner: string, id: string): Promise<Record<string, unknown>[]> {
    return this.db.transaction(async tx => (await readDataset(tx, owner, id)).rows);
  }
  async summary(owner: string, id: string, sampleSize = 12): Promise<{ summary: ResearchDatasetSummary; rows: Record<string, unknown>[] }> {
    if (!Number.isSafeInteger(sampleSize) || sampleSize < 0 || sampleSize > 100) throw new Error('INVALID_SAMPLE_SIZE');
    return this.db.transaction(async tx => {
      const result = await readDataset(tx, owner, id), rows = result.rows.slice(0, sampleSize);
      return { rows, summary: { datasetVersionId: id, contentHash: result.metadata.contentHash,
        rowCount: result.rows.length, sampleSize: rows.length, truncated: rows.length < result.rows.length,
        coverage: result.metadata.coverage } };
    });
  }
  async revoke(owner: string, id: string): Promise<void> {
    const rows = await this.db.update(researchDatasetVersions).set({ status: 'revoked' })
      .where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, id))).returning({ id: researchDatasetVersions.id });
    if (!rows.length) throw new Error('DATASET_NOT_FOUND');
  }
}
