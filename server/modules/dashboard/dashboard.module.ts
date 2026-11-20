/**
 * dashboard.module.ts — 组装 Dashboard（总览页）功能模块。
 *
 * 职责边界：
 *  - 只负责注册 Dashboard 的控制器与服务提供者，不承载业务逻辑。
 *  - 不直接访问数据库/上游行情源，数据获取全部下沉到各 Service。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，DashboardController 的路由才生效。
 *  - 下游：引入 FxModule（forwardRef 延迟解析）与 QuoteModule，为 DashboardService
 *    提供汇率与行情能力；同时注册 MarketOverviewService 作为附加提供者。
 * 关键约定：
 *  - FxModule 以 forwardRef(() => FxModule) 方式引入（延迟解析，沿用既有写法），不可改为直接 import。
 */
import { Module, forwardRef } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { FxModule } from '../fx/fx.module';
import { QuoteModule } from '../quote/quote.module';
import { MarketOverviewService } from './market-overview.service';

/** Dashboard 功能的 NestJS 模块定义。 */
@Module({
  imports: [forwardRef(() => FxModule), QuoteModule],
  controllers: [DashboardController],
  providers: [DashboardService, MarketOverviewService],
})
export class DashboardModule {}
