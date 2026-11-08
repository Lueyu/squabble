import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { modelConnections } from '../../database/model-connections.schema';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LlmService } from '../research-core/llm.service';
import { SettingsService } from '../settings/settings.service';
import type { ModelRoute } from '../../../shared/model-route.interface';

/** Executor identity used for dispatch and request deduplication, without secrets. */
export interface PortfolioResearchRoute {
  route: ModelRoute;
  connectionId?: string;
  label: string;
  busy: boolean;
  fingerprint: unknown;
}

/** Selects an owner's configured executor; selection never dispatches research. */
@Injectable()
export class PortfolioResearchRouteService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly agents: LocalAgentsService,
    private readonly settings: SettingsService,
    private readonly llm: LlmService,
  ) {}

  async resolve(owner: string): Promise<PortfolioResearchRoute | null> {
    const [preferences] = await this.db
      .select()
      .from(experiencePreferences)
      .where(eq(experiencePreferences.owner, owner));
    const allowed = (id: string) =>
      !preferences?.defaultMembers.length ||
      preferences.defaultMembers.includes(id);
    const selected = await this.settings.getDefaultModelRoute(owner);
    const overrides = { ...preferences?.memberSettings };
    if (
      selected.mode === 'local' &&
      selected.agentSettings &&
      !overrides[selected.agentId]
    ) {
      overrides[selected.agentId] = selected.agentSettings;
    }

    // Preserve native-first selection and queueable busy executors. A temporary
    // native-readiness failure may still fall back to an allowed API connection.
    const items = await this.agents.readiness(owner, overrides).catch(() => []);
    const local = items
      .filter(
        (item) =>
          allowed(item.connectionId) &&
          item.connected &&
          item.route &&
          (item.executable || item.state === 'busy'),
      )
      .sort((a, b) => Number(a.busy) - Number(b.busy))[0];
    if (local?.route) {
      return {
        route: local.route,
        label: local.name,
        busy: local.busy,
        fingerprint: { route: local.route, model: local.effectiveModel },
      };
    }

    if (
      allowed('default') &&
      selected.mode === 'api' &&
      (await this.llm.isConfigured(owner, undefined, selected))
    ) {
      const info = await this.llm.getExecutionInfo(owner, selected);
      return {
        route: selected,
        label: info?.modelSlow ?? 'AI',
        busy: false,
        fingerprint: info,
      };
    }

    const connections = await this.db
      .select({ id: modelConnections.id, name: modelConnections.name })
      .from(modelConnections)
      .where(eq(modelConnections.owner, owner))
      .orderBy(modelConnections.createdAt);
    for (const connection of connections) {
      if (!allowed(connection.id)) continue;
      try {
        const config = await this.settings.getLlmConfig(owner, connection.id);
        if (!config) continue;
        const route: ModelRoute = { mode: 'api' };
        return {
          route,
          connectionId: connection.id,
          label: connection.name,
          busy: false,
          fingerprint: {
            route,
            connectionId: connection.id,
            provider: new URL(config.baseUrl).origin,
            model: config.slowModel,
          },
        };
      } catch {
        // A foreign or unavailable named connection never becomes a route.
      }
    }
    return null;
  }
}
