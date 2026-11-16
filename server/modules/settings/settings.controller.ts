/**
 * Settings controller（集成设置控制器）。
 *
 * 职责边界：暴露 `/api/settings/integrations` 下的 LLM 与行情数据源两
 * 组集成设置端点（读/存/清除/连通性测试）。只做转发与 LLM 连通性测试
 * 的薄编排；密钥加密、URL 校验等安全规则都在 SettingsService /
 * settings-security.ts 里。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，类级全量
 * 鉴权）、SettingsService（本模块）、LlmService 与 safeAnalysisError、
 * BudgetExceededException（multi-agent/llm-budget 模块）、@shared/
 * api.interface 类型；由 settings.module.ts 注册。
 *
 * 关键约定：POST llm/test 用 maxOutputTokens=16 的最小请求做连通性探测，
 * purpose='connection-test' 会计入 LLM 预算（BudgetExceededException
 * 原样上抛给全局过滤器）；engine='basic' 时测试直接返回 basic_ready，
 * 不调用任何模型。
 */
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

@NeedLogin()
@Controller('api/settings/integrations')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly llm: LlmService,
  ) {}

  /** 读取当前用户的集成设置（密钥永不回传，只回状态位）。 */
  @Get()
  get(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.getSettings(req.userContext.userId);
  }

  /** 保存 LLM 集成（baseUrl/model/apiKey，apiKey 加密落库）。 */
  @Put('llm')
  saveLlm(
    @Req() req: Request,
    @Body() body: UpdateLlmIntegrationRequest,
  ): Promise<IntegrationSettings> {
    return this.settings.saveLlm(req.userContext.userId, body);
  }

  /** 清除 LLM 集成（删除加密密文行）。 */
  @Delete('llm')
  clearLlm(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.clearLlm(req.userContext.userId);
  }

  /** LLM 连通性测试：basic 引擎直接就绪；否则发一条极小的探测消息。 */
  @Post('llm/test')
  async testLlm(
    @Req() req: Request,
    @Body() body?: { language?: 'zh-CN' | 'en' },
  ): Promise<IntegrationTestResult> {
    // basic 引擎不需要语言模型，测试恒成功。
    const settings = await this.settings.getSettings(req.userContext.userId);
    if (settings.llm.engine === 'basic') {
      return {
        ok: true,
        code: 'basic_ready',
        message:
          'Basic analysis is ready. It uses data and rules, without a language model or model API charges.',
      };
    }
    // 真实探测：16 token 上限的最小请求，够判断"模型回话了吗"。
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
      // 预算异常原样上抛（由全局异常过滤器统一格式化）；其余错误经
      // safeAnalysisError 转成安全文案。
      if (error instanceof BudgetExceededException) throw error;
      return {
        ok: false,
        message: safeAnalysisError(error, body?.language === 'zh-CN' ? 'zh-CN' : 'en'),
      };
    }
  }

  /** 保存行情数据源集成（Finnhub 等，apiKey 加密落库）。 */
  @Put('financial')
  saveFinancial(
    @Req() req: Request,
    @Body() body: UpdateFinancialIntegrationRequest,
  ): Promise<IntegrationSettings> {
    return this.settings.saveFinancial(req.userContext.userId, body);
  }

  /** 清除行情数据源集成。 */
  @Delete('financial')
  clearFinancial(@Req() req: Request): Promise<IntegrationSettings> {
    return this.settings.clearFinancial(req.userContext.userId);
  }

  /** 行情数据源连通性测试（真实请求上游一次）。 */
  @Post('financial/test')
  testFinancial(@Req() req: Request): Promise<IntegrationTestResult> {
    return this.settings.testFinancial(req.userContext.userId);
  }
}
