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
    // Fail owner resolution before the transport/budget test, never silently use another credential.
    await this.connections.resolve(request.userContext.userId, id);
    try {
      await this.llm.chatFast([{ role: 'user', content: 'Reply with OK only.' }], request.userContext.userId,
        { connectionId: id, purpose: 'connection-test', maxOutputTokens: 16 });
      return { ok: true, message: body?.language === 'zh-CN' ? '模型连接正常。' : 'The model connection is working.' };
    } catch (error) {
      if (error instanceof BudgetExceededException) throw error;
      return { ok: false, message: safeAnalysisError(error, body?.language === 'zh-CN' ? 'zh-CN' : 'en') };
    }
  }
}
