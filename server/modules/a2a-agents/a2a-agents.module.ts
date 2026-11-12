import { Module } from '@nestjs/common';
import { A2aAgentsController } from './a2a-agents.controller';
import { A2aAgentsService } from './a2a-agents.service';
import { A2aProtocolAdapter } from './a2a-protocol.adapter';
import { LlmBudgetModule } from '../llm-budget/llm-budget.module';

@Module({ imports: [LlmBudgetModule], controllers: [A2aAgentsController], providers: [A2aAgentsService, { provide: A2aProtocolAdapter, useFactory: () => new A2aProtocolAdapter() }], exports: [A2aAgentsService] })
export class A2aAgentsModule {}
