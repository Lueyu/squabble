/**
 * PortfolioContextService — assembles the per-user portfolio snapshot used by
 * research callers, and evaluates hard/soft strategy rules against it.
 *
 * Responsibilities:
 *  1. getPortfolioContext: read holdings + cash accounts, compute market
 *     values, weights, PnL, and aggregate "company group" exposure (e.g.
 *     Xiaomi's dual-listed 1810.HK / XIACF / XIACY count as one entity).
 *  2. checkRiskRules: given a ticker + portfolio + the user's enabled rules,
 *     evaluate each known ruleKey and return pass/fail + suggested action.
 *     Callers decide how those results constrain their own research workflow.
 * This service never writes ratings back to the real holdings ledger; retained
 * human-approval commands keep that mutation in MultiAgentService.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq } from 'drizzle-orm';
import { holdings, cashAccounts } from '@server/database/schema';
import type { PortfolioContext, StrategyRule } from '@shared/api.interface';
import { FxService } from '@server/modules/fx/fx.service';

/**
 * Tickers of well-known leveraged/inverse ETFs that get a stricter exposure
 * cap. Hard-coded list; extend as needed.
 */
const LEVERAGE_ETF_TICKERS = new Set([
  'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'NUGT', 'DUST', 'JDST', 'JPNL',
  'UDOW', 'SDOW', 'UMDD', 'SMDD', 'UBOT', 'LABU', 'LABD', 'TMF',
  'TMV', 'UPRO', 'SPXU', 'QID', 'QLD', 'SDS', 'SSO',
]);

/** Company-group key for Xiaomi (covers all dual-listed tickers). */
const XIAOMI_GROUP = 'Xiaomi';

/**
 * Map a ticker to its canonical "company group" so that dual-listed shares
 * count as one exposure. Strips the .HK suffix and leading zeros (e.g.
 * 01810.HK → 1810). Special-cases Xiaomi's tickers to a single group.
 */
function getCompanyGroup(ticker: string): string {
  const upper = ticker.toUpperCase().replace(/\.HK$/, '').replace(/^0+/, '');
  if (upper === '1810' || upper === 'XIACF' || upper === 'XIACY') {
    return XIAOMI_GROUP;
  }
  return ticker.toUpperCase();
}

@Injectable()
export class PortfolioContextService {
  private readonly logger = new Logger(PortfolioContextService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly fxService: FxService,
  ) {}

