/**
 * local-agents.controller.ts — 本地智能体设置域的 REST 控制器。
 *
 * 职责边界：
 *  - 暴露智能体列表/状态/连接/断开/登录/配对与设备撤销路由（/api/settings/local-agents）。
 *  - 错误统一转 BadRequestException（错误码透传）。
 * 上下游：
 *  - 上游：client 设置域页面。
 *  - 下游：LocalAgentsService、LocalAgentStore。
 * 关键约定：
 *  - 类级 @NeedLogin()：全部路由按 request.userContext.userId 做属主隔离。
 */
import { BadRequestException, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentError } from './local-agents.types';

@NeedLogin()
@Controller('api/settings/local-agents')
export class LocalAgentsController {
  constructor(private readonly agents: LocalAgentsService) {}
  /** GET /api/settings/local-agents — 当前已连接的智能体列表（登录）。 */
  @Get() async list(@Req() request: Request) {
    return { items: await this.agents.list(request.userContext.userId) };
  }
  /** GET /api/settings/local-agents/status — 全部智能体的连接/在线/占用状态（登录）。 */
  @Get('status') async status(@Req() request: Request) {
    return this.agents.status(request.userContext.userId);
  }
  /** POST /api/settings/local-agents/pairing — 生成 companion 配对码（登录）。 */
  @Post('pairing') async pairing(@Req() request: Request) {
    return this.action(() => this.agents.pairing(request.userContext.userId));
  }
  /** DELETE /api/settings/local-agents/companion — 撤销已配对的 companion 设备（登录）。 */
  @Delete('companion') async revoke(@Req() request: Request) {
    return this.action(() => this.agents.store.revoke(request.userContext.userId));
  }
  /** POST /api/settings/local-agents/:id/connect — 连接指定智能体（登录）。 */
  @Post(':id/connect') async connect(@Req() request: Request, @Param('id') id: string) {
    return this.action(() => this.agents.connect(request.userContext.userId, id));
  }
  /** POST /api/settings/local-agents/:id/disconnect — 断开指定智能体并中止其任务（登录）。 */
  @Post(':id/disconnect') async disconnect(@Req() request: Request, @Param('id') id: string) {
    return this.action(() => this.agents.disconnect(request.userContext.userId, id));
  }
  /** POST /api/settings/local-agents/:id/login — 打开原生登录或下发 companion 登录任务（登录）。 */
  @Post(':id/login') async login(@Req() request: Request, @Param('id') id: string) {
    return this.action(() => this.agents.login(request.userContext.userId, id));
  }
  /** 统一错误包装：LocalAgentError 的 code 透传为 BadRequest，其余归为 LOCAL_UNAVAILABLE；无返回值时回 { ok: true }。 */
  private async action<T>(run: () => Promise<T>): Promise<T | { ok: true }> {
    try {
      return (await run()) ?? { ok: true };
    } catch (error) {
      throw new BadRequestException(
        error instanceof LocalAgentError ? error.code : 'LOCAL_UNAVAILABLE',
      );
    }
  }
}
