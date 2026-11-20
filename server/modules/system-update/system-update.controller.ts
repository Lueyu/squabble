/**
 * System update controller（系统更新控制器）。
 *
 * 职责边界：暴露 `/api/system/update` 的两个端点——GET 查询更新状态、
 * POST 启动一次 Web 更新。只做转发；owner 校验、并发互斥、备份与
 * updater 触发都在 SystemUpdateService。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，类级全量
 * 鉴权）、SystemUpdateService（本模块）；由 system-update.module.ts
 * 注册。
 *
 * 关键约定：两条路由都要求登录，且 service 内部还会做"仅限安装属主"
 * 二次校验（requireOwner）。
 */
import { Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { SystemUpdateService } from './system-update.service';

@NeedLogin()
@Controller('api/system/update')
export class SystemUpdateController {
  constructor(private readonly updates: SystemUpdateService) {}

  /** 查询当前版本、可用新版本与更新阶段。 */
  @Get()
  status(@Req() request: Request) {
    return this.updates.status(request.userContext.userId);
  }

  /** 启动更新（先备份，再触发 updater 容器替换镜像）。 */
  @Post()
  start(@Req() request: Request) {
    return this.updates.start(request.userContext.userId);
  }
}