  /**
   * Build the per-user portfolio snapshot in USD: total value, cash, weights,
   * per-holding market value, and per-company-group exposure. Holding prices
   * remain in their native currencies.
   */
  async getPortfolioContext(userId: string): Promise<PortfolioContext> {
    const [holdingRows, cashRows] = await Promise.all([
      this.db.select().from(holdings).where(eq(holdings.owner, userId)),
      this.db.select().from(cashAccounts).where(eq(cashAccounts.owner, userId)),
    ]);

    const rateCache = new Map<string, number>([['USD', 1]]);
    const getUsdRate = async (currency: string): Promise<number> => {
      const source = currency.toUpperCase();
      const cached = rateCache.get(source);
      if (cached !== undefined) return cached;

      let rate: number;
      try {
        rate = await this.fxService.convert(1, source, 'USD');
      } catch (error) {
        throw new Error(`无法计算组合风控：缺少 ${source} -> USD 汇率，请先更新汇率`, {
          cause: error,
        });
      }
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`无法计算组合风控：${source} -> USD 汇率无效`);
      }
      rateCache.set(source, rate);
      return rate;
    };

    let cash = 0;
    for (const row of cashRows) {
      const balance = Number(row.balance ?? 0);
      if (!Number.isFinite(balance)) {
        throw new Error(`无法计算组合风控：${row.currency} 现金余额无效`);
      }
      if (balance !== 0) {
        cash += balance * await getUsdRate(row.currency);
      }
    }

    let totalMv = 0;
    const holdingDetails: PortfolioContext['holdings'] = [];
    for (const h of holdingRows) {
      const shares = Number(h.shares ?? 0);
      const currentPrice = Number(h.currentPrice ?? 0);
      const buyPrice = h.buyPrice ? Number(h.buyPrice) : null;
      if (!Number.isFinite(shares)) {
        throw new Error(`无法计算组合风控：${h.ticker} 持仓数量无效`);
      }
      if (shares !== 0 && h.currentPrice === null) {
        throw new Error(`无法计算组合风控：${h.ticker} 缺少现价`);
      }
      if (!Number.isFinite(currentPrice) || currentPrice < 0 || (shares !== 0 && currentPrice === 0)) {
        throw new Error(`无法计算组合风控：${h.ticker} 现价无效`);
      }
      if (buyPrice !== null && !Number.isFinite(buyPrice)) {
        throw new Error(`无法计算组合风控：${h.ticker} 成本价无效`);
      }
      const nativeMarketValue = shares * currentPrice;
      const marketValue = nativeMarketValue === 0
        ? 0
        : nativeMarketValue * await getUsdRate(h.currency ?? 'USD');
      totalMv += marketValue;
      const pnlPct = h.currentPrice !== null && buyPrice && buyPrice > 0
        ? ((currentPrice - buyPrice) / buyPrice) * 100
        : null;

      holdingDetails.push({
        ticker: h.ticker,
        company: h.company,
        sector: h.sector,
        market: h.market ?? 'US',
        currency: h.currency ?? 'USD',
        shares,
        currentPrice,
        costPrice: buyPrice,
        marketValue,
        weightPct: 0, // filled in after totalValue is known
        pnlPct,
        companyGroup: getCompanyGroup(h.ticker),
      });
    }

    const totalValue = totalMv + cash;

    // Second pass: compute weightPct against total portfolio value.
    for (const h of holdingDetails) {
      h.weightPct = totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0;
    }

    // Aggregate weight by company group so dual-listed shares count once.
    const companyExposures: Record<string, number> = {};
    for (const h of holdingDetails) {
      companyExposures[h.companyGroup] = (companyExposures[h.companyGroup] ?? 0) + h.weightPct;
    }

    return {
      totalValue,
      totalMv,
      cash,
      cashRatio: totalValue > 0 ? (cash / totalValue) * 100 : 0,
      holdings: holdingDetails,
      companyExposures,
    };
  }

  /**
   * Evaluate the user's enabled strategy rules for a given ticker against the
   * current portfolio. Rules that cannot be verified are returned as failures
   * rather than silently treated as passes.
   *
   * Hard rules (ruleType='hard') that fail cap the final rating at Hold.
   * Soft rules are advisory and surfaced to the LLM / user but do not cap the
   * rating.
   *
   * @param ticker the ticker being analyzed.
   * @param portfolio the snapshot from getPortfolioContext.
   * @param rules the user's strategy rules (already filtered to owner).
   * @returns one entry per enabled rule.
   */
  checkRiskRules(
    ticker: string,
    portfolio: PortfolioContext,
    rules: StrategyRule[],
  ): Array<{
    ruleKey: string;
    ruleName: string;
    ruleType: 'hard' | 'soft';
    passed: boolean;
    currentValue: number | null;
    thresholdValue: number | null;
    detail: string;
    suggestedAction: string;
  }> {
    const results: Array<{
      ruleKey: string;
      ruleName: string;
      ruleType: 'hard' | 'soft';
      passed: boolean;
      currentValue: number | null;
      thresholdValue: number | null;
      detail: string;
      suggestedAction: string;
    }> = [];

    const companyGroup = getCompanyGroup(ticker);
    const holding = portfolio.holdings.find((h) => h.ticker.toUpperCase() === ticker.toUpperCase());
    const addUnverified = (
      rule: StrategyRule,
      thresholdValue: number | null,
      detail: string,
    ): void => {
      results.push({
        ruleKey: rule.ruleKey,
        ruleName: rule.ruleName,
        ruleType: rule.ruleType,
        passed: false,
        currentValue: null,
        thresholdValue,
        detail,
        suggestedAction: '补齐验证数据或停用该规则后重新运行风控',
      });
    };

    for (const rule of rules) {
      if (!rule.enabled) continue;
      const threshold = rule.threshold?.trim() ? Number(rule.threshold) : null;
      if (threshold === null || !Number.isFinite(threshold) || threshold < 0) {
        addUnverified(rule, null, `${rule.ruleName} 的阈值缺失或无效，无法核实风控规则`);
        continue;
      }

      switch (rule.ruleKey) {
        // Combined exposure across all tickers belonging to the same company
        // group (e.g. 1810.HK + XIACF).
        case 'single_company_exposure': {
          const exposure = portfolio.companyExposures[companyGroup] ?? 0;
          const passed = threshold === null ? true : exposure <= threshold;
          results.push({
            ruleKey: rule.ruleKey,
            ruleName: rule.ruleName,
            ruleType: rule.ruleType,
            passed,
            currentValue: Number(exposure.toFixed(2)),
            thresholdValue: threshold,
            detail: `${companyGroup} 合并敞口 ${exposure.toFixed(2)}%，阈值 ${threshold}%`,
            suggestedAction: passed ? '敞口在允许范围内' : `需减持 ${companyGroup} 相关标的至 ${threshold}% 以下`,
          });
          break;
        }

        case 'single_stock_limit': {
          const weight = holding?.weightPct ?? 0;
          const passed = threshold === null ? true : weight <= threshold;
          results.push({
            ruleKey: rule.ruleKey,
            ruleName: rule.ruleName,
            ruleType: rule.ruleType,
            passed,
            currentValue: Number(weight.toFixed(2)),
            thresholdValue: threshold,
            detail: `${ticker} 权重 ${weight.toFixed(2)}%，阈值 ${threshold}%`,
            suggestedAction: passed ? '单股权重在建议范围内' : `建议减持 ${ticker} 至 ${threshold}% 以下`,
          });
          break;
        }

        case 'small_cap_weight': {
          addUnverified(
            rule,
            threshold,
            '持仓数据没有公司市值，无法核实市值小于50亿的股票合计仓位；股价不能代替市值',
          );
          break;
        }

        case 'leverage_etf': {
          const exposure = portfolio.holdings.reduce(
            (total: number, item: PortfolioContext['holdings'][number]): number =>
              total + (LEVERAGE_ETF_TICKERS.has(item.ticker.toUpperCase()) ? item.weightPct : 0),
            0,
          );
          const passed = exposure <= threshold;
          results.push({
            ruleKey: rule.ruleKey,
            ruleName: rule.ruleName,
            ruleType: rule.ruleType,
            passed,
            currentValue: Number(exposure.toFixed(2)),
            thresholdValue: threshold,
            detail: `已识别杠杆/反向ETF合计仓位 ${exposure.toFixed(2)}%，阈值 ${threshold}%`,
            suggestedAction: passed ? '已识别杠杆ETF敞口在范围内' : `需降低杠杆ETF合计仓位至 ${threshold}% 以下`,
          });
          break;
        }

        case 'cash_ratio': {
          const passed = portfolio.cashRatio >= threshold;
          results.push({
            ruleKey: rule.ruleKey,
            ruleName: rule.ruleName,
            ruleType: rule.ruleType,
            passed,
            currentValue: Number(portfolio.cashRatio.toFixed(2)),
            thresholdValue: threshold,
            detail: `现金比例 ${portfolio.cashRatio.toFixed(2)}%，配置下限 ${threshold}%`,
            suggestedAction: passed ? '现金比例达到配置下限' : `现金比例低于 ${threshold}%，建议增加现金储备`,
          });
          break;
        }

        // Drawdown check: only fires when the position is at a loss.
        case 'drawdown_check': {
          const pnlPct = holding?.pnlPct;
          if (holding && pnlPct === null) {
            addUnverified(rule, threshold, `${ticker} 缺少有效成本价或现价，无法核实回撤`);
          } else if (holding && pnlPct !== null && pnlPct < 0) {
            const drawdown = Math.abs(pnlPct);
            const passed = drawdown <= threshold;
            results.push({
              ruleKey: rule.ruleKey,
              ruleName: rule.ruleName,
              ruleType: rule.ruleType,
              passed,
              currentValue: Number(drawdown.toFixed(2)),
              thresholdValue: threshold,
              detail: `${ticker} 浮亏 ${drawdown.toFixed(2)}%，阈值 ${threshold}%`,
              suggestedAction: passed ? '回撤在允许范围内' : '回撤过大，需强制重检持仓逻辑',
            });
          } else if (holding) {
            results.push({
              ruleKey: rule.ruleKey,
              ruleName: rule.ruleName,
              ruleType: rule.ruleType,
              passed: true,
              currentValue: pnlPct !== null ? Number(pnlPct.toFixed(2)) : null,
              thresholdValue: threshold,
              detail: `${ticker} 当前盈利或持平，无回撤风险`,
              suggestedAction: '不适用',
            });
          } else {
            results.push({
              ruleKey: rule.ruleKey,
              ruleName: rule.ruleName,
              ruleType: rule.ruleType,
              passed: true,
              currentValue: null,
              thresholdValue: threshold,
              detail: `${ticker} 不在持仓中`,
              suggestedAction: '不适用',
            });
          }
          break;
        }

        case 'stop_loss_pct':
        case 'take_profit_pct': {
          if (!holding) {
            results.push({
              ruleKey: rule.ruleKey,
              ruleName: rule.ruleName,
              ruleType: rule.ruleType,
              passed: true,
              currentValue: null,
              thresholdValue: threshold,
              detail: `${ticker} 不在持仓中，该规则暂不适用`,
              suggestedAction: '不适用',
            });
          } else if (holding.pnlPct === null) {
            addUnverified(rule, threshold, `${ticker} 缺少有效成本价或现价，无法核实浮盈亏`);
          } else {
            const isStopLoss = rule.ruleKey === 'stop_loss_pct';
            const currentValue = isStopLoss
              ? Math.max(0, -holding.pnlPct)
              : Math.max(0, holding.pnlPct);
            const passed = currentValue <= threshold;
            results.push({
              ruleKey: rule.ruleKey,
              ruleName: rule.ruleName,
              ruleType: rule.ruleType,
              passed,
              currentValue: Number(currentValue.toFixed(2)),
              thresholdValue: threshold,
              detail: `${ticker} ${isStopLoss ? '浮亏' : '浮盈'} ${currentValue.toFixed(2)}%，阈值 ${threshold}%`,
              suggestedAction: passed
                ? '未触发阈值'
                : isStopLoss ? '触发止损评估' : '触发止盈评估或分批减仓',
            });
          }
          break;
        }

        case 'sector_exposure': {
          if (!holding?.sector) {
            addUnverified(rule, threshold, `${ticker} 缺少行业分类，无法核实行业敞口`);
            break;
          }
          if (portfolio.holdings.some((item: PortfolioContext['holdings'][number]) =>
            item.weightPct > 0 && !item.sector)) {
            addUnverified(rule, threshold, '部分持仓缺少行业分类，无法核实行业合计敞口');
            break;
          }
          const sector = holding.sector.trim().toUpperCase();
          const exposure = portfolio.holdings.reduce(
            (total: number, item: PortfolioContext['holdings'][number]): number =>
              total + (item.sector?.trim().toUpperCase() === sector ? item.weightPct : 0),
            0,
          );
          const passed = exposure <= threshold;
          results.push({
            ruleKey: rule.ruleKey,
            ruleName: rule.ruleName,
            ruleType: rule.ruleType,
            passed,
            currentValue: Number(exposure.toFixed(2)),
            thresholdValue: threshold,
            detail: `${holding.sector} 行业合计仓位 ${exposure.toFixed(2)}%，阈值 ${threshold}%`,
            suggestedAction: passed ? '行业敞口在配置范围内' : `需降低该行业仓位至 ${threshold}% 以下`,
          });
          break;
        }

        case 'loss_maker_weight':
          addUnverified(rule, threshold, '持仓数据没有最近一期净利润，无法核实亏损股合计仓位');
          break;

        case 'new_buy_checklist':
          addUnverified(rule, threshold, '未收到建仓清单完成状态及拟买入动作，无法核实建仓前条件');
          break;

        case 'position_building_days':
          addUnverified(rule, threshold, '组合上下文没有分批交易次数和时间跨度，无法核实建仓节奏');
          break;

        default:
          addUnverified(rule, threshold, `规则 ${rule.ruleKey} 未实现，无法核实是否通过`);
          break;
      }
    }

    return results;
  }

}
