import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { ChannelService } from './channel.service';
import { ChannelMemoryService } from './channel-memory.service';

@NeedLogin()
@Controller('api/channel')
export class ChannelController {
  constructor(private readonly channel: ChannelService, private readonly memory: ChannelMemoryService) {}
  @Get() projection(@Req() req: Request) { return this.channel.projection(req.userContext.userId); }
  @Get('logs') logs(@Req() req: Request) { return this.channel.logs(req.userContext.userId); }
  @Get('pending') pending(@Req() req: Request) { return this.channel.pending(req.userContext.userId); }
  @Get('bubbles/:id') bubble(@Req() req: Request, @Param('id') id: string) { return this.channel.bubble(req.userContext.userId, id); }
  @Post('questions') ask(@Req() req: Request, @Body() body: unknown) { return this.channel.ask(req.userContext.userId, body); }
  @Post('actions') action(@Req() req: Request, @Body() body: unknown) { return this.channel.action(req.userContext.userId, body); }
  @Post('preferences') preferences(@Req() req: Request, @Body() body: unknown) { return this.channel.savePreferences(req.userContext.userId, body); }
  @Get(['memories', 'memory']) memories(@Req() req: Request) { return this.memory.list(req.userContext.userId); }
  @Post(['memories', 'memory']) remember(@Req() req: Request, @Body() body: unknown) { return this.memory.preference(req.userContext.userId, body); }
  @Get('reflections') reflections(@Req() req: Request, @Query('decisionId') decisionId?: string) { return this.memory.reflections(req.userContext.userId, decisionId); }
  @Post('reflections') reflect(@Req() req: Request, @Body() body: unknown) { return this.memory.userReflection(req.userContext.userId, body); }
  @Post('notifications/ack') acknowledge(@Req() req: Request, @Body() body: { ids: string[] }) { return this.channel.acknowledgeNotifications(req.userContext.userId, body?.ids); }
}
