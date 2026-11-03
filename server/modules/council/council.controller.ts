import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { CouncilService } from './council.service';
import type { CreateCouncilSession } from '@shared/council.interface';

@Controller('api/council/sessions')
export class CouncilController {
  constructor(private readonly council: CouncilService) {}

  @NeedLogin()
  @Get()
  async list(@Req() request: Request) {
    return { items: await this.council.listSessions(request.userContext.userId) };
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
  message(@Req() request: Request, @Param('id') id: string, @Body() body: { content: string }) {
    return this.council.addMessage(request.userContext.userId, id, body?.content);
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
