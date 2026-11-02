/**
 * @file server/modules/paper-trading/paper-trading.module.ts
 * @description Paper-trading wiring: engine + controller + the around-the-
 * clock bot scheduler. Imports Quote/Fx (pricing & conversion) and the
 * Notification module (fill/risk push).
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
  imports: [QuoteModule, FxModule, NotificationModule, MultiAgentModule, CouncilModule, LocalAgentsModule],
  controllers: [PaperTradingController, AgentBuilderController],
  providers: [PaperTradingService, AgentBuilderService, BuilderCadenceService, BotScheduler],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
