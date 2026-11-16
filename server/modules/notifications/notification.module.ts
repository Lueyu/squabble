/**
 * Notification module（通知模块）。
 *
 * 职责边界：装配通知特性——imports HttpModule（供渠道 HTTP 发送）、注册
 * NotificationController、提供并 exports NotificationService，以便
 * paper-trading 引擎（及后续特性）能扇出事件。
 *
 * 上下游：import HttpModule（@nestjs/axios）、NotificationController/
 * NotificationService（本目录）；本模块被 app.module.ts 注册，导出的
 * NotificationService 被其他模块 imports 使用。
 *
 * 关键约定：NotificationService 必须保持 exports（依赖方按 import 引用）。
 */
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [HttpModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
