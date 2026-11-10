/**
 * Root (application) module.
 *
 * Wires together the first-party platform layer (database + auth with the
 * global guard) and every feature module (holdings, watchlist, groups,
 * analysis, transactions, closed positions, journal, snapshots, alpha picks,
 * dashboard, LLM agent, cash accounts, quotes, FX, and the multi-agent
 * pipeline), and registers `GlobalExceptionFilter` as the application-wide
 * exception handler via `APP_FILTER`. `ViewModule` must remain the last
 * import because it provides the SPA fallback routes.
 */
import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { DatabaseModule } from './common/platform/database.provider';
import { AuthModule } from './modules/auth/auth.module';
import { ViewModule } from './modules/view/view.module';
import { HoldingsModule } from './modules/holdings/holdings.module';
import { WatchlistModule } from './modules/watchlist/watchlist.module';
import { GroupsModule } from './modules/groups/groups.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { ClosedModule } from './modules/closed/closed.module';
import { JournalModule } from './modules/journal/journal.module';
import { SnapshotsModule } from './modules/snapshots/snapshots.module';
import { AlphaPicksModule } from './modules/alpha-picks/alpha-picks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AgentModule } from './modules/agent/agent.module';
import { AgentGatewayModule } from './modules/agent-gateway/agent-gateway.module';
import { CashAccountsModule } from './modules/cash-accounts/cash-accounts.module';
import { QuoteModule } from './modules/quote/quote.module';
import { FxModule } from './modules/fx/fx.module';
import { MultiAgentModule } from './modules/multi-agent/multi-agent.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { PaperTradingModule } from './modules/paper-trading/paper-trading.module';
import { ImportModule } from './modules/import/import.module';
import { McpModule } from './modules/mcp/mcp.module';
import { SettingsModule } from './modules/settings/settings.module';
import { HealthModule } from './modules/health/health.module';
import { LlmBudgetModule } from './modules/llm-budget/llm-budget.module';
import { SystemUpdateModule } from './modules/system-update/system-update.module';
import { ResearchDocumentsModule } from './modules/research-documents/research-documents.module';
import { ExperienceModule } from './modules/experience/experience.module';
import { ChannelModule } from './modules/channel/channel.module';
import { DataLibraryModule } from './modules/data-library/data-library.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';

/**
 * Root Nest module. Aggregates feature modules and installs the global
 * exception filter. Has no logic of its own; it exists purely for DI wiring.
 */
@Module({
  imports: [
    // First-party platform layer: Drizzle database + JWT auth guard.
    DatabaseModule,
    AuthModule,
    SettingsModule,
    LlmBudgetModule,
    TelemetryModule,
    HealthModule,
    SystemUpdateModule,
    ResearchDocumentsModule,
    ExperienceModule,
    ChannelModule,
    DataLibraryModule,

    // ====== @route-section: business-modules START ======
    HoldingsModule,
    WatchlistModule,
    GroupsModule,
    AnalysisModule,
    TransactionsModule,
    ClosedModule,
    JournalModule,
    SnapshotsModule,
    AlphaPicksModule,
    DashboardModule,
    AgentModule,
    AgentGatewayModule,
    CashAccountsModule,
    QuoteModule,
    FxModule,
    MultiAgentModule,
    NotificationModule,
    PaperTradingModule,
    ImportModule,
    McpModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
