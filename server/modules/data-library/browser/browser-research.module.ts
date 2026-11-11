import { Inject, Injectable, Module, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../../common/platform';
import { agentRuntimeRuns } from '../../../database/agent-tooling.schema';
import type { AgentSourceVersionRef } from '../../../../shared/agent-tooling.interface';
import { ResearchArtifactsModule } from '../../research-artifacts/research-artifacts.module';
import { ResearchArtifactsService } from '../../research-artifacts/research-artifacts.service';
import { assertSourceVersions } from '../../research-artifacts/research-artifacts.rules';
import { BrowserResearchSession, type BrowserResearchAuthority, type BrowserResearchBinding } from './browser-research-session';
import { BrowserResearchController } from './browser-research.controller';
import { ToolCapabilityGrantsService } from '../../tool-capabilities/tool-capability-grants.service';
import { ToolCapabilitiesModule } from '../../tool-capabilities/tool-capabilities.module';

/** Server-owned authority is rechecked before dispatch and before publishing any page/artifact result. */
export class DatabaseBrowserResearchAuthority implements BrowserResearchAuthority {
  constructor(private readonly db: PostgresJsDatabase, private readonly capabilities?: ToolCapabilityGrantsService) {}
  async assert(binding: BrowserResearchBinding, dependencies: AgentSourceVersionRef[]): Promise<void> {
    await this.db.transaction(async tx => {
      const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, binding.owner),
        eq(agentRuntimeRuns.id, binding.runId))).for('update');
      if (!run || run.frozenInputHash !== binding.runRevision || run.leaseToken !== binding.leaseToken
        || !run.leaseUntil || run.leaseUntil.getTime() <= Date.now() || run.cancelRequested
        || !['running', 'result_received'].includes(run.state)) throw new Error('BROWSER_RUN_UNAVAILABLE');
      if (process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED === 'true') {
        if (!this.capabilities) throw new Error('TOOL_CAPABILITY_DISABLED');
        const captured = run.policy.capabilityGrants as Record<string, number> | undefined;
        const revision = captured?.browser;
        if (revision !== undefined) {
          await this.capabilities.requireCurrent(binding.owner, 'browser', revision, ['public'], tx);
        } else {
          const grant = await this.capabilities.require(binding.owner, 'browser', ['public'], tx);
          // First access freezes the grant into the durable run. Re-enable cannot revive this run.
          await tx.update(agentRuntimeRuns).set({ policy: { ...run.policy,
            capabilityGrants: { ...captured, browser: grant.revision } } }).where(eq(agentRuntimeRuns.id, run.id));
        }
      }
      await assertSourceVersions(tx, binding.owner, dependencies);
    });
  }
  async beforeNavigate(binding: BrowserResearchBinding, url: string, dependencies: AgentSourceVersionRef[]): Promise<void> {
    if (process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED !== 'true') return;
    await this.db.transaction(async tx => {
      const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, binding.owner), eq(agentRuntimeRuns.id, binding.runId))).for('share');
      if (!run || run.frozenInputHash !== binding.runRevision || run.leaseToken !== binding.leaseToken
        || !run.leaseUntil || run.leaseUntil.getTime() <= Date.now() || run.cancelRequested
        || !['running', 'result_received'].includes(run.state)) throw new Error('BROWSER_RUN_UNAVAILABLE');
      const policies = await assertSourceVersions(tx, binding.owner, dependencies);
      const grants = run.policy.capabilityGrants as Record<string, number> | undefined;
      if (!this.capabilities || !Number.isSafeInteger(grants?.browser)) throw new Error('TOOL_CAPABILITY_DISABLED');
      await this.capabilities.requireCurrent(binding.owner, 'browser', grants.browser, ['public'], tx);
      const frozenClasses = Array.isArray(run.policy.dataClasses) ? run.policy.dataClasses : null;
      const sensitive = !frozenClasses || [...frozenClasses, ...(binding.dataClasses ?? []), ...policies.flatMap(policy => policy.dataClasses)]
        .some(kind => kind !== 'public');
      if (!sensitive) return;
      const approved = Array.isArray(run.policy.publicBrowserStartUrls) ? run.policy.publicBrowserStartUrls : [];
      // Compare exact canonical provenance. Appending a private query/path never inherits public authorization.
      let target: string;
      try { target = new URL(url).href; } catch { throw new Error('BROWSER_PUBLIC_SOURCE_REQUIRED'); }
      if (!approved.includes(target)) throw new Error('BROWSER_PUBLIC_SOURCE_REQUIRED');
    });
  }
}

@Injectable()
export class BrowserResearchService extends BrowserResearchSession implements OnApplicationShutdown {
  constructor(@Inject(DRIZZLE_DATABASE) db: PostgresJsDatabase, artifacts: ResearchArtifactsService,
    @Optional() capabilities?: ToolCapabilityGrantsService) {
    super({ authority: new DatabaseBrowserResearchAuthority(db, capabilities), artifacts });
  }
  async onApplicationShutdown(): Promise<void> { await this.shutdown(); }
}

@Module({ imports: [ResearchArtifactsModule, ToolCapabilitiesModule], controllers: [BrowserResearchController], providers: [BrowserResearchService],
  exports: [BrowserResearchService] })
export class BrowserResearchModule {}
