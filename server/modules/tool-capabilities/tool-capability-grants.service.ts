import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { toolCapabilityGrants, toolCapabilityReadiness } from '../../database/tool-capabilities.schema';
import type { AgentDataClass } from '../../../shared/agent-tooling.interface';
import type { ToolCapabilityGrantSnapshot, ToolCapabilityPackId } from '../../../shared/tool-capabilities.interface';
import { capabilityManifest, MAX_READINESS_AGE_MS } from './tool-capabilities.manifest';

/** Small authority port. Feature consumers check it before dispatch and again before publishing. */
@Injectable()
export class ToolCapabilityGrantsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async require(owner: string, packId: ToolCapabilityPackId, dataClasses: AgentDataClass[] = [],
    db: Pick<PostgresJsDatabase, 'select'> = this.db): Promise<ToolCapabilityGrantSnapshot> {
    if (!owner?.trim()) throw new Error('TOOL_CAPABILITY_DISABLED');
    const [grant] = await db.select().from(toolCapabilityGrants).where(and(eq(toolCapabilityGrants.owner, owner), eq(toolCapabilityGrants.packId, packId))).for('share');
    const [readiness] = await db.select().from(toolCapabilityReadiness).where(eq(toolCapabilityReadiness.packId, packId)).for('share');
    if (!grant?.enabled) throw new Error('TOOL_CAPABILITY_DISABLED');
    if (!readiness?.ready || Date.now() - readiness.checkedAt.getTime() > MAX_READINESS_AGE_MS) throw new Error('TOOL_CAPABILITY_UNAVAILABLE');
    if (readiness.facts.configurationHash !== capabilityManifest(packId).configurationHash || grant.manifestHash !== readiness.manifestHash) {
      throw new Error('TOOL_CAPABILITY_REVIEW_REQUIRED');
    }
    if (capabilityManifest(packId).publicNetwork && !grant.publicNetwork) throw new Error('TOOL_CAPABILITY_PUBLIC_NETWORK_REQUIRED');
    if (dataClasses.some(kind => !grant.dataClasses.includes(kind))) throw new Error('TOOL_CAPABILITY_DATA_NOT_AUTHORIZED');
    return { revision: grant.revision, dataClasses: [...grant.dataClasses] };
  }
  async requireCurrent(owner: string, packId: ToolCapabilityPackId, revision: number, dataClasses: AgentDataClass[] = [],
    db: Pick<PostgresJsDatabase, 'select'> = this.db): Promise<void> {
    const current = await this.require(owner, packId, dataClasses, db);
    if (current.revision !== revision) throw new Error('TOOL_CAPABILITY_REVISION_CHANGED');
  }
}
