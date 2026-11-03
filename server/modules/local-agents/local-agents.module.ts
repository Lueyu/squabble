import { Module } from '@nestjs/common';
import { CompanionController } from './companion.controller';
import { LocalAgentsController } from './local-agents.controller';
import { LocalAgentsService } from './local-agents.service';
import { ResearchToolsModule } from '../research-tools/research-tools.module';

@Module({ imports: [ResearchToolsModule], controllers: [LocalAgentsController, CompanionController], providers: [LocalAgentsService], exports: [LocalAgentsService] })
export class LocalAgentsModule {}
