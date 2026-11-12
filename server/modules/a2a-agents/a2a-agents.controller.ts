import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { A2aAgentsService } from './a2a-agents.service';

/** Connection and retained receipts only; workflow code owns dispatch and acceptance. */
@NeedLogin()
@Controller('api/a2a-agents')
export class A2aAgentsController {
  constructor(private readonly agents: A2aAgentsService) {}
  @Get() list(@Req() req: Request) { return this.agents.list(req.userContext.userId); }
  @Post() create(@Req() req: Request, @Body() body: unknown) { return this.agents.create(req.userContext.userId, body); }
  @Get('tasks') tasks(@Req() req: Request, @Query() query: unknown) { return this.agents.listTasks(req.userContext.userId, query); }
  @Get('tasks/:id') task(@Req() req: Request, @Param('id') id: string) { return this.agents.inspectTask(req.userContext.userId, id); }
  @Post('tasks/:id/status') status(@Req() req: Request, @Param('id') id: string) { return this.agents.read(req.userContext.userId, id); }
  @Post('tasks/:id/cancel') cancel(@Req() req: Request, @Param('id') id: string) { return this.agents.cancelTask(req.userContext.userId, id); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.agents.detail(req.userContext.userId, id); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.agents.update(req.userContext.userId, id, body); }
  @Post(':id/disable') disable(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.agents.disable(req.userContext.userId, id, body); }
  @Post(':id/refresh-card') refresh(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.agents.refreshCard(req.userContext.userId, id, body); }
}
