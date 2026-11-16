/**
 * paper-trading.module.ts — 模拟交易功能模块。
 *
 * 职责边界：
 *  - 装配模拟交易引擎、控制器与全天候 bot 调度器，不承载业务逻辑。
 * 上下游：
 *  - 上游（谁加载本模块）：由 server 根模块按需引入。
 *  - 下游（本模块依赖/暴露给谁）：imports Quote/Fx（行情与汇率换算）、
 *    Notification（成交/风险推送）、MultiAgent、Council、LocalAgents；
 *    PaperTradingService 通过 exports 导出供其他模块复用。
 * 关键约定：
 *  - BotScheduler 作为独立 provider 常驻，随模块初始化/销毁启停定时器。
 */
import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { NotificationModule } from '../notifications/notification.module';
import { QuoteModule } from '../quote/quote.module';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilModule } from '../council/council.module';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { BuilderCadenceService } from './builder-cadence.service';
import { AgentBuilderController } from './agent-builder.controller';
import { AgentBuilderService } from './agent-builder.service';
import { BotScheduler } from './bot.scheduler';
import { PaperTradingController } from './paper-trading.controller';
import { PaperTradingService } from './paper-trading.service';

@Module({
  imports: [
    QuoteModule,
    FxModule,
    NotificationModule,
    MultiAgentModule,
    CouncilModule,
    LocalAgentsModule,
  ],
  controllers: [PaperTradingController, AgentBuilderController],
  providers: [PaperTradingService, AgentBuilderService, BuilderCadenceService, BotScheduler],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
