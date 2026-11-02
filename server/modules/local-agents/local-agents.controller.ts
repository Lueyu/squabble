import { BadRequestException, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentError } from './local-agents.types';

@NeedLogin()
@Controller('api/settings/local-agents')
export class LocalAgentsController {
  constructor(private readonly agents: LocalAgentsService) {}
  @Get() async list(@Req() request: Request) { return { items: await this.agents.list(request.userContext.userId) }; }
  @Get('status') async status(@Req() request: Request) { return this.agents.status(request.userContext.userId); }
  @Post('pairing') async pairing(@Req() request: Request) { return this.action(() => this.agents.pairing(request.userContext.userId)); }
  @Delete('companion') async revoke(@Req() request: Request) { return this.action(() => this.agents.store.revoke(request.userContext.userId)); }
  @Post(':id/connect') async connect(@Req() request: Request, @Param('id') id: string) { return this.action(() => this.agents.connect(request.userContext.userId, id)); }
  @Post(':id/disconnect') async disconnect(@Req() request: Request, @Param('id') id: string) { return this.action(() => this.agents.disconnect(request.userContext.userId, id)); }
  @Post(':id/login') async login(@Req() request: Request, @Param('id') id: string) { return this.action(() => this.agents.login(request.userContext.userId, id)); }
  private async action<T>(run: () => Promise<T>): Promise<T | { ok: true }> {
    try { return (await run()) ?? { ok: true }; }
    catch (error) { throw new BadRequestException(error instanceof LocalAgentError ? error.code : 'LOCAL_UNAVAILABLE'); }
  }
}
