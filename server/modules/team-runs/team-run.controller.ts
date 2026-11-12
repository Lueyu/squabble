import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { TeamRunService } from './team-run.service';
import { teamError } from '../teams/team-contract';
function checkedBody(req: Request, input: unknown): unknown {
  const header = req.get('x-request-key') ?? req.get('idempotency-key');
  if (header && (!input || typeof input !== 'object' || !('requestKey' in input) || input.requestKey !== header)) teamError('TEAM_INVALID_INPUT');
  return input;
}
@Controller('api/teams/:id/run-agreement')
export class TeamRunController {
  constructor(private readonly runs: TeamRunService) {}
  @NeedLogin() @Get() status(@Req() req: Request, @Param('id') id: string) { return this.runs.status(req.userContext.userId, id); }
  @NeedLogin() @Post('preview') @HttpCode(200) preview(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.runs.preview(req.userContext.userId, id, checkedBody(req, body)); }
  @NeedLogin() @Post('confirm') @HttpCode(200) confirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.runs.confirm(req.userContext.userId, id, checkedBody(req, body)); }
  @NeedLogin() @Post('start') @HttpCode(200) start(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.runs.control(req.userContext.userId, id, 'start', checkedBody(req, body)); }
  @NeedLogin() @Post('pause') @HttpCode(200) pause(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.runs.control(req.userContext.userId, id, 'pause', checkedBody(req, body)); }
  @NeedLogin() @Post('resume') @HttpCode(200) resume(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.runs.control(req.userContext.userId, id, 'resume', checkedBody(req, body)); }
}
