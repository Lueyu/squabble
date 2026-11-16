/**
 * bot.scheduler.ts — 全天候 bot 调度器。
 *
 * 职责边界：
 *  - 只负责"定时唤起 + 判断开市 + 逐账户触发扫描"，不实现信号计算与下单
 *    （那些都在 PaperTradingService.runBotScan 内）。
 * 上下游：
 *  - 上游（谁初始化本类）：PaperTradingModule 在模块启动时实例化并调用 onModuleInit。
 *  - 下游（本文件调用谁）：Drizzle 数据库（paperAccounts 表）、market-clock 的 anyMarketOpen、
 *    PaperTradingService.runBotScan。
 * 关键约定：
 *  - 每 PAPER_TRADING_SCAN_MINUTES（默认 15）分钟唤醒一次，先检查是否有市场处于连续交易时段，
 *    有才对每个开启 bot 的账户各跑一轮扫描。
 *  - 每轮扫描：从该用户自己的分析评级派生信号 → 过护栏 → 成交存活单 → 记事件 → 拍当日净值快照。
 *  - PAPER_TRADING_ENABLED=false 可整体停用；单个账户扫描失败不影响其他账户（也不影响定时器）。
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts } from '../../database/schema';
import { anyMarketOpen } from '../../common/market-clock';
import { PaperTradingService } from './paper-trading.service';

/** 扫描间隔默认值（分钟）。 */
const DEFAULT_SCAN_MINUTES = 15;

@Injectable()
export class BotScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PaperBot');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly paper: PaperTradingService,
  ) {}

  /** 模块初始化：环境变量未停用时启动定时间隔。 */
  onModuleInit(): void {
    if (process.env.PAPER_TRADING_ENABLED === 'false') {
      this.logger.log('paper trading scheduler disabled (PAPER_TRADING_ENABLED=false)');
      return;
    }
    // 间隔可由环境变量覆盖，最小 1 分钟。
    const minutes = Math.max(
      1,
      Number(process.env.PAPER_TRADING_SCAN_MINUTES ?? DEFAULT_SCAN_MINUTES),
    );
    this.timer = setInterval(
      () => {
        this.tick().catch((error) => this.logger.warn(`scan tick failed: ${String(error)}`));
      },
      minutes * 60 * 1000,
    );
    // unref 让定时器不阻止进程退出。
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`paper trading scheduler started (every ${minutes} min)`);
  }

  /** 模块销毁：清掉定时间隔。 */
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 一次调度 tick：全部市场休市则跳过，否则逐账户跑 bot 扫描。 */
  private async tick(): Promise<void> {
    if (!anyMarketOpen()) return;
    const accounts = await this.db
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.botEnabled, true));
    // 逐账户扫描：单账户失败只记日志，不中断后续账户。
    for (const account of accounts) {
      try {
        await this.paper.runBotScan(account.owner);
      } catch (error) {
        this.logger.warn(`bot scan failed for account ${account.id}: ${String(error)}`);
      }
    }
  }
}
