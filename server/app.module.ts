/**
 * 根（application）模块。
 *
 * 职责边界：纯 DI 装配 —— 把第一方平台层（Drizzle 数据库 + 全局 JWT 鉴权
 * guard）与全部业务模块（holdings、watchlist、groups、analysis、transactions、
 * closed positions、journal、snapshots、alpha picks、dashboard、LLM agent、
 * cash accounts、quotes、FX、multi-agent 管线等）组装进 Nest 容器，并通过
 * APP_FILTER 注册 GlobalExceptionFilter 作为全应用异常过滤器；自身无任何
 * 运行时逻辑。
 *
 * 上下游：import 平台层与全部业务模块；被 server/main.ts 作为根模块传入
 * NestFactory.create。
 *
 * 装配顺序约束（关键，勿调）：
 * - ViewModule 必须最后注册：它是 SPA fallback（兜底）路由模块，Nest 按模块
 *   注册顺序匹配路由，兜底路由必须排在所有业务路由之后（代码中有
 *   @route-order 标记）；
 * - 平台层模块（DatabaseModule/AuthModule/SettingsModule/LlmBudget/Health/
 *   SystemUpdate）先于业务模块装配；
 * - 业务模块区块由 @route-section 注释标记包裹，勿移动或改写标记本身。
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

/**
 * 根 Nest 模块：聚合全部业务模块并安装全局异常过滤器。自身没有逻辑，
 * 纯粹为 DI 装配而存在。
 */
@Module({
  imports: [
    // 第一方平台层：Drizzle 数据库 + JWT 鉴权 guard。
    DatabaseModule,
    AuthModule,
    SettingsModule,
    LlmBudgetModule,
    HealthModule,
    SystemUpdateModule,

    // ====== @route-section: business-modules START ======
    // 业务模块区块（顺序即路由注册顺序，勿调整；下方 END 标记为区块收尾）。
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
    // ViewModule 是兜底（fallback）路由模块，必须最后注册。
    ViewModule,
  ],
  providers: [
    // 通过 APP_FILTER 把 GlobalExceptionFilter 注册为全局异常过滤器：
    // 与 useGlobalFilters 等价的全局生效，但保留 DI，过滤器内部可以注入依赖。
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
