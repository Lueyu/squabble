import { Global, Module } from '@nestjs/common';
import { LlmBudgetController } from './llm-budget.controller';
import { LlmBudgetService } from './llm-budget.service';

@Global()
@Module({
  controllers: [LlmBudgetController],
  providers: [LlmBudgetService],
  exports: [LlmBudgetService],
})
export class LlmBudgetModule {}
