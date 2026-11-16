/**
 * @file server/modules/notifications/notification.controller.ts
 * @description CRUD + test endpoints for notification channels.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { NotificationService } from './notification.service';
import type { CreateNotificationChannelDto } from '@shared/api.interface';

@Controller('api/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** List the caller's configured channels. */
  @NeedLogin()
  @Get('channels')
  async list(@Req() req: Request) {
    return this.notifications.listChannels(req.userContext.userId);
  }

  /** Add a channel (webhook/bark/serverchan/smtp/telegram). */
  @NeedLogin()
  @Post('channels')
  async create(@Req() req: Request, @Body() dto: CreateNotificationChannelDto) {
    return this.notifications.createChannel(req.userContext.userId, dto);
  }

  /** Enable/disable a channel. */
  @NeedLogin()
  @Put('channels/:id/enabled')
  async setEnabled(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
  ) {
    await this.notifications.setEnabled(req.userContext.userId, id, body.enabled ?? true);
    return { ok: true };
  }

  /** Remove a channel. */
  @NeedLogin()
  @Delete('channels/:id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.notifications.deleteChannel(req.userContext.userId, id);
    return { ok: true };
  }

  /** Send a test message through one channel. */
  @NeedLogin()
  @Post('channels/:id/test')
  async test(@Req() req: Request, @Param('id') id: string) {
    return this.notifications.sendTest(req.userContext.userId, id);
  }
}
