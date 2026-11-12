import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { AgentRosterService } from './agent-roster.service';
import { parseRoster, rosterError, scopeSchema } from './agent-roster.rules';
import { z } from 'zod';

function requestBody(req: Request, input: unknown): unknown {
  const key = req.get('x-request-key') ?? req.get('idempotency-key');
  if (key && (!input || typeof input !== 'object' || !('requestKey' in input) || input.requestKey !== key))
    rosterError('AGENT_INVALID_INPUT', 'Request key header and body disagree');
  return input;
}

@NeedLogin()
@Controller('api/agent-roster')
export class AgentRosterController {
  constructor(private readonly roster: AgentRosterService) { }

  @Get()
  list(@Req() req: Request, @Query() query: unknown) { return this.roster.list(req.userContext.userId, query); }

  @Get('templates')
  templates() { return this.roster.templates(); }

  @Post()
  create(@Req() req: Request, @Body() input: unknown) { return this.roster.create(req.userContext.userId, requestBody(req, input)); }

  @Post('recommended')
  recommended(@Req() req: Request, @Body() input: unknown) { return this.roster.recommended(req.userContext.userId, requestBody(req, input)); }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) { return this.roster.detail(req.userContext.userId, id); }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.roster.update(req.userContext.userId, id, requestBody(req, input)); }

  @Post(':id/archive')
  archive(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.roster.archive(req.userContext.userId, id, requestBody(req, input)); }

  @Get(':id/versions')
  history(@Req() req: Request, @Param('id') id: string) { return this.roster.history(req.userContext.userId, id); }

  @Get(':id/versions/:versionId')
  version(@Req() req: Request, @Param('id') id: string, @Param('versionId') versionId: string) { return this.roster.version(req.userContext.userId, id, versionId); }

  @Get(':id/memories')
  memories(@Req() req: Request, @Param('id') id: string, @Query() input: unknown) {
    const query = parseRoster(z.object({ scope: z.enum(['personal', 'team', 'conversation']).default('personal'), scopeId: z.string().uuid().optional() }).strict(), input);
    if (query.scope === 'personal' && query.scopeId) rosterError('AGENT_INVALID_INPUT', 'Personal memory does not have a team or conversation ID');
    const scope = parseRoster(scopeSchema, query.scope === 'personal' ? { kind: 'personal' } : query.scope === 'team' ? { kind: 'team', teamId: query.scopeId } : { kind: 'conversation', conversationId: query.scopeId });
    return this.roster.readMemory(req.userContext.userId, id, scope);
  }

  @Post(':id/memories')
  writeMemory(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.roster.writeMemory(req.userContext.userId, id, requestBody(req, input)); }

  @Post(':id/memories/:memoryId/share')
  shareMemory(@Req() req: Request, @Param('id') id: string, @Param('memoryId') memoryId: string, @Body() input: unknown) {
    return this.roster.shareMemory(req.userContext.userId, id, memoryId, requestBody(req, input));
  }
}
