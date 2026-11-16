/**
 * transactions.module.ts — 交易记账功能模块。
 *
 * 职责边界：
 *  - 装配交易记账功能的控制器与服务，并引入派生状态模块，不承载业务逻辑。
 * 上下游：
 *  - 上游（谁加载本模块）：由 server 根模块按需引入。
 *  - 下游（本模块依赖/暴露给谁）：imports HoldingsModule、ClosedModule、QuoteModule；
 *    TransactionsService 通过 exports 导出，供其他模块复用其对账逻辑。
 * 关键约定：
 *  - Transactions 是唯一事实来源，holdings/closed/cash 均为服务端派生状态。
 */
import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { HoldingsModule } from '../holdings/holdings.module';
import { ClosedModule } from '../closed/closed.module';
import { QuoteModule } from '../quote/quote.module';

/** 交易/记账功能的 NestJS 模块定义。 */
@Module({
  imports: [HoldingsModule, ClosedModule, QuoteModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
