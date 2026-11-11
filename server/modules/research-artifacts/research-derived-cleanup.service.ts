import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchArtifacts, researchDatasetVersions, researchDocumentExtractions, researchDocumentTasks } from '../../database/research-artifacts.schema';
import { PrivateArtifactStorage, RESEARCH_ARTIFACT_STORAGE } from './research-artifacts.storage';

@Injectable()
export class ResearchDerivedCleanupService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(RESEARCH_ARTIFACT_STORAGE) private readonly storage: PrivateArtifactStorage) {}
  /** Called after a source tombstone commits; historical report/trade snapshots are not touched. */
  async purgeSource(owner: string, sourceId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const source = await tx.execute(sql`select id from data_library_sources where id=${sourceId}::uuid and owner=${owner} and deleted_at is not null for share`);
      if (!source.length) throw new Error('SOURCE_TOMBSTONE_REQUIRED');
      await tx.update(researchDatasetVersions).set({ status: 'revoked', rows: [] }).where(and(eq(researchDatasetVersions.owner, owner),
        sql`(${researchDatasetVersions.sourceId}=${sourceId}::uuid or exists(select 1 from jsonb_array_elements(${researchDatasetVersions.metadata}->'dependencies') ref where ref->>'sourceId'=${sourceId}))`));
      await tx.update(researchDocumentExtractions).set({ metadata: {} }).where(and(eq(researchDocumentExtractions.owner, owner), eq(researchDocumentExtractions.sourceId, sourceId)));
      // Remote settlement identity survives source erasure; it cannot authorize a publication.
      await tx.update(researchDocumentTasks).set({ state: 'cancelled', pollToken: null, pollUntil: null }).where(and(
        eq(researchDocumentTasks.owner, owner), eq(researchDocumentTasks.sourceId, sourceId), sql`${researchDocumentTasks.state}<>'completed'`));
      await tx.update(researchArtifacts).set({ status: 'revoked' }).where(and(eq(researchArtifacts.owner, owner),
        sql`exists(select 1 from jsonb_array_elements(${researchArtifacts.metadata}->'dependencies') ref where ref->>'sourceId'=${sourceId})`));
    });
    await this.collectRevoked(owner);
  }
  async collectRevoked(owner?: string): Promise<void> {
    const rows = await this.db.select().from(researchArtifacts).where(and(
      sql`${researchArtifacts.status} in ('revoked','deleted')`, sql`${researchArtifacts.sizeBytes}>0`,
      owner ? eq(researchArtifacts.owner, owner) : undefined)).limit(100);
    for (const row of rows) {
      await this.storage.remove(row.owner, row.storageRef);
      await this.db.update(researchArtifacts).set({ sizeBytes: 0 }).where(eq(researchArtifacts.id, row.id));
    }
  }
  /** Bounded retry covers a crash between tombstone commit and filesystem cleanup. */
  async runDue(): Promise<void> {
    const sources = await this.db.execute(sql`select distinct s.owner,s.id from data_library_sources s
      where s.deleted_at is not null and (exists(select 1 from research_dataset_versions d where d.owner=s.owner and d.status='active'
        and (d.source_id=s.id or exists(select 1 from jsonb_array_elements(d.metadata->'dependencies') ref where ref->>'sourceId'=s.id::text)))
      or exists(select 1 from research_document_extractions e where e.owner=s.owner and e.source_id=s.id and e.metadata<>'{}'::jsonb)
      or exists(select 1 from research_artifacts a where a.owner=s.owner and a.status='active' and exists(
        select 1 from jsonb_array_elements(a.metadata->'dependencies') ref where ref->>'sourceId'=s.id::text))) limit 50`);
    for (const source of sources) await this.purgeSource(String(source.owner), String(source.id));
    await this.db.execute(sql`update research_dataset_versions d set status='revoked',rows='[]'::jsonb
      where d.status='active' and (exists(select 1 from research_source_policies p where p.owner=d.owner
        and (p.revoked_at is not null or p.retention_until<=now()) and (p.source_version_id=d.source_version_id or
        exists(select 1 from jsonb_array_elements(d.metadata->'dependencies') ref where ref->>'sourceVersionId'=p.source_version_id::text)))
        or (d.metadata->'license'->>'retentionUntil')::timestamptz<=now())`);
    await this.db.execute(sql`update research_artifacts a set status='revoked' where a.status='active' and (
      (a.metadata->>'retentionUntil')::timestamptz<=now() or exists(select 1 from research_source_policies p where p.owner=a.owner
        and (p.revoked_at is not null or p.retention_until<=now()) and exists(select 1 from jsonb_array_elements(a.metadata->'dependencies') ref
          where ref->>'sourceVersionId'=p.source_version_id::text)) or exists(select 1 from research_dataset_versions d where d.owner=a.owner
          and d.status<>'active' and (a.metadata->'datasetVersionIds') ? d.id::text))`);
    await this.collectRevoked();
    await this.collectUnindexed();
  }
  /** Reconcile crash leftovers only after grace, with the same owner fence held from write through index commit. */
  async collectUnindexed(): Promise<void> {
    const before = new Date(Date.now() - 24 * 3600_000);
    for (const candidate of await this.storage.reconciliationCandidates()) {
      await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.ownerDirectory},54))`);
        const indexed = await tx.select({ id: researchArtifacts.id }).from(researchArtifacts)
          .where(eq(researchArtifacts.storageRef, candidate.storageRef)).limit(1);
        // All indexed states are retained here; tombstone/retention cleanup owns their deletion.
        if (candidate.temporary || indexed.length === 0) await this.storage.removeUnindexed(candidate, before);
      });
    }
  }
}
