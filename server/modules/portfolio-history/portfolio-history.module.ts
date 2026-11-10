import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PortfolioHistoryProvider } from './portfolio-history.provider';
import { PortfolioHistoryCache } from './portfolio-history.cache';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PortfolioCurrentMarksService } from './portfolio-current-marks.service';
import { PortfolioHistoryController } from './portfolio-history.controller';

@Module({ imports: [HttpModule], controllers: [PortfolioHistoryController],
  providers: [PortfolioHistoryProvider, PortfolioHistoryCache, PortfolioHistoryHoldings, PortfolioHistoryService, PortfolioCurrentMarksService],
  exports: [PortfolioHistoryService, PortfolioCurrentMarksService] })
export class PortfolioHistoryModule {}
