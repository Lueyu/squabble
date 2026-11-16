/**
 * Journal module（交易日志模块）。
 *
 * 职责边界：装配 trading-journal 特性——注册 JournalController 并提供
 * JournalService；不引入其他模块。
 *
 * 上下游：import JournalController/JournalService（本目录）；本模块被
 * app.module.ts 注册。
 *
 * 关键约定：无 imports，service 的 Drizzle 连接由全局平台侧注入。
 */
import { Module } from '@nestjs/common';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

/** Trading-journal 特性的 NestJS 模块定义。 */
@Module({
  controllers: [JournalController],
  providers: [JournalService],
})
export class JournalModule {}
