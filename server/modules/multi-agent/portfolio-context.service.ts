/**
 * portfolio-context.service.ts — PortfolioContextService — 组装流水线使用的
 * 单用户组合快照，并据此评估硬性/软性策略规则。
 *
 * 职责边界：
 *  1. getPortfolioContext：读持仓 + 现金账户，计算市值、权重、盈亏，以及
 *  按"公司组"聚合的敞口（如小米双重上市的 1810.HK / XIACF / XIACY 记为同一主体）。
 *  2. checkRiskRules：给定代码 + 组合快照 + 用户启用的规则，逐条评估已知
 *  ruleKey，返回通过/不通过 + 建议动作。硬规则不过会封顶最终评级
 *  （见 PipelineService.runRatingPhase）。
 *  3. applyRatingToHoldings：人工批准某次运行后，可把评级/动作/目标价
 *  回写到对应持仓行。
 *  - 不负责：行情获取与汇率数据本身（依赖 FxService 提供汇率）。
 * 上下游：
 *  - 上游（谁调用这里）：PipelineService（组合上下文与风控规则评估）、
 *    MultiAgentService（人工批准后回写评级）、BatchService（分层模式取权重）。
 *  - 下游（本文件调用谁）：FxService.convert（币种→USD 汇率）、
 *    database/schema 的 holdings / cashAccounts / agentRuns / agentRatings 表。
 * 关键约定：
 *  - 快照统一折算成 USD；持仓价格保留原币种。
 *  - 无法核实的规则一律按"未通过"返回，绝不静默视为通过。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and } from 'drizzle-orm';
import { holdings, cashAccounts, agentRuns, agentRatings } from '@server/database/schema';
import type { PortfolioContext, StrategyRule } from '@shared/api.interface';
import { FxService } from '@server/modules/fx/fx.service';

/**
 * 公认的杠杆/反向 ETF 代码清单，适用更严格的敞口上限。
 * 硬编码列表；按需扩充。
 */
const LEVERAGE_ETF_TICKERS = new Set([
  'TQQQ',
  'SQQQ',
  'SOXL',
  'SOXS',
  'NUGT',
  'DUST',
  'JDST',
  'JPNL',
  'UDOW',
  'SDOW',
  'UMDD',
  'SMDD',
  'UBOT',
  'LABU',
  'LABD',
  'TMF',
  'TMV',
  'UPRO',
  'SPXU',
  'QID',
  'QLD',
  'SDS',
  'SSO',
]);

/** 小米的"公司组"键（覆盖全部双重上市代码）。 */
const XIAOMI_GROUP = 'Xiaomi';

