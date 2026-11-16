/**
 * System update module（系统更新模块）。
 *
 * 职责边界：装配 Web 更新面——SystemUpdateController + SystemUpdateService。
 * 不注册全局逻辑；更新能力是否真正启用由 service 内部按
 * SQUABBLE_UPDATE_MODE 判定。
 */
import { Module } from '@nestjs/common';
import { SystemUpdateController } from './system-update.controller';
import { SystemUpdateService } from './system-update.service';

@Module({ controllers: [SystemUpdateController], providers: [SystemUpdateService] })
export class SystemUpdateModule {}
