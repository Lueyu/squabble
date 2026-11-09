import { Global, Module } from '@nestjs/common';
import { LlmService } from '../research-core/llm.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { QuoteModule } from '../quote/quote.module';
import { ModelConnectionsService } from './model-connections.service';
import { ModelConnectionsController } from './model-connections.controller';

@Global()
@Module({
  imports: [QuoteModule],
  controllers: [SettingsController, ModelConnectionsController],
  // Keep settings' existing local LLM provider: importing ResearchCore here
  // would couple the global settings provider to adapters that depend on it.
  providers: [SettingsService, LlmService, ModelConnectionsService],
  exports: [SettingsService],
})
export class SettingsModule {}
