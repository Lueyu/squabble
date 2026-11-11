import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentRuntimeRuns } from '../../database/agent-tooling.schema';
import { councilSessions } from '../../database/council.schema';
import { researchArtifacts, researchDatasetVersions } from '../../database/research-artifacts.schema';
import { toolConnections } from '../../database/tool-connections.schema';
import type { AgentSourceVersionRef } from '../../../shared/agent-tooling.interface';
import type { ToolActionPreviewInput } from './tool-actions.rules';
import type { ToolActionValidationPort } from './tool-actions.service';
import { assertSourceVersions, intersectUses } from '../research-artifacts/research-artifacts.rules';

type Tx = Parameters<ToolActionValidationPort['validate']>[0];

/** Database-only visibility checks also work inside a read-only repeatable snapshot. */
@Injectable()
export class ToolActionSourceValidation implements ToolActionValidationPort {
  private async source(tx: Tx, owner: string, ref: AgentSourceVersionRef): Promise<void> {
    const rows = await tx.execute(sql`select v.id from data_library_versions v
      join data_library_sources s on s.id=v.source_id and s.owner=v.owner
      left join research_source_policies p on p.owner=v.owner and p.source_version_id=v.id
      where v.owner=${owner} and s.id=${ref.sourceId}::uuid and v.id=${ref.sourceVersionId}::uuid
      and v.content_hash=${ref.contentHash} and s.enabled=true and s.deleted_at is null
      and p.revoked_at is null and (p.retention_until is null or p.retention_until>now())`);
    if (!rows.length) throw new Error('TOOL_ACTION_SOURCE_UNAVAILABLE');
  }
  async assertVisible(tx: Tx, owner: string, preview: ToolActionPreviewInput): Promise<void> {
    const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, owner), eq(agentRuntimeRuns.id, preview.runId)));
    if (!run || run.identity.sessionId !== preview.scope.sessionId || run.identity.revision !== preview.scope.revision) throw new Error('TOOL_ACTION_SCOPE_CHANGED');
    const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner),
      eq(councilSessions.id, preview.scope.sessionId), isNull(councilSessions.deletedAt)));
    if (!session || session.revision !== preview.scope.revision || session.checkpoint?.cycleId !== run.identity.cycleId) throw new Error('TOOL_ACTION_SCOPE_CHANGED');
    for (const ref of preview.scope.sourceVersions) await this.source(tx, owner, ref);
    for (const attachment of preview.attachments) {
      const [artifact] = await tx.select().from(researchArtifacts).where(and(eq(researchArtifacts.owner, owner), eq(researchArtifacts.id, attachment.artifactId)));
      if (!artifact || artifact.status !== 'active' || artifact.sha256 !== attachment.sha256
        || artifact.metadata.retentionUntil && Date.parse(artifact.metadata.retentionUntil) <= Date.now()) throw new Error('TOOL_ACTION_ATTACHMENT_UNAVAILABLE');
      for (const ref of artifact.metadata.dependencies) await this.source(tx, owner, ref);
      for (const id of artifact.metadata.datasetVersionIds) {
        const [dataset] = await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, id)));
        if (!dataset || dataset.status !== 'active') throw new Error('TOOL_ACTION_ATTACHMENT_UNAVAILABLE');
        for (const ref of [dataset.metadata.sourceVersion, ...dataset.metadata.dependencies]) await this.source(tx, owner, ref);
      }
    }
  }
  async validate(tx: Tx, owner: string, preview: ToolActionPreviewInput): Promise<void> {
    await this.assertVisible(tx, owner, preview);
    const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, owner), eq(agentRuntimeRuns.id, preview.runId)));
    if (run.cancelRequested || !['running', 'waiting_approval', 'result_received'].includes(run.state)) throw new Error('TOOL_ACTION_RUN_CLOSED');
    const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, preview.descriptor.connectionId!)));
    if (!connection || !preview.scope.allowedDataClasses.every(kind => connection.allowedDataClasses.includes(kind))) throw new Error('TOOL_ACTION_EGRESS_NOT_AUTHORIZED');
    const checkPolicies = async (references: AgentSourceVersionRef[], uses: string[] = ['external_write']): Promise<void> => {
      const policies = await assertSourceVersions(tx, owner, references);
      if (policies.some(policy => !policy.dataClasses.every(kind => connection.allowedDataClasses.includes(kind)))) {
        throw new Error('TOOL_ACTION_EGRESS_NOT_AUTHORIZED');
      }
      if (!intersectUses([uses, ...policies.map(policy => policy.permittedUses)]).includes('external_write')) {
        throw new Error('TOOL_ACTION_SOURCE_EXPORT_NOT_AUTHORIZED');
      }
    };
    await checkPolicies(preview.scope.sourceVersions);
    if (preview.costLimit.maxAmount !== null) throw new Error('TOOL_ACTION_MONETARY_CEILING_UNSUPPORTED');
    if (preview.resourceVersion !== null) throw new Error('TOOL_ACTION_CONDITIONAL_RESOURCE_UNSUPPORTED');
    for (const attachment of preview.attachments) {
      const [artifact] = await tx.select().from(researchArtifacts).where(and(eq(researchArtifacts.owner, owner), eq(researchArtifacts.id, attachment.artifactId)));
      if (!artifact.metadata.effectiveDataClasses.every(kind => connection.allowedDataClasses.includes(kind))
        || !artifact.metadata.permittedUses.includes('external_write')) throw new Error('TOOL_ACTION_ARTIFACT_EXPORT_NOT_AUTHORIZED');
      await checkPolicies(artifact.metadata.dependencies, artifact.metadata.permittedUses);
      for (const id of artifact.metadata.datasetVersionIds) {
        const [dataset] = await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, id)));
        if (!dataset || dataset.status !== 'active'
          || !dataset.metadata.dataClasses.every(kind => connection.allowedDataClasses.includes(kind))) throw new Error('TOOL_ACTION_ARTIFACT_EXPORT_NOT_AUTHORIZED');
        await checkPolicies([dataset.metadata.sourceVersion, ...dataset.metadata.dependencies], dataset.metadata.license.permittedUses);
      }
    }
  }
}
