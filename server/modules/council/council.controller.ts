/**
 * council.controller.ts — 研究委员会会话的 REST 控制器。
 *
 * 职责边界：
 *  - 暴露会话 CRUD 与运行/暂停路由（/api/council/sessions），全部委托给 CouncilService。
 *  - 不包含业务逻辑；参数校验在 service 层。
 * 上下游：
 *  - 上游：前端页面（client 会话域）。
 *  - 下游：CouncilService。
 * 关键约定：
 *  - 全部路由 @NeedLogin()：以 request.userContext.userId 做属主隔离。
 */
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { CouncilService } from './council.service';
import type { CreateCouncilSession } from '@shared/council.interface';

@Controller('api/council/sessions')
export class CouncilController {
  constructor(private readonly council: CouncilService) {}

  /** GET /api/council/sessions — 列出当前用户的委员会会话（登录）。 */
  @NeedLogin()
  @Get()
  async list(@Req() request: Request) {
    return { items: await this.council.listSessions(request.userContext.userId) };
  }

  /** POST /api/council/sessions — 创建委员会会话（登录）。 */
  @NeedLogin()
  @Post()
  create(@Req() request: Request, @Body() body: CreateCouncilSession) {
    return this.council.createSession(request.userContext.userId, body);
  }

  /** GET /api/council/sessions/:id — 读取单个会话（含消息与报告）（登录）。 */
  @NeedLogin()
  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    return this.council.getSession(request.userContext.userId, id);
  }

  /** POST /api/council/sessions/:id/messages — 追加用户发言（登录）。 */
  @NeedLogin()
  @Post(':id/messages')
  message(@Req() request: Request, @Param('id') id: string, @Body() body: { content: string }) {
    return this.council.addMessage(request.userContext.userId, id, body?.content);
  }

  /** POST /api/council/sessions/:id/run — 启动或恢复讨论（登录，后台异步执行）。 */
  @NeedLogin()
  @Post(':id/run')
  run(@Req() request: Request, @Param('id') id: string) {
    return this.council.runSession(request.userContext.userId, id);
  }

  /** POST /api/council/sessions/:id/pause — 暂停讨论（登录）。 */
  @NeedLogin()
  @Post(':id/pause')
  pause(@Req() request: Request, @Param('id') id: string) {
    return this.council.pauseSession(request.userContext.userId, id);
  }
}
