/**
 * cash-accounts.module.ts — 现金账户功能模块。
 *
 * 职责边界：
 *  - 装配多币种现金余额功能的控制器与服务，不承载业务逻辑。
 * 上下游：
 *  - 上游（谁加载本模块）：由 server 根模块按需引入。
 *  - 下游（本模块暴露给谁）：CashAccountsService 被 transactions 模块的记账逻辑复用。
 * 关键约定：
 *  - 通过 exports 导出 CashAccountsService，供其他模块（如 transactions）注入使用。
 */
import { Module } from '@nestjs/common';
import { CashAccountsController } from './cash-accounts.controller';
import { CashAccountsService } from './cash-accounts.service';

/** 现金账户功能的 NestJS 模块定义。 */
@Module({
  controllers: [CashAccountsController],
  providers: [CashAccountsService],
  exports: [CashAccountsService],
})
export class CashAccountsModule {}
