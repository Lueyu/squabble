/**
 * EvidenceService — 收集供多智能体辩论使用的证据。
 *
 * 证据分为基本面、新闻、技术面三路。取不到的输入一律记录为显式数据缺口，
 * 绝不充当正/负面事实。
 *
 * 职责边界：
 *  - 编排三路采集器并做语言本地化（zh-CN 原生 / en 经 englishEvidenceText 映射）。
 *  - 不直接调用外部供应商：行情走 QuoteService，估值/财报/新闻走
 *    FinnhubEvidenceService，财报缺项回查 SEC 走 SecEvidenceService，
 *    联网检索走 ResearchWebService。
 *
 * 上下游：
 *  - 上游（谁调用）：PipelineService / MultiAgentService（主分析流）。
 *  - 下游（本文件调用）：QuoteService、FinnhubEvidenceService、
 *    SecEvidenceService、ResearchWebService、evidence-language 的
 *    englishEvidenceText、analysis-report 的 analysisErrorCode。
 *
 * 关键约定：
 *  - 三路采集用 Promise.allSettled 并行，任何一路失败都降级为 dataGap
 *    （sourceName='Data Unavailable'、relevanceScore=0），不抛出。
 *  - 缺口文案（dataGap 的 title/content）为用户可见中文，冻结。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { englishEvidenceText } from './evidence-language';
import { analysisErrorCode } from './analysis-report';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq } from 'drizzle-orm';
import { holdings, watchlist } from '@server/database/schema';
import { QuoteService } from '@server/modules/quote/quote.service';
import type {
  EvidenceType,
  PortfolioContext,
  QuoteResponse,
  AnalysisLanguage,
} from '@shared/api.interface';
import {
  FinnhubEvidenceService,
  FinnhubEvidenceError,
  finnhubGapReason,
} from './finnhub-evidence.service';
import { SecEvidenceService, SecEvidenceError } from './sec-evidence.service';
import type { FinnhubFinancialsResult } from './finnhub-financials';
import type { CouncilResearchKind, ResearchAcquisition } from '@shared/council.interface';
import { ResearchWebService } from './research-web.service';

export interface EvidenceCollectionOptions {
  /** 每次采集开始/结束时上报的事件回调（用于 council 实时进度展示）。 */
  onAcquisition?: (event: ResearchAcquisition) => Promise<void> | void;
  /** 协作式取消探针；返回 false 时各采集点抛 'Research stopped'。 */
  shouldContinue?: () => Promise<boolean>;
  /** 研究工具预算的任务 id（透传给 ResearchToolsBudgetService.reserve）。 */
  taskId?: string;
  /** 自定义检索词（仅 web 采集使用）。 */
  query?: string;
  /** 是否允许联网搜索。 */
  webResearch?: boolean;
}

/** 证据的高层类别；UI 用它标注证据行。 */
export type EvidenceRole = 'fundamental' | 'news' | 'technical';

/** 单条可直接喂给 LLM 提示词或持久化的证据。 */
export interface EvidenceInput {
  role: EvidenceRole;
  evidenceType: EvidenceType;
  title: string;
  content: string;
  sourceUrl?: string;
  sourceName?: string;
  relevanceScore: number;
}

