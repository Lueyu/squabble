/**
 * Model connections controller（附加模型连接控制器）。
 *
 * 职责边界：暴露 `/api/settings/model-connections` 的 CRUD 与单连接连通
 * 性测试。只做转发；配置校验/加密/上限在 ModelConnectionsService。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，类级全量
 * 鉴权）、ModelConnectionsService（本模块）、LlmService 与
 * safeAnalysisError、BudgetExceededException（multi-agent/llm-budget）；
 * 由 settings.module.ts 注册。
 *
 * 关键约定：POST :id/test 在做传输/预算测试之前先 resolve 归属与密钥
 * （归属校验失败绝不静默换成其他凭据）；探测请求 maxOutputTokens=16、
 * purpose='connection-test' 计入 LLM 预算（BudgetExceededException 原样
 * 上抛）；zh-CN 请求返回中文成功文案。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { SaveModelConnection } from '@shared/model-connections.interface';
import { NeedLogin } from '../../common/platform';
import { ModelConnectionsService } from './model-connections.service';
import { LlmService } from '../multi-agent/llm.service';
import { safeAnalysisError } from '../multi-agent/analysis-report';
import { BudgetExceededException } from '../llm-budget/llm-budget.rules';

@NeedLogin()
@Controller('api/settings/model-connections')
export class ModelConnectionsController {
  constructor(
    private readonly connections: ModelConnectionsService,
    private readonly llm: LlmService,
  ) {}

  /** 列出当前用户的附加连接（脱敏视图）。 */
  @Get()
  async list(@Req() request: Request) {
    return { items: await this.connections.list(request.userContext.userId) };
  }

  /** 新建连接（无 id 即新增）。 */
  @Post()
  create(@Req() request: Request, @Body() body: SaveModelConnection) {
    return this.connections.save(request.userContext.userId, body);
  }

  /** 更新指定连接。 */
  @Put(':id')
  update(@Req() request: Request, @Param('id') id: string, @Body() body: SaveModelConnection) {
    return this.connections.save(request.userContext.userId, body, id);
  }

  /** 删除指定连接。 */
  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    return this.connections.remove(request.userContext.userId, id);
  }

  /** 单连接连通性测试：先校验归属/密钥，再发极小的探测消息。 */
  @Post(':id/test')
  async test(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body?: { language?: string },
  ) {
    // Fail owner resolution before the transport/budget test, never silently use another credential.
    // （在传输/预算测试之前先做归属解析，绝不静默使用其他凭据。）
    await this.connections.resolve(request.userContext.userId, id);
    try {
      await this.llm.chatFast(
        [{ role: 'user', content: 'Reply with OK only.' }],
        request.userContext.userId,
        { connectionId: id, purpose: 'connection-test', maxOutputTokens: 16 },
      );
      return {
        ok: true,
        message: body?.language === 'zh-CN' ? '模型连接正常。' : 'The model connection is working.',
      };
    } catch (error) {
      // 预算异常原样上抛；其余错误转成安全文案。
      if (error instanceof BudgetExceededException) throw error;
      return {
        ok: false,
        message: safeAnalysisError(error, body?.language === 'zh-CN' ? 'zh-CN' : 'en'),
      };
    }
  }
}
