import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../../common/platform';
import { agentRuntimeRuns } from '../../../database/agent-tooling.schema';
import type { AgentSourceVersionRef } from '../../../../shared/agent-tooling.interface';
import { ResearchArtifactsModule } from '../../research-artifacts/research-artifacts.module';
import { ResearchArtifactsService } from '../../research-artifacts/research-artifacts.service';
import { assertSourceVersions } from '../../research-artifacts/research-artifacts.rules';
import { BrowserResearchSession, type BrowserResearchAuthority, type BrowserResearchBinding } from './browser-research-session';
import { BrowserResearchController } from './browser-research.controller';

/** Server-owned authority is rechecked before dispatch and before publishing any page/artifact result. */
export class DatabaseBrowserResearchAuthority implements BrowserResearchAuthority {
  constructor(private readonly db: PostgresJsDatabase) {}
  async assert(binding: BrowserResearchBinding, dependencies: AgentSourceVersionRef[]): Promise<void> {
    await this.db.transaction(async tx => {
      const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, binding.owner),
        eq(agentRuntimeRuns.id, binding.runId))).for('share');
      if (!run || run.frozenInputHash !== binding.runRevision || run.leaseToken !== binding.leaseToken
        || !run.leaseUntil || run.leaseUntil.getTime() <= Date.now() || run.cancelRequested
        || !['running', 'result_received'].includes(run.state)) throw new Error('BROWSER_RUN_UNAVAILABLE');
      await assertSourceVersions(tx, binding.owner, dependencies);
    });
  }
}

@Injectable()
export class BrowserResearchService extends BrowserResearchSession implements OnApplicationShutdown {
  constructor(@Inject(DRIZZLE_DATABASE) db: PostgresJsDatabase, artifacts: ResearchArtifactsService) {
    super({ authority: new DatabaseBrowserResearchAuthority(db), artifacts });
  }
  async onApplicationShutdown(): Promise<void> { await this.shutdown(); }
}

@Module({ imports: [ResearchArtifactsModule], controllers: [BrowserResearchController], providers: [BrowserResearchService],
  exports: [BrowserResearchService] })
export class BrowserResearchModule {}
