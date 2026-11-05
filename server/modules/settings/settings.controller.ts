import { Body, Controller, Delete, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import type {
  IntegrationSettings,
  IntegrationTestResult,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';
import { LlmService } from '../multi-agent/llm.service';
import { SettingsService } from './settings.service';
import { BudgetExceededException } from '../llm-budget/llm-budget.rules';
import { safeAnalysisError } from '../multi-agent/analysis-report';
import type { ModelRoute } from '../../../shared/model-route.interface';

@NeedLogin()
@Controller('api/settings/integrations')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly llm: LlmService,
  ) {}

  @Get()
  get(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.getSettings(req.userContext.userId);
  }

  @Put('llm')
  saveLlm(
    @Req() req: Request,
    @Body() body: UpdateLlmIntegrationRequest,
  ): Promise<IntegrationSettings> {
    return this.settings.saveLlm(req.userContext.userId, body);
  }

  @Delete('llm')
  clearLlm(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.clearLlm(req.userContext.userId);
  }

  @Put('llm-route')
  saveLlmRoute(@Req() req: Request, @Body() body: ModelRoute): Promise<IntegrationSettings> {
    return this.settings.saveLlmRoute(req.userContext.userId, body);
  }

  @Post('llm/test')
  async testLlm(@Req() req: Request, @Body() body?: { language?: 'zh-CN' | 'en' }): Promise<IntegrationTestResult> {
    const settings = await this.settings.getSettings(req.userContext.userId);
    if (settings.llm.engine === 'basic') {
      return {
        ok: true,
        code: 'basic_ready',
        message: 'Basic analysis is ready. It uses data and rules, without a language model or model API charges.',
      };
    }
    try {
      const response = await this.llm.chatFast(
        [{ role: 'user', content: 'Reply with OK only.' }],
        req.userContext.userId,
        { purpose: 'connection-test', maxOutputTokens: 16 },
      );
      return response.content.trim()
        ? { ok: true, message: 'The model returned a response.' }
        : { ok: false, message: 'The model returned an empty response.' };
    } catch (error) {
      if (error instanceof BudgetExceededException) throw error;
      return {
        ok: false,
        message: safeAnalysisError(error, body?.language === 'zh-CN' ? 'zh-CN' : 'en'),
      };
    }
  }

  @Put('financial')
  saveFinancial(
    @Req() req: Request,
    @Body() body: UpdateFinancialIntegrationRequest,
  ): Promise<IntegrationSettings> {
    return this.settings.saveFinancial(req.userContext.userId, body);
  }

  @Delete('financial')
  clearFinancial(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.clearFinancial(req.userContext.userId);
  }

  @Post('financial/test')
  testFinancial(@Req() req: Request): Promise<IntegrationTestResult> {
    return this.settings.testFinancial(req.userContext.userId);
  }
}
