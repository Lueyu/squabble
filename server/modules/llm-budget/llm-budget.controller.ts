import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { LlmBudgetService } from './llm-budget.service';

@NeedLogin()
@Controller('api/llm-budget')
export class LlmBudgetController {
  constructor(private readonly budgets: LlmBudgetService) {}

  @Get()
  get(@Req() req: Request) {
    return this.budgets.getSettings(req.userContext.userId);
  }

  @Put()
  save(@Req() req: Request, @Body() body: unknown) {
    return this.budgets.saveSettings(req.userContext.userId, body);
  }

  @Get('usage')
  usage(@Req() req: Request) {
    return this.budgets.getUsage(req.userContext.userId);
  }
}
