/**
 * llm-budget.module.ts — LLM 预算模块装配。
 *
 * 职责边界：
 *  - 注册 LlmBudgetController，提供并全局导出 LlmBudgetService（@Global：任何模块可直接注入）。
 * 上下游：
 *  - 上游：应用根模块装配。
 *  - 下游：LlmService、CouncilService（经全局注入使用预算服务）。
 */
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
