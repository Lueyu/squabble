/**
 * Cash accounts module.
 *
 * Wires the multi-currency cash-balance feature: exposes `CashAccountsController`
 * and provides/exports `CashAccountsService` (reused by transactions bookkeeping).
 */
import { Module } from '@nestjs/common';
import { CashAccountsController } from './cash-accounts.controller';
import { CashAccountsService } from './cash-accounts.service';
import { TransactionsModule } from '../transactions/transactions.module';

/** NestJS module definition for the cash-accounts feature. */
@Module({
  imports: [TransactionsModule],
  controllers: [CashAccountsController],
  providers: [CashAccountsService],
  exports: [CashAccountsService],
})
export class CashAccountsModule {}
