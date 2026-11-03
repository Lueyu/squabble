import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { LocalAgentsService } from './local-agents.service';
import { pairRequest, parseCompanionPoll, researchToolRequest, researchToolCancelRequest } from './local-agents.requests';
import { LocalAgentError } from './local-agents.types';

/** Companion requests use a revocable device credential, never a user's browser session. */
@Controller('api/local-agent-companion')
export class CompanionController {
  constructor(private readonly agents: LocalAgentsService) {}
  @Post('research-tools/cancel') async cancelResearchTool(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    if (this.agents.mode !== 'companion' || !authorization || !/^Bearer [a-f0-9]{64}$/u.test(authorization)) throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    const parsed = researchToolCancelRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('RESEARCH_INVALID_CALL');
    try {
      const task = await this.agents.store.companionTask(authorization.slice(7), parsed.data.taskId);
      return { cancelled: await this.agents.cancelResearchTool(task.owner, task.id, parsed.data.callId) };
    } catch (error) {
      if (error instanceof LocalAgentError) throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
      throw error;
    }
  }
  @Post('research-tools') async researchTools(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    if (this.agents.mode !== 'companion' || !authorization || !/^Bearer [a-f0-9]{64}$/u.test(authorization)) throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    const parsed = researchToolRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('RESEARCH_INVALID_CALL');
    try {
      const task = await this.agents.store.companionTask(authorization.slice(7), parsed.data.taskId);
      return await this.agents.callResearchTool(task.owner, task.id, {
        callId: parsed.data.callId, name: parsed.data.name, arguments: parsed.data.arguments,
      });
    } catch (error) {
      if (error instanceof LocalAgentError) throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
      throw error;
    }
  }
  @Post('pair') async pair(@Body() body: unknown) {
    if (this.agents.mode !== 'companion') throw new BadRequestException('LOCAL_PAIRING_NOT_NEEDED');
    const parsed = pairRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('LOCAL_INVALID_INPUT');
    try { return await this.agents.store.pair(parsed.data.code, parsed.data.name); }
    catch { throw new BadRequestException('LOCAL_PAIRING_EXPIRED'); }
  }
  @Post('poll') async poll(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    if (this.agents.mode !== 'companion' || !authorization || !/^Bearer [a-f0-9]{64}$/u.test(authorization)) throw new UnauthorizedException('LOCAL_COMPANION_UNAUTHORIZED');
    let input;
    try { input = parseCompanionPoll(body); } catch { throw new BadRequestException('LOCAL_INVALID_INPUT'); }
    try { return await this.agents.store.poll(authorization.slice(7), input); }
    catch (error) {
      if (error instanceof LocalAgentError && error.code === 'LOCAL_COMPANION_UNAUTHORIZED') throw new UnauthorizedException(error.code);
      throw error;
    }
  }
}