@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
    private readonly finnhubEvidence: FinnhubEvidenceService,
    private readonly secEvidence: SecEvidenceService,
    private readonly webResearch: ResearchWebService,
  ) {}

  /**
   * 收集一个代码的全部证据。三路采集器并行执行；部分失败记为数据缺口，
   * 而不是研究事实。
   * @param ticker 待分析的股票代码。
   * @param userId 所有者，用于读取调用方的持仓/关注列表。
   * @param portfolioContext 以 USD 归一的组合快照，用于权重。
   */
  async collectEvidence(
    ticker: string,
    userId: string,
    portfolioContext: PortfolioContext | null,
    language: AnalysisLanguage = 'zh-CN',
    options: EvidenceCollectionOptions = {},
  ): Promise<EvidenceInput[]> {
    // 三路采集并行；allSettled 保证单路失败不影响其余两路
    const [fundamental, news, technical] = await Promise.allSettled([
      this.collectFundamental(ticker, userId, portfolioContext, language, options),
      this.collectResearch(ticker, userId, 'news', language, options),
      this.collectTechnical(ticker),
    ]);

    const allEvidence: EvidenceInput[] = [];

    // 基本面：失败时降级为显式缺口（缺口文案为用户可见中文，冻结）
    if (fundamental.status === 'fulfilled') {
      allEvidence.push(...fundamental.value);
    } else {
      this.logger.warn(
        `Fundamental analysis failed for ${ticker}: ${analysisErrorCode(fundamental.reason)}`,
      );
      allEvidence.push(
        this.dataGap(
          'fundamental',
          '基本面数据获取失败',
          '持仓、关注列表或行情获取失败，当前基本面数据不完整。',
        ),
      );
    }

    // 新闻：失败时降级为缺口
    if (news.status === 'fulfilled') {
      allEvidence.push(...news.value);
    } else {
      this.logger.warn(`News analysis failed for ${ticker}: ${analysisErrorCode(news.reason)}`);
      allEvidence.push(
        this.dataGap('news', '新闻数据获取失败', '新闻数据获取失败，无法判断最新事件与情绪。'),
      );
    }

    // 技术面：失败时降级为缺口；最后统一做语言本地化
    if (technical.status === 'fulfilled') {
      allEvidence.push(...technical.value);
    } else {
      this.logger.warn(
        `Technical analysis failed for ${ticker}: ${analysisErrorCode(technical.reason)}`,
      );
      allEvidence.push(
        this.dataGap(
          'technical',
          '技术面数据获取失败',
          '行情或历史K线获取失败，无法完成技术面分析。',
        ),
      );
    }

    return this.localize(allEvidence, language);
  }

  /**
   * 语言本地化：仅 en 需要转换。来自 Finnhub API / SEC EDGAR 的条目
   * 本身已是英文，原样返回；其余条目的 title/content 经固定短语表映射。
   */
  private localize(items: EvidenceInput[], language: AnalysisLanguage): EvidenceInput[] {
    if (language !== 'en') return items;
    return items.map((item) =>
      ['Finnhub API', 'SEC EDGAR'].includes(item.sourceName ?? '')
        ? item
        : {
            ...item,
            title: englishEvidenceText(item.title),
            content: englishEvidenceText(item.content),
          },
    );
  }

  /**
   * 固定的只读工具类型集合；代码/用户在服务端绑定，绝不会拼成任意 URL。
   * 按类型分发：financials→collectFinancials，web→ResearchWebService，
   * news/valuation/price 走下方各采集器；每次开始/结束都上报 acquisition 事件。
   */
  async collectResearch(
    ticker: string,
    userId: string,
    kind: CouncilResearchKind,
    language: AnalysisLanguage = 'zh-CN',
    options: EvidenceCollectionOptions = {},
  ): Promise<EvidenceInput[]> {
    if (options.shouldContinue && !(await options.shouldContinue()))
      throw new Error('Research stopped');
    if (kind === 'financials')
      return this.localize(
        await this.collectFinancials(ticker, userId, language, options),
        language,
      );
    if (kind === 'web') {
      return this.webResearch.search(userId, ticker, language, options);
    }
    const source: string = kind === 'price' ? 'Market quote' : 'Finnhub';
    await this.acquisition(options, {
      source,
      status: 'started',
      kind,
      detail:
        language === 'en'
          ? `Fetching ${kind} for ${ticker}.`
          : `正在获取 ${ticker} 的${kind}数据。`,
    });
    // price 采集：行情无效时退化为一条"行情缺失"缺口（文案冻结）
    let items: EvidenceInput[];
    if (kind === 'news') items = await this.collectNews(ticker, userId);
    else if (kind === 'valuation') items = await this.collectValuation(ticker, userId);
    else if (kind === 'price') {
      try {
        const quote: QuoteResponse = await this.quoteService.getQuote(ticker);
        items =
          Number.isFinite(Number(quote.price)) && Number(quote.price) > 0
            ? [this.buildQuoteEvidence(quote)]
            : [];
      } catch {
        items = [];
      }
      if (!items.length)
        items = [
          this.dataGap(
            'fundamental',
            `${ticker} 行情缺失`,
            '当前行情报价获取失败，无法据此计算最新市值和浮盈亏。',
          ),
        ];
    } else throw new Error('Unsupported research kind');
    // 本地化后按"是否出现 Data Unavailable 缺口"上报最终采集状态
    items = this.localize(items, language);
    const unavailable: EvidenceInput | undefined = items.find(
      (item: EvidenceInput) => item.sourceName === 'Data Unavailable',
    );
    await this.acquisition(options, {
      source,
      status: unavailable ? 'failed' : 'succeeded',
      kind,
      detail:
        unavailable?.content ??
        (language === 'en'
          ? `Retrieved ${items.length} sourced items.`
          : `已取得 ${items.length} 条带来源的数据。`),
    });
    return items;
  }

  /** 上报 acquisition 事件前的统一取消探针。 */
  private async acquisition(
    options: EvidenceCollectionOptions,
    event: ResearchAcquisition,
  ): Promise<void> {
    if (options.shouldContinue && !(await options.shouldContinue()))
      throw new Error('Research stopped');
    await options.onAcquisition?.(event);
  }

  /** 构造显式数据缺口条目（sourceName='Data Unavailable'、相关性 0）。 */
  private dataGap(role: EvidenceRole, title: string, content: string): EvidenceInput {
    return {
      role,
      evidenceType: 'other',
      title,
      content,
      sourceName: 'Data Unavailable',
      relevanceScore: 0,
    };
  }

  /**
   * 基本面证据：行情、组合持仓/关注列表状态，以及配置的供应商估值
   * 指标与已申报财报。失败或不完整的来源保留为缺口。
   */
  private async collectFundamental(
    ticker: string,
    userId: string,
    portfolioContext: PortfolioContext | null,
    language: AnalysisLanguage,
    options: EvidenceCollectionOptions,
  ): Promise<EvidenceInput[]> {
    const evidence: EvidenceInput[] = [];

    // 第一块：行情。失败不抛出，只记日志并降级为缺口
    let quote: QuoteResponse | null = null;
    try {
      quote = await this.quoteService.getQuote(ticker);
    } catch (error) {
      this.logger.warn(`Quote lookup failed for ${ticker}: ${analysisErrorCode(error)}`);
    }

    // 行情有效则入证据；否则清空并写入"行情缺失"缺口（文案冻结）
    if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
      evidence.push(this.buildQuoteEvidence(quote));
    } else {
      quote = null;
      evidence.push(
        this.dataGap(
          'fundamental',
          `${ticker} 行情缺失`,
          '当前行情报价获取失败，无法据此计算最新市值和浮盈亏。',
        ),
      );
    }

    // 第二块：读取该用户此代码的持仓行与关注行（各取第一条，忽略其余）
    const [holdingRows, watchRows] = await Promise.all([
      this.db
        .select()
        .from(holdings)
        .where(eq(holdings.owner, userId))
        .then((rows) => rows.filter((r) => r.ticker.toUpperCase() === ticker.toUpperCase())),
      this.db
        .select()
        .from(watchlist)
        .where(eq(watchlist.owner, userId))
        .then((rows) => rows.filter((r) => r.ticker.toUpperCase() === ticker.toUpperCase())),
    ]);

    // 第三块：持仓 → 关注 → 都没有，三种分支各产出一条证据。
    // 持仓分支：数量/成本/行业 + 行情币种一致时补市值与浮盈亏，
    // 币种不一致则注明无法计算；组合快照里有该持仓再补权重。
    if (holdingRows.length > 0) {
      const h = holdingRows[0];
      const shares = Number(h.shares ?? 0);
      const buyPrice = Number(h.buyPrice ?? 0);
      const currency = h.currency || quote?.currency || 'USD';
      const portfolioHolding = portfolioContext?.holdings?.find(
        (item) => item.ticker.toUpperCase() === h.ticker.toUpperCase(),
      );
      let content = `持仓数量: ${shares}股, 成本价: ${currency} ${buyPrice.toFixed(2)}, 行业: ${h.sector ?? '未知'}`;
      if (quote && quote.currency === currency) {
        const currentPrice = Number(quote.price);
        const marketValue = shares * currentPrice;
        const cost = shares * buyPrice;
        const pnl = marketValue - cost;
        const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
        content += [
          `, 报价: ${currency} ${currentPrice.toFixed(2)}`,
          `市值: ${currency} ${marketValue.toFixed(2)}`,
          `浮盈亏: ${currency} ${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
        ].join(', ');
      } else if (quote) {
        content += ', 报价币种与持仓币种不一致，无法计算浮盈亏';
      }
      if (portfolioHolding) {
        content += `, 组合记录市值: USD ${portfolioHolding.marketValue.toFixed(2)}`;
        content += `, 组合权重: ${portfolioHolding.weightPct.toFixed(2)}%`;
      }

      evidence.push({
        role: 'fundamental',
        evidenceType: 'other',
        title: `持仓信息 - ${h.ticker}`,
        content,
        sourceName: 'Portfolio Data',
        relevanceScore: 0.95,
      });
    } else if (watchRows.length > 0) {
      const w = watchRows[0];
      evidence.push({
        role: 'fundamental',
        evidenceType: 'other',
        title: `关注股信息 - ${w.ticker}`,
        content: `关注股: ${w.ticker}, 公司: ${w.company ?? '未知'}, 行业: ${w.sector ?? '未知'}`,
        sourceName: 'Watchlist Data',
        relevanceScore: 0.8,
      });
    } else {
      evidence.push({
        role: 'fundamental',
        evidenceType: 'other',
        title: `${ticker} - 无持仓`,
        content: `该标的不在当前持仓或关注列表中。`,
        sourceName: 'Portfolio Data',
        relevanceScore: 0.5,
      });
    }

    // 第四块：并行追加供应商估值与财报证据（内部自带缺口降级）
    const [metrics, financials] = await Promise.all([
      this.collectResearch(ticker, userId, 'valuation', language, options),
      this.collectResearch(ticker, userId, 'financials', language, options),
    ]);
    evidence.push(...metrics, ...financials);

    return evidence;
  }

  /** 估值采集：Finnhub 指标不可用时产出"估值数据缺失"缺口（文案冻结）。 */
  private async collectValuation(ticker: string, userId: string): Promise<EvidenceInput[]> {
    let reason: string = finnhubGapReason(new FinnhubEvidenceError('no_data'));
    try {
      const metrics = await this.finnhubEvidence.getMetrics(userId, ticker);
      if (metrics?.hasValuation) return metrics.items;
    } catch (error) {
      reason = finnhubGapReason(error);
    }
    return [
      this.dataGap(
        'fundamental',
        `${ticker} 估值数据缺失`,
        `${reason} 当前缺少 PE、PB、PS 等估值数据及可比公司或历史估值参考。`,
      ),
    ];
  }

  /**
   * 财报采集，两级回退：Finnhub 已申报财报 → SEC EDGAR 原始申报。
   * 每级开始/结束都上报 acquisition 事件；两级都拿不到完整报表时，
   * 汇总缺口原因与缺失科目，产出一条 dataGap（部分可用则标注来源）。
   */
  private async collectFinancials(
    ticker: string,
    userId: string,
    language: AnalysisLanguage,
    options: EvidenceCollectionOptions,
  ): Promise<EvidenceInput[]> {
    const en: boolean = language === 'en';
    let selected: FinnhubFinancialsResult | null = null;
    let failure: unknown;

    // 第一级：Finnhub 已申报财报
    await this.acquisition(options, {
      source: 'Finnhub',
      status: 'started',
      kind: 'financials',
      detail: en
        ? `Fetching reported financials for ${ticker}.`
        : `正在获取 ${ticker} 的已申报财报。`,
    });
    try {
      selected = await this.finnhubEvidence.getFinancials(userId, ticker);
    } catch (error) {
      failure = error;
    }
    const primaryReason: string = finnhubGapReason(
      failure ?? new FinnhubEvidenceError('incomplete_data'),
    );
    await this.acquisition(options, {
      source: 'Finnhub',
      kind: 'financials',
      status: selected?.hasStatements ? 'succeeded' : selected?.items.length ? 'partial' : 'failed',
      detail: selected?.hasStatements
        ? en
          ? 'Reported statement coverage is complete.'
          : '已取得完整财报科目。'
        : `${en ? englishEvidenceText(primaryReason) : primaryReason} ${selected?.missingFields.join(', ') ?? ''}`,
    });
    if (selected?.hasStatements) return selected.items;

    // 第二级：SEC EDGAR 原始申报回查（仅美股；失败码→双语说明表）
    await this.acquisition(options, {
      source: 'SEC EDGAR',
      status: 'started',
      kind: 'financials',
      detail: en
        ? 'Checking the original public SEC filing for missing financial data.'
        : '正在核对 SEC 原始公开申报，补充缺失财务数据。',
    });
    let fallbackReason: string = '';
    let secResult: Awaited<ReturnType<SecEvidenceService['getFinancials']>> | null = null;
    try {
      secResult = await this.secEvidence.getFinancials(ticker);
    } catch (error) {
      const code: string = error instanceof SecEvidenceError ? error.code : 'provider_error';
      const descriptions: Record<string, [string, string]> = {
        unsupported_market: [
          'This SEC integration supports U.S. listings only.',
          'SEC 备用来源仅支持美股上市代码。',
        ],
        no_data: [
          'No matching SEC issuer or usable filing was found.',
          '未找到匹配的 SEC 公司或可用申报。',
        ],
        invalid_response: [
          'SEC issuer, filing or response validation failed.',
          'SEC 公司、申报或响应校验失败。',
        ],
        stale_data: [
          'The latest SEC statement is too old for current coverage.',
          '最新 SEC 财报超过当前研究可用时效。',
        ],
        forbidden: [
          'SEC denied access; review deployment access policy and SEC_USER_AGENT.',
          'SEC 拒绝访问，请检查部署网络和 SEC_USER_AGENT。',
        ],
        rate_limited: ['SEC request limit reached; retry later.', 'SEC 请求频率受限，请稍后再试。'],
        timeout: ['The SEC request timed out.', 'SEC 请求超时。'],
        network_error: ['Could not connect to SEC.', '无法连接 SEC。'],
        response_too_large: [
          'SEC response exceeded the bounded download limit.',
          'SEC 响应超过本次下载大小限制。',
        ],
      };
      const detail: [string, string] = descriptions[code] ?? [
        'SEC request failed.',
        'SEC 请求失败。',
      ];
      fallbackReason = `[SEC:${code}] ${detail[en ? 0 : 1]}`;
    }
    if (secResult?.items.length) selected = secResult;
    await this.acquisition(options, {
      source: 'SEC EDGAR',
      kind: 'financials',
      status: !secResult
        ? 'failed'
        : secResult.cacheHit
          ? 'cache_hit'
          : secResult.hasStatements
            ? 'succeeded'
            : 'partial',
      detail:
        fallbackReason ||
        (secResult?.hasStatements
          ? en
            ? 'Verified financials from the same SEC filing, currency and reporting period.'
            : '已核实同一 SEC 申报、币种和报告期的财务数据。'
          : `${en ? 'SEC missing concepts: ' : 'SEC 仍缺少科目：'}${secResult?.missingFields.join(', ')}`),
    });
    if (secResult?.hasStatements) return secResult.items;

    // 两级都未产出完整报表：汇总部分可用来源与全部缺口原因，产出 dataGap
    const partial: boolean = !!selected?.items.length;
    const partialSource: string = selected?.items.some(
      (item: EvidenceInput) => item.sourceName === 'SEC EDGAR',
    )
      ? 'SEC'
      : 'Finnhub';
    const missing: string = selected?.missingFields.length
      ? ` 缺少科目或单位：${selected.missingFields.join(', ')}.`
      : '';
    const reason: string = `${en ? englishEvidenceText(primaryReason) : primaryReason} ${fallbackReason}`;
    const content: string = `${missing} ${reason} ${
      partial
        ? `${partialSource} 已成功返回部分经核实财报。`
        : '当前缺少经核实的营收、利润、现金流、负债等财报数据。'
    } 数据获取缺口不代表公司存在财务风险。`;
    return [
      ...(selected?.items ?? []),
      this.dataGap(
        'fundamental',
        `${ticker} ${partial ? '财报数据不完整' : '财报数据缺失'}`,
        content.trim(),
      ),
    ];
  }

  /** 从供应商报价构造一条行情证据（涨跌方向词为用户可见中文）。 */
  private buildQuoteEvidence(quote: QuoteResponse): EvidenceInput {
    const changePct = Number(quote.changePercent);
    const direction = changePct > 0 ? '上涨' : changePct < 0 ? '下跌' : '持平';

    return {
      role: 'fundamental',
      evidenceType: 'price',
      title: `${quote.symbol} 行情报价${quote.delayed ? '（延时）' : ''}`,
      content: [
        `报价: ${quote.currency} ${quote.price}`,
        `涨跌幅: ${quote.changePercent}% (${direction})`,
        `涨跌额: ${quote.currency} ${quote.change}`,
        `开盘价: ${quote.currency} ${quote.open ?? 'N/A'}`,
        `最高价: ${quote.currency} ${quote.high ?? 'N/A'}`,
        `最低价: ${quote.currency} ${quote.low ?? 'N/A'}`,
        `成交量: ${quote.volume ?? 'N/A'}`,
        `市场: ${quote.market}`,
        `币种: ${quote.currency}${quote.delayed ? '。供应商报价可能延时' : ''}`,
      ].join(', '),
      sourceName: 'Market Quote Provider',
      relevanceScore: 0.9,
    };
  }

  /**
   * 新闻采集：有经过核实的公司头条就用，绝不虚构情绪；
   * 取不到时产出"新闻与情绪缺失"缺口（文案冻结）。
   */
  private async collectNews(ticker: string, userId: string): Promise<EvidenceInput[]> {
    let reason: string = finnhubGapReason(new FinnhubEvidenceError('no_data'));
    try {
      const news = await this.finnhubEvidence.getNews(userId, ticker);
      if (news?.length) return news;
    } catch (error) {
      reason = finnhubGapReason(error);
    }
    return [
      this.dataGap(
        'news',
        `${ticker} 新闻与情绪缺失`,
        `${reason} 当前没有经核实的近期公司新闻或市场情绪数据。`,
      ),
    ];
  }

  /**
   * 当日价格行为可从行情取得；历史指标与支撑阻力位在没有 K 线数据时
   * 一律不可得，产出对应缺口（文案冻结）。
   */
  private async collectTechnical(ticker: string): Promise<EvidenceInput[]> {
    let quote: QuoteResponse | null = null;
    try {
      quote = await this.quoteService.getQuote(ticker);
    } catch (error) {
      this.logger.warn(`Technical quote lookup failed for ${ticker}: ${analysisErrorCode(error)}`);
    }

    // 行情无效 → 技术面整体缺口；有效 → 当日价格行为 + 历史指标缺失两条
    if (!quote || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) {
      return [
        this.dataGap(
          'technical',
          `${ticker} 技术面数据缺失`,
          '当前行情和历史K线均不可用，无法计算技术指标。',
        ),
      ];
    }

    return [
      {
        role: 'technical',
        evidenceType: 'price',
        title: `${ticker} 当日价格行为`,
        content: [
          `报价: ${quote.currency} ${quote.price}`,
          `当日最高: ${quote.currency} ${quote.high ?? 'N/A'}`,
          `当日最低: ${quote.currency} ${quote.low ?? 'N/A'}`,
          `当日涨跌幅: ${quote.changePercent}%`,
          `成交量: ${quote.volume ?? 'N/A'}${quote.delayed ? '。供应商报价可能延时' : ''}`,
        ].join(', '),
        sourceName: 'Quote Provider',
        relevanceScore: 0.6,
      },
      this.dataGap(
        'technical',
        `${ticker} 历史技术数据缺失`,
        '缺少历史K线及历史成交量，无法计算均线、RSI、MACD、量比和可靠的支撑阻力位。',
      ),
    ];
  }
}
