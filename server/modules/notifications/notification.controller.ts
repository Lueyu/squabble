/**
 * Notification controller（通知渠道控制器）。
 *
 * 职责边界：通知渠道的 CRUD + 测试发送端点，路由前缀
 * `/api/notifications`；只做参数转发，渠道发送逻辑在 NotificationService。
 *
 * 上下游：import @nestjs/common、express 的 Request 类型、NeedLogin
 * （common/platform/need-login.decorator，逐端点级鉴权）、
 * NotificationService（本模块）、@shared/api.interface 的 DTO；由
 * notification.module.ts 注册。
 *
 * 关键约定：本控制器里每个端点单独挂 @NeedLogin()（不是类级）；渠道类型
 * webhook/bark/serverchan/smtp/telegram 由 DTO 约束；PUT enabled 缺省
 * 视为 true。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { NotificationService } from './notification.service';
import type { CreateNotificationChannelDto } from '@shared/api.interface';

@Controller('api/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** 列出调用者已配置的渠道。 */
  @NeedLogin()
  @Get('channels')
  async list(@Req() req: Request) {
    return this.notifications.listChannels(req.userContext.userId);
  }

  /** 新增一个渠道（webhook/bark/serverchan/smtp/telegram）。 */
  @NeedLogin()
  @Post('channels')
  async create(@Req() req: Request, @Body() dto: CreateNotificationChannelDto) {
    return this.notifications.createChannel(req.userContext.userId, dto);
  }

  /** 启用/停用一个渠道。 */
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

  /** 删除一个渠道。 */
  @NeedLogin()
  @Delete('channels/:id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.notifications.deleteChannel(req.userContext.userId, id);
    return { ok: true };
  }

  /** 通过指定渠道发送一条测试消息。 */
  @NeedLogin()
  @Post('channels/:id/test')
  async test(@Req() req: Request, @Param('id') id: string) {
    return this.notifications.sendTest(req.userContext.userId, id);
  }
}
