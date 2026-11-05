/**
 * @file server/modules/paper-trading/paper-trading.module.ts
 * @description Paper-trading wiring: engine + controller + the around-the-
 * clock bot scheduler. Imports Quote/Fx (pricing & conversion) and the
 * Notification module (fill/risk push).
 */
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
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
import { TradingMarketService } from './trading-market.service';
import { StrategyStore } from './strategy.store';
import { StrategyModelService } from './strategy-model.service';
import { StrategyService } from './strategy.service';
import { StrategyNotificationsService } from './strategy-notifications.service';
import { StrategyScheduler } from './strategy.scheduler';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { StrategyMandateService } from './strategy-mandate.service';
import { StrategyMandateController } from './strategy-mandate.controller';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { SimulationExperimentsController } from './simulation-experiments.controller';
import { StrategyMonitorService } from './strategy-monitor.service';
import { StrategyDailyAdjustments } from './strategy-daily-adjustments';

@Module({
  imports: [HttpModule, QuoteModule, FxModule, NotificationModule, MultiAgentModule, CouncilModule, LocalAgentsModule, ResearchDocumentsModule],
  controllers: [PaperTradingController, AgentBuilderController, StrategyMandateController, SimulationExperimentsController],
  providers: [PaperTradingService, AgentBuilderService, BuilderCadenceService, BotScheduler,
    TradingMarketService, StrategyStore, StrategyModelService, StrategyService, StrategyNotificationsService, StrategyScheduler,
    StrategyMandateService, SimulationExperimentsService, StrategyMonitorService, StrategyDailyAdjustments],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
