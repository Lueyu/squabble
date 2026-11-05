import { Body, Controller, Get, Param, Post, Req, Query } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { CouncilService } from './council.service';
import type { CreateCouncilSession, CouncilMessageInput, ForkCouncilSession, CouncilRevisionRequest } from '@shared/council.interface';

@Controller('api/council/sessions')
export class CouncilController {
  constructor(private readonly council: CouncilService) {}

  @NeedLogin()
  @Get()
  async list(@Req() request: Request, @Query() filters: { scene?: string; topic?: string }) {
    return { items: await this.council.listSessions(request.userContext.userId, filters) };
  }

  @NeedLogin()
  @Post()
  create(@Req() request: Request, @Body() body: CreateCouncilSession) {
    return this.council.createSession(request.userContext.userId, body);
  }

  @NeedLogin()
  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    return this.council.getSession(request.userContext.userId, id);
  }

  @NeedLogin()
  @Post(':id/messages')
  message(@Req() request: Request, @Param('id') id: string, @Body() body: CouncilMessageInput) {
    return this.council.addMessage(request.userContext.userId, id, body?.content, body);
  }

  @NeedLogin()
  @Post(':id/fork')
  fork(@Req() request: Request, @Param('id') id: string, @Body() body: ForkCouncilSession) {
    return this.council.forkSession(request.userContext.userId, id, body);
  }

  @NeedLogin()
  @Post(':id/reports/:reportId/archive')
  archive(@Req() request: Request, @Param('id') id: string, @Param('reportId') reportId: string) {
    return this.council.archiveReport(request.userContext.userId, id, reportId);
  }

  @NeedLogin()
  @Post(':id/reports/:reportId/revision')
  revision(@Req() request: Request, @Param('id') id: string, @Param('reportId') reportId: string, @Body() body: CouncilRevisionRequest) {
    return this.council.draftReportRevision(request.userContext.userId, id, reportId, body?.parentVersionId, body);
  }

  @NeedLogin()
  @Post(':id/run')
  run(@Req() request: Request, @Param('id') id: string) {
    return this.council.runSession(request.userContext.userId, id);
  }

  @NeedLogin()
  @Post(':id/tasks/:taskId/retry')
  retry(@Req() request: Request, @Param('id') id: string, @Param('taskId') taskId: string) {
    return this.council.retryTask(request.userContext.userId, id, taskId);
  }

  @NeedLogin()
  @Post(':id/pause')
  pause(@Req() request: Request, @Param('id') id: string) {
    return this.council.pauseSession(request.userContext.userId, id);
  }
}
