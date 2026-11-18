import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { SaveModelConnection } from '@shared/model-connections.interface';
import { NeedLogin } from '../../common/platform';
import { ModelConnectionsService } from './model-connections.service';
import { LlmService } from '../research-core/llm.service';
import { safeAnalysisError } from '../research-core/research-errors';
import { BudgetExceededException } from '../llm-budget/llm-budget.rules';

@NeedLogin()
@Controller('api/settings/model-connections')
export class ModelConnectionsController {
  constructor(private readonly connections: ModelConnectionsService, private readonly llm: LlmService) {}

  @Get()
  async list(@Req() request: Request) {
    return { items: await this.connections.list(request.userContext.userId) };
  }

  @Post()
  create(@Req() request: Request, @Body() body: SaveModelConnection) {
    return this.connections.save(request.userContext.userId, body);
  }

  @Put(':id')
  update(@Req() request: Request, @Param('id') id: string, @Body() body: SaveModelConnection) {
    return this.connections.save(request.userContext.userId, body, id);
  }

  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    return this.connections.remove(request.userContext.userId, id);
  }

  @Post(':id/test')
  async test(@Req() request: Request, @Param('id') id: string, @Body() body?: { language?: string }) {
    const owner = request.userContext.userId;
    const zh = body?.language === 'zh-CN';
    const attemptId = await this.connections.beginTest(owner, id);
    let failure: string | undefined;
    try {
      await this.llm.chatFast([{ role: 'user', content: 'Reply with OK only.' }], owner, {
        connectionId: id,
        purpose: 'connection-test',
        maxOutputTokens: 16,
        retryPolicy: 'none',
        shouldContinue: () => this.connections.isTestCurrent(owner, id, attemptId),
      });
    } catch (error) {
      failure = safeAnalysisError(error, zh ? 'zh-CN' : 'en');
      if (error instanceof BudgetExceededException) {
        await this.connections.finishTest(owner, id, attemptId, false);
        throw error;
      }
    }
    const current = await this.connections.finishTest(owner, id, attemptId, failure === undefined);
    if (!current) return {
      ok: false,
      message: zh ? '连接配置或测试已变更，请刷新查看当前状态。' : 'The connection or test changed. Refresh to see its current status.',
    };
    return failure
      ? { ok: false, message: failure }
      : { ok: true, message: zh ? '模型连接正常。' : 'The model connection is working.' };
  }
}