/**
 * 把代码映射到规范的"公司组"，使双重上市股份计为同一敞口。
 * 剥掉 .HK 后缀与前导零（如 01810.HK → 1810）；小米的各代码特判归入同一组。
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
   * 构建以 USD 计价的单用户组合快照：总值、现金、权重、各持仓市值，
   * 以及各公司组的敞口。持仓价格保留原币种。
   */
  async getPortfolioContext(userId: string): Promise<PortfolioContext> {
    // 并行读取持仓与现金账户行
    const [holdingRows, cashRows] = await Promise.all([
      this.db.select().from(holdings).where(eq(holdings.owner, userId)),
      this.db.select().from(cashAccounts).where(eq(cashAccounts.owner, userId)),
    ]);

    // 汇率缓存：USD 恒为 1；其余币种经 FxService 换算后缓存，
    // 缺汇率或汇率无效都直接抛中文错误（用户可见文案，冻结）
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

    // 现金折算：逐账户取 USD 汇率累加；非法余额直接抛错
    let cash = 0;
    for (const row of cashRows) {
      const balance = Number(row.balance ?? 0);
      if (!Number.isFinite(balance)) {
        throw new Error(`无法计算组合风控：${row.currency} 现金余额无效`);
      }
      if (balance !== 0) {
        cash += balance * (await getUsdRate(row.currency));
      }
    }

    // 持仓折算：逐行做数量/现价/成本价校验（错误文案为用户可见中文，冻结），
    // 计算原币市值、USD 市值与盈亏百分比
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
      if (
        !Number.isFinite(currentPrice) ||
        currentPrice < 0 ||
        (shares !== 0 && currentPrice === 0)
      ) {
        throw new Error(`无法计算组合风控：${h.ticker} 现价无效`);
      }
      if (buyPrice !== null && !Number.isFinite(buyPrice)) {
        throw new Error(`无法计算组合风控：${h.ticker} 成本价无效`);
      }
      const nativeMarketValue = shares * currentPrice;
      const marketValue =
        nativeMarketValue === 0 ? 0 : nativeMarketValue * (await getUsdRate(h.currency ?? 'USD'));
      totalMv += marketValue;
      const pnlPct =
        h.currentPrice !== null && buyPrice && buyPrice > 0
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
        weightPct: 0, // 总值已知后回填
        pnlPct,
        companyGroup: getCompanyGroup(h.ticker),
      });
    }

    const totalValue = totalMv + cash;

    // 第二遍：按组合总值计算每个持仓的权重百分比。
    for (const h of holdingDetails) {
      h.weightPct = totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0;
    }

    // 按公司组聚合权重，使双重上市股份只计一次。
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
   * 针对给定代码，按当前组合评估用户启用的策略规则。无法核实的规则
   * 按"未通过"返回，绝不静默当作通过。
   *
   * 硬规则（ruleType='hard'）不过会把最终评级封顶在 Hold。
   * 软规则仅供参考，会呈现给 LLM/用户但不封顶评级。
   *
   * @param ticker 正在分析的代码。
   * @param portfolio getPortfolioContext 生成的快照。
   * @param rules 用户的策略规则（已按所有者过滤）。
   * @returns 每条启用规则一条结果。
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

    // 公司组键与目标持仓行（供各规则共享）
    const companyGroup = getCompanyGroup(ticker);
    const holding = portfolio.holdings.find((h) => h.ticker.toUpperCase() === ticker.toUpperCase());
    // addUnverified：无法核实的规则统一产出"未通过"结果，附中文原因与建议动作
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

    // 逐条评估启用规则；阈值必须为非负有限数，否则按"无法核实"处理
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const threshold = rule.threshold?.trim() ? Number(rule.threshold) : null;
      if (threshold === null || !Number.isFinite(threshold) || threshold < 0) {
        addUnverified(rule, null, `${rule.ruleName} 的阈值缺失或无效，无法核实风控规则`);
        continue;
      }

      switch (rule.ruleKey) {
        // 同一公司组下所有代码的合并敞口（如 1810.HK + XIACF）。
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
            suggestedAction: passed
              ? '敞口在允许范围内'
              : `需减持 ${companyGroup} 相关标的至 ${threshold}% 以下`,
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
            suggestedAction: passed
              ? '单股权重在建议范围内'
              : `建议减持 ${ticker} 至 ${threshold}% 以下`,
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
            suggestedAction: passed
              ? '已识别杠杆ETF敞口在范围内'
              : `需降低杠杆ETF合计仓位至 ${threshold}% 以下`,
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
            suggestedAction: passed
              ? '现金比例达到配置下限'
              : `现金比例低于 ${threshold}%，建议增加现金储备`,
          });
          break;
        }

        // 回撤检查：仅当持仓处于浮亏时触发。
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
                : isStopLoss
                  ? '触发止损评估'
                  : '触发止盈评估或分批减仓',
            });
          }
          break;
        }

        case 'sector_exposure': {
          if (!holding?.sector) {
            addUnverified(rule, threshold, `${ticker} 缺少行业分类，无法核实行业敞口`);
            break;
          }
          if (
            portfolio.holdings.some(
              (item: PortfolioContext['holdings'][number]) => item.weightPct > 0 && !item.sector,
            )
          ) {
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
            suggestedAction: passed
              ? '行业敞口在配置范围内'
              : `需降低该行业仓位至 ${threshold}% 以下`,
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

  /**
   * 人工批准/修改某次运行后，可选地把评级/动作/目标价回写到调用方
   * 对应代码的持仓行。代码当前未持仓时不做任何事。
   * @returns 是否更新了持仓行。
   */
  async applyRatingToHoldings(userId: string, runId: string): Promise<boolean> {
    // 并行取运行行与评级行，二者都归属当前用户
    const [runRow, ratingRow] = await Promise.all([
      this.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId))),
      this.db
        .select()
        .from(agentRatings)
        .where(and(eq(agentRatings.runId, runId), eq(agentRatings.owner, userId))),
    ]);

    if (runRow.length === 0 || ratingRow.length === 0) return false;

    const rating = ratingRow[0];
    const ticker = runRow[0].ticker;

    const updated = await this.db
      .update(holdings)
      .set({
        rating: rating.rating,
        action: rating.action,
        targetPrice: rating.targetPrice !== null ? String(rating.targetPrice) : null,
      })
      .where(and(eq(holdings.ticker, ticker), eq(holdings.owner, userId)))
      .returning({ id: holdings.id });

    return updated.length > 0;
  }
}
