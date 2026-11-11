import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchArtifacts } from '../../database/research-artifacts.schema';
import type { ResearchArtifact } from '../../../shared/research-artifact.interface';
import type { AgentDataClass, AgentSourceVersionRef } from '../../../shared/agent-tooling.interface';
import { readDataset } from '../data-library/data-dataset.service';
import { assertSourceVersions, earliestRetention, intersectUses, sourceRefs } from './research-artifacts.rules';
import { PrivateArtifactStorage, RESEARCH_ARTIFACT_STORAGE } from './research-artifacts.storage';

export interface ArtifactCreate {
  runId: string; type: ResearchArtifact['type']; mime: string; data: Buffer;
  dependencies: AgentSourceVersionRef[]; datasetVersionIds: string[]; dataClasses: AgentDataClass[];
  permittedUses: string[]; retentionUntil: string | null;
}
const allowedMimes = new Set(['application/json', 'application/pdf', 'application/zip', 'application/octet-stream',
  'text/plain', 'text/csv', 'text/markdown', 'text/html', 'image/png', 'image/jpeg', 'image/svg+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
@Injectable()
export class ResearchArtifactsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(RESEARCH_ARTIFACT_STORAGE) private readonly storage: PrivateArtifactStorage) {}
  async create(owner: string, input: ArtifactCreate): Promise<ResearchArtifact> {
    if (!allowedMimes.has(input.mime) || !input.runId || input.dependencies.length > 100 || input.datasetVersionIds.length > 100) {
      throw new Error('INVALID_ARTIFACT');
    }
    let writtenFile: Awaited<ReturnType<PrivateArtifactStorage['write']>> | undefined;
    try {
      return await this.db.transaction(async tx => {
        // The filesystem write and index commit share the sweeper's fence, including across processes.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.storage.ownerDirectory(owner)},54))`);
        const usage = await tx.execute(sql`select count(*)::int count, coalesce(sum(size_bytes),0)::bigint bytes
          from research_artifacts where owner=${owner} and status<>'deleted'`);
        if (Number(usage[0].count) >= 10000 || Number(usage[0].bytes) + input.data.length > 1024 * 1024 * 1024) throw new Error('ARTIFACT_QUOTA');
        const datasets = await Promise.all(input.datasetVersionIds.map(id => readDataset(tx, owner, id)));
        const refs = sourceRefs([...input.dependencies, ...datasets.flatMap(dataset =>
          [dataset.metadata.sourceVersion, ...dataset.metadata.dependencies])]);
        const policies = await assertSourceVersions(tx, owner, refs);
        const file = await this.storage.write(owner, input.data);
        writtenFile = file;
        const id = randomUUID(), artifact: ResearchArtifact = { id, owner, runId: input.runId, type: input.type,
          mime: input.mime, sizeBytes: file.sizeBytes, sha256: file.sha256, privateStorageRef: file.storageRef,
          dependencies: refs, datasetVersionIds: [...new Set(input.datasetVersionIds)],
          effectiveDataClasses: [...new Set([...input.dataClasses, ...policies.flatMap(policy => policy.dataClasses),
            ...datasets.flatMap(dataset => dataset.metadata.dataClasses)])].sort(),
          permittedUses: intersectUses([input.permittedUses, ...policies.map(policy => policy.permittedUses),
            ...datasets.map(dataset => dataset.metadata.license.permittedUses)]),
          retentionUntil: earliestRetention([input.retentionUntil, ...policies.map(policy => policy.retentionUntil),
            ...datasets.map(dataset => dataset.metadata.license.retentionUntil)]), status: 'active' };
        await tx.insert(researchArtifacts).values({ id, owner, runId: input.runId, metadata: artifact,
          storageRef: file.storageRef, sizeBytes: file.sizeBytes, sha256: file.sha256 });
        return artifact;
      });
    } catch (error) {
      if (writtenFile) await this.storage.remove(owner, writtenFile.storageRef);
      throw error;
    }
  }
  async download(owner: string, id: string): Promise<{ artifact: ResearchArtifact; data: Buffer }> {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(researchArtifacts).where(and(eq(researchArtifacts.owner, owner), eq(researchArtifacts.id, id)));
      if (!row) throw new Error('ARTIFACT_NOT_FOUND');
      if (row.status !== 'active') throw new Error('ARTIFACT_REVOKED');
      const policies = await assertSourceVersions(tx, owner, row.metadata.dependencies);
      const datasets = [];
      for (const datasetId of row.metadata.datasetVersionIds) datasets.push(await readDataset(tx, owner, datasetId));
      const retentionUntil = earliestRetention([row.metadata.retentionUntil, ...policies.map(policy => policy.retentionUntil),
        ...datasets.map(dataset => dataset.metadata.license.retentionUntil)]);
      if (retentionUntil && Date.parse(retentionUntil) <= Date.now()) throw new Error('ARTIFACT_RETENTION_EXPIRED');
      const artifact: ResearchArtifact = { ...row.metadata, retentionUntil,
        effectiveDataClasses: [...new Set([...row.metadata.effectiveDataClasses, ...policies.flatMap(policy => policy.dataClasses),
          ...datasets.flatMap(dataset => dataset.metadata.dataClasses)])].sort(),
        permittedUses: intersectUses([row.metadata.permittedUses, ...policies.map(policy => policy.permittedUses),
          ...datasets.map(dataset => dataset.metadata.license.permittedUses)]) };
      return { artifact, data: await this.storage.read(owner, row.storageRef, row.sha256) };
    });
  }
  async manifest(owner: string): Promise<Array<{ artifactId: string; storageRef: string; sha256: string; sizeBytes: number }>> {
    const rows = await this.db.select().from(researchArtifacts).where(and(eq(researchArtifacts.owner, owner), eq(researchArtifacts.status, 'active')));
    return rows.map(row => ({ artifactId: row.id, storageRef: row.storageRef, sha256: row.sha256, sizeBytes: row.sizeBytes }));
  }
  async discard(owner: string, id: string): Promise<void> {
    const [row] = await this.db.update(researchArtifacts).set({ status: 'deleted' }).where(and(
      eq(researchArtifacts.owner, owner), eq(researchArtifacts.id, id))).returning();
    if (!row) throw new Error('ARTIFACT_NOT_FOUND');
    await this.storage.remove(owner, row.storageRef);
  }
}
