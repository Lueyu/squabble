/**
 * llm-budget.controller.ts — LLM 预算设置的 REST 控制器。
 *
 * 职责边界：
 *  - 暴露 /api/llm-budget 的读取/保存与用量统计路由，全部委托给 LlmBudgetService。
 * 上下游：
 *  - 上游：前端预算设置页。
 *  - 下游：LlmBudgetService。
 * 关键约定：
 *  - 类级 @NeedLogin()：全部路由按 request.userContext.userId 做属主隔离。
 */
import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { LlmBudgetService } from './llm-budget.service';

@NeedLogin()
@Controller('api/llm-budget')
export class LlmBudgetController {
  constructor(private readonly budgets: LlmBudgetService) {}

  /** GET /api/llm-budget — 读取当前用户的预算设置（登录）。 */
  @Get()
  get(@Req() req: Request) {
    return this.budgets.getSettings(req.userContext.userId);
  }

  /** PUT /api/llm-budget — 整体替换保存预算设置（登录）。 */
  @Put()
  save(@Req() req: Request, @Body() body: unknown) {
    return this.budgets.saveSettings(req.userContext.userId, body);
  }

  /** GET /api/llm-budget/usage — 用量统计（含最近 30 条记录与估算成本）（登录）。 */
  @Get('usage')
  usage(@Req() req: Request) {
    return this.budgets.getUsage(req.userContext.userId);
  }
}
