/**
 * companion.controller.ts — 桌面 companion 端点的 REST 控制器。
 *
 * 职责边界：
 *  - 配对（pair）、心跳轮询（poll）、研究工具调用与取消四个路由（/api/local-agent-companion）。
 *  - 鉴权走设备凭据（Bearer + 64 位十六进制 token），与浏览器会话完全隔离。
 * 上下游：
 *  - 上游：桌面 companion 进程。
 *  - 下游：LocalAgentsService、LocalAgentStore、local-agents.requests（载荷校验）。
 * 关键约定：
 *  - 非 companion 模式下一律拒绝；LocalAgentError 一律映射为 401（不向设备泄露服务端细节）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { LocalAgentsService } from './local-agents.service';
import {
  pairRequest,
  parseCompanionPoll,
  researchToolRequest,
  researchToolCancelRequest,
} from './local-agents.requests';
import { LocalAgentError } from './local-agents.types';

/** Companion 请求使用可撤销的设备凭据，绝不使用用户的浏览器会话。 */
@Controller('api/local-agent-companion')
export class CompanionController {
  constructor(private readonly agents: LocalAgentsService) {}
  /** POST /api/local-agent-companion/research-tools/cancel — 取消一个在途研究工具调用（设备凭据鉴权）。 */
  @Post('research-tools/cancel') async cancelResearchTool(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (
      this.agents.mode !== 'companion' ||
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/u.test(authorization)
    )
      throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    const parsed = researchToolCancelRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('RESEARCH_INVALID_CALL');
    try {
      const task = await this.agents.store.companionTask(
        authorization.slice(7),
        parsed.data.taskId,
      );
      return {
        cancelled: await this.agents.cancelResearchTool(task.owner, task.id, parsed.data.callId),
      };
    } catch (error) {
      if (error instanceof LocalAgentError)
        throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
      throw error;
    }
  }
  /** POST /api/local-agent-companion/research-tools — 执行一次研究工具调用（设备凭据鉴权，结果落任务日志）。 */
  @Post('research-tools') async researchTools(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (
      this.agents.mode !== 'companion' ||
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/u.test(authorization)
    )
      throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    const parsed = researchToolRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('RESEARCH_INVALID_CALL');
    try {
      const task = await this.agents.store.companionTask(
        authorization.slice(7),
        parsed.data.taskId,
      );
      return await this.agents.callResearchTool(task.owner, task.id, {
        callId: parsed.data.callId,
        name: parsed.data.name,
        arguments: parsed.data.arguments,
      });
    } catch (error) {
      if (error instanceof LocalAgentError)
        throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
      throw error;
    }
  }
  /** POST /api/local-agent-companion/pair — 消费配对码并返回一次性设备 token（无需登录）。 */
  @Post('pair') async pair(@Body() body: unknown) {
    if (this.agents.mode !== 'companion') throw new BadRequestException('LOCAL_PAIRING_NOT_NEEDED');
    const parsed = pairRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('LOCAL_INVALID_INPUT');
    try {
      return await this.agents.store.pair(parsed.data.code, parsed.data.name);
    } catch {
      throw new BadRequestException('LOCAL_PAIRING_EXPIRED');
    }
  }
  /** POST /api/local-agent-companion/poll — 心跳轮询：上报智能体状态与任务更新，领取命令与取消列表（设备凭据鉴权）。 */
  @Post('poll') async poll(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (
      this.agents.mode !== 'companion' ||
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/u.test(authorization)
    )
      throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    let input;
    try {
      input = parseCompanionPoll(body);
    } catch {
      throw new BadRequestException('LOCAL_INVALID_INPUT');
    }
    try {
      return await this.agents.store.poll(authorization.slice(7), input);
    } catch (error) {
      if (error instanceof LocalAgentError && error.code === 'LOCAL_COMPANION_UNAUTHORIZED')
        throw new UnauthorizedException(error.code);
      throw error;
    }
  }
}
