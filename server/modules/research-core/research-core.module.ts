import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { QuoteModule } from '../quote/quote.module';
import { EvidenceService } from './evidence.service';
import { FinnhubEvidenceService } from './finnhub-evidence.service';
import { LlmService } from './llm.service';
import { PortfolioContextService } from './portfolio-context.service';
import { ResearchToolsBudgetService } from './research-tools-budget.service';
import { ResearchWebService } from './research-web.service';
import { SecEvidenceService } from './sec-evidence.service';

/**
 * Shared research adapters, independent of any report or conversation lifecycle.
 * Settings, the database and model budgets retain their existing global providers.
 * LlmService resolves optional native execution lazily: importing LocalAgentsModule
 * here would create a cycle through LocalAgents -> ResearchTools -> ResearchCore.
 */
@Module({
  imports: [QuoteModule, FxModule],
  providers: [
    LlmService,
    EvidenceService,
    FinnhubEvidenceService,
    SecEvidenceService,
    ResearchWebService,
    ResearchToolsBudgetService,
    PortfolioContextService,
  ],
  exports: [
    LlmService,
    EvidenceService,
    PortfolioContextService,
    ResearchWebService,
  ],
})
export class ResearchCoreModule {}
