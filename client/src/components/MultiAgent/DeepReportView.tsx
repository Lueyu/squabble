/**
 * DeepReportView - renders the versioned, long-form multi-agent "deep research"
 * report (runMode === 'full') as a dark-themed document page.
 *
 * The report is a fixed 14-section structure (executive summary, business model,
 * financials, segments, valuation, industry, bull/bear, critic, catalysts, risks,
 * risk gate, PM action, tracking). Each section self-hides when its backing data
 * is empty, and the left/table-of-contents nav is built only from sections that
 * actually have data. An IntersectionObserver provides scroll-spy highlighting.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { formatScenarioProbabilities } from './scenario-probability';
import AnalysisTracePanel from './AnalysisTracePanel';
import type {
  DeepReport,
  AgentRating,
  AgentConfidence,
  BullBearPoint,
  CriticPoint,
  CatalystItem,
  RiskItem,
  ValuationRelativeItem,
  SotpItem,
  SegmentItem,
  FinancialPeriod,
  ProfitabilityMetric,
  CashFlowItem,
  RevenueItem,
  TrackingMetric,
  RiskGateResult,
} from '@shared/api.interface';

interface DeepReportViewProps {
  /** The versioned deep report data to render */
  report: DeepReport;
  /** Optional run id, shown in the header for traceability */
  runId?: string;
  /** Optional back-button callback; the button is only rendered when this is set */
  onBack?: () => void;
}

/** A visible table-of-contents entry; `visible` is derived from whether the underlying data exists */
interface SectionDef {
  /** Anchor id of the rendered <section>, also used for smooth scroll */
  id: string;
  /** Nav label shown in the TOC */
  label: string;
  /** Whether this section has any backing data (hidden sections are omitted from TOC) */
  visible: boolean;
}

// ─── Rating helpers ────────────────────────────────────────────────
/**
 * Returns the Badge color classes for a rating. Strong ratings get solid fills;
 * directional ratings (Buy/Sell/Hold/Watch) get translucent tints.
 */
const ratingColor = (rating: AgentRating | null | undefined): string => {
  switch (rating) {
    case 'Strong Buy':
      return 'bg-emerald-600 text-white border-emerald-500';
    case 'Buy':
      return 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/50';
    case 'Hold':
      return 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/50';
    case 'Sell':
      return 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/50';
    case 'Strong Sell':
      return 'bg-rose-600 text-white border-rose-500';
    case 'Watch':
      return 'bg-slate-500/20 text-foreground/85 border-slate-500/50';
    default:
      return 'bg-slate-500/20 text-foreground/85 border-slate-500/50';
  }
};

const localizedRating = (
  rating: AgentRating | string | null | undefined,
  t: (key: string) => string,
): string => {
  const keys: Record<string, string> = {
    'Strong Buy': 'analysis.strongBuy',
    Buy: 'analysis.buy',
    Hold: 'analysis.hold',
    Sell: 'analysis.sell',
    'Strong Sell': 'analysis.strongSell',
    Watch: 'analysis.watch',
  };
  return rating && keys[rating] ? t(keys[rating]) : (rating ?? '');
};

/** Badge color classes for confidence level: high=emerald, medium=amber, low=rose */
const confidenceColor = (confidence: AgentConfidence | null | undefined): string => {
  switch (confidence) {
    case 'high':
      return 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40';
    case 'medium':
      return 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40';
    case 'low':
      return 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/40';
    default:
      return 'bg-slate-500/20 text-foreground/85 border-slate-500/40';
  }
};

/** Translation key for confidence level; em-dash when absent */
const confidenceLabelKey = (confidence: AgentConfidence | null | undefined): string | null => {
  switch (confidence) {
    case 'high':
      return 'report.highConfidence';
    case 'medium':
      return 'report.mediumConfidence';
    case 'low':
      return 'report.lowConfidence';
    default:
      return null;
  }
};

// ─── Shared section heading ───────────────────────────────────────
/** Large numbered section heading with an anchor id for scroll-spy / TOC links */
const SectionTitle: React.FC<{ children: React.ReactNode; id: string }> = ({ children, id }) => (
  <h2
    id={id}
    className="scroll-mt-6 font-serif text-2xl md:text-3xl font-bold text-foreground pl-4 border-l-4 border-amber-500 mb-6"
  >
    {children}
  </h2>
);

/** Amber sub-heading used inside a section for sub-topics */
const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="font-serif text-lg font-semibold text-amber-700 dark:text-amber-400 mb-3 mt-6 first:mt-0">
    {children}
  </h3>
);

/** Renders a multi-line text blob as separated paragraphs; returns null when empty */
const ParagraphBlock: React.FC<{ content: string | null | undefined }> = ({ content }) => {
  const { t } = useTranslation();
  if (!content) return null;
  const paragraphs = content.split('\n').filter((p: string) => p.trim());
  return (
    <div className="space-y-3 text-foreground/85 leading-relaxed break-words">
      {paragraphs.map((p: string, i: number) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
};

// ─── Data table wrapper (dark style) ──────────────────────────────
/** Dark-bordered, horizontally-scrollable table shell used by every data table */
const DarkTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="border border-border rounded-lg overflow-x-auto bg-card/80">
    <Table className="min-w-full">{children}</Table>
  </div>
);

// ─── Section components ───────────────────────────────────────────

// ① Executive Summary
/** Top-of-report cards: current rating, confidence, previous rating, core thesis, and view changes */
const ExecutiveSummarySection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    report.rating ||
    report.confidence ||
    report.coreThesis ||
    report.viewChange ||
    report.prevRating;
  if (!hasContent) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="executive-summary">{t('report.coreThesis')}</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">
              {t('report.rating')}
            </p>
          </CardHeader>
          <CardContent>
            <Badge className={cn('text-base px-4 py-1.5', ratingColor(report.rating))}>
              {localizedRating(report.rating, t) || '—'}
            </Badge>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">
              {t('report.confidence')}
            </p>
          </CardHeader>
          <CardContent>
            <Badge className={cn('text-base px-4 py-1.5', confidenceColor(report.confidence))}>
              {confidenceLabelKey(report.confidence)
                ? t(confidenceLabelKey(report.confidence)!)
                : '—'}
            </Badge>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">
              {t('ui.report.previousRating')}
            </p>
          </CardHeader>
          <CardContent>
            <span className="text-foreground text-lg font-medium">
              {localizedRating(report.prevRating, t) || '—'}
            </span>
          </CardContent>
        </Card>
      </div>

      {report.coreThesis && (
        <div className="mb-5">
          <SubHeading>{t('report.coreThesis')}</SubHeading>
          <ParagraphBlock content={report.coreThesis} />
        </div>
      )}
      {report.viewChange && (
        <div>
          <SubHeading>{t('report.viewChange')}</SubHeading>
          <ParagraphBlock content={report.viewChange} />
        </div>
      )}
    </section>
  );
};

// ② Company & Business
/** Company overview, business model, moat, and the revenue-structure table */
const CompanyBusinessSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    report.companyOverview ||
    report.businessModel ||
    report.moat ||
    (report.revenueStructure && report.revenueStructure.length > 0);
  if (!hasContent) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="company-business">{t('report.companyOverview')}</SectionTitle>

      {report.companyOverview && (
        <div className="mb-5">
          <SubHeading>{t('report.companyOverview')}</SubHeading>
          <ParagraphBlock content={report.companyOverview} />
        </div>
      )}
      {report.businessModel && (
        <div className="mb-5">
          <SubHeading>{t('report.businessModel')}</SubHeading>
          <ParagraphBlock content={report.businessModel} />
        </div>
      )}
      {report.moat && (
        <div className="mb-5">
          <SubHeading>{t('report.moat')}</SubHeading>
          <ParagraphBlock content={report.moat} />
        </div>
      )}
      {report.revenueStructure && report.revenueStructure.length > 0 && (
        <div>
          <SubHeading>{t('report.revenueStructure')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">
                  {t('ui.report.businessSegment')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.revenue')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.share')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.yoy')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.revenueStructure.map((item: RevenueItem, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.segment}</TableCell>
                  <TableCell className="text-foreground/85 text-right">
                    {String(item.revenue)}
                  </TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 text-right font-medium">
                    {String(item.sharePct)}
                    {typeof item.sharePct === 'number' ? '%' : ''}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right',
                      Number(item.yoyPct) > 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : Number(item.yoyPct) < 0
                          ? 'text-rose-700 dark:text-rose-400'
                          : 'text-muted-foreground',
                    )}
                  >
                    {item.yoyPct != null ? String(item.yoyPct) : '—'}
                    {item.yoyPct && typeof item.yoyPct === 'number' ? '%' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}
    </section>
  );
};

// ③ Financial Depth
/** Annual/quarterly financials, profitability metrics, cash flow, and qualitative financial quality */
const FinancialSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    (report.financialAnnual && report.financialAnnual.length > 0) ||
    (report.financialQuarterly && report.financialQuarterly.length > 0) ||
    (report.profitability && report.profitability.length > 0) ||
    (report.cashFlow && report.cashFlow.length > 0) ||
    report.financialQuality;
  if (!hasContent) return null;

  const renderPeriodTable = (data: FinancialPeriod[] | null | undefined, label: string) => {
    if (!data || data.length === 0) return null;
    return (
      <div className="mb-6">
        <SubHeading>{label}</SubHeading>
        <DarkTable>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t('ui.report.period')}</TableHead>
              <TableHead className="text-muted-foreground text-right">
                {t('ui.report.revenue')}
              </TableHead>
              <TableHead className="text-muted-foreground text-right">
                {t('ui.report.netIncome')}
              </TableHead>
              <TableHead className="text-muted-foreground text-right">
                {t('ui.report.revenueYoy')}
              </TableHead>
              <TableHead className="text-muted-foreground text-right">
                {t('ui.report.profitYoy')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((p: FinancialPeriod, idx: number) => (
              <TableRow key={idx} className="border-border hover:bg-muted">
                <TableCell className="text-foreground font-medium">{p.period}</TableCell>
                <TableCell className="text-foreground/85 text-right">
                  {p.revenue != null ? String(p.revenue) : '—'}
                </TableCell>
                <TableCell className="text-foreground/85 text-right">
                  {p.netProfit != null ? String(p.netProfit) : '—'}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right',
                    Number(p.revenueYoy) > 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : Number(p.revenueYoy) < 0
                        ? 'text-rose-700 dark:text-rose-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {p.revenueYoy != null ? String(p.revenueYoy) : '—'}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right',
                    Number(p.profitYoy) > 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : Number(p.profitYoy) < 0
                        ? 'text-rose-700 dark:text-rose-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {p.profitYoy != null ? String(p.profitYoy) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DarkTable>
      </div>
    );
  };

  return (
    <section className="mb-16">
      <SectionTitle id="financial">{t('report.financials')}</SectionTitle>

      {renderPeriodTable(report.financialAnnual, t('report.financialAnnual'))}
      {renderPeriodTable(report.financialQuarterly, t('report.financialQuarterly'))}

      {report.profitability && report.profitability.length > 0 && (
        <div className="mb-6">
          <SubHeading>{t('report.profitability')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('ui.report.metric')}</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.currentValue')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">TTM</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.industryAverage')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.profitability.map((item: ProfitabilityMetric, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.metric}</TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 text-right font-medium">
                    {String(item.value)}
                  </TableCell>
                  <TableCell className="text-foreground/85 text-right">
                    {item.ttm != null ? String(item.ttm) : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {item.industry != null ? String(item.industry) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}

      {report.cashFlow && report.cashFlow.length > 0 && (
        <div className="mb-6">
          <SubHeading>{t('report.cashFlow')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('ui.report.item')}</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.value')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('ui.report.note')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.cashFlow.map((item: CashFlowItem, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.item}</TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 text-right font-medium">
                    {String(item.value)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.note ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}

      {report.financialQuality && (
        <div>
          <SubHeading>{t('report.financialQuality')}</SubHeading>
          <ParagraphBlock content={report.financialQuality} />
        </div>
      )}
    </section>
  );
};

// ④ Segments
/** Per-business-segment table: revenue, gross margin, growth, outlook */
const SegmentsSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  if (!report.segmentAnalysis || report.segmentAnalysis.length === 0) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="segments">{t('ui.report.segmentsSection')}</SectionTitle>
      <DarkTable>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="text-muted-foreground">{t('ui.report.segment')}</TableHead>
            <TableHead className="text-muted-foreground text-right">
              {t('ui.report.revenue')}
            </TableHead>
            <TableHead className="text-muted-foreground text-right">
              {t('ui.report.grossMargin')}
            </TableHead>
            <TableHead className="text-muted-foreground text-right">
              {t('ui.report.growth')}
            </TableHead>
            <TableHead className="text-muted-foreground">{t('ui.report.outlook')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.segmentAnalysis.map((item: SegmentItem, idx: number) => (
            <TableRow key={idx} className="border-border hover:bg-muted">
              <TableCell className="text-foreground font-medium">{item.name}</TableCell>
              <TableCell className="text-foreground/85 text-right">
                {item.revenue != null ? String(item.revenue) : '—'}
              </TableCell>
              <TableCell className="text-amber-700 dark:text-amber-400 text-right">
                {item.grossMargin != null ? String(item.grossMargin) : '—'}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right',
                  Number(item.growthPct) > 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : Number(item.growthPct) < 0
                      ? 'text-rose-700 dark:text-rose-400'
                      : 'text-muted-foreground',
                )}
              >
                {item.growthPct != null ? String(item.growthPct) : '—'}
              </TableCell>
              <TableCell className="text-muted-foreground max-w-[200px] truncate">
                {item.outlook ?? '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DarkTable>
    </section>
  );
};

// ⑤ Valuation
/** Relative valuation table, SOTP sum-of-parts table, and methodology narrative */
const ValuationSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    (report.valuationRelative && report.valuationRelative.length > 0) ||
    (report.valuationSotp && report.valuationSotp.length > 0) ||
    report.valuationMethodology;
  if (!hasContent) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="valuation">{t('report.valuation')}</SectionTitle>

      {report.valuationRelative && report.valuationRelative.length > 0 && (
        <div className="mb-6">
          <SubHeading>{t('report.valuationRelative')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('ui.report.metric')}</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.current')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.fiveYearPercentile')}
                </TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.industryAverage')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('ui.report.note')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.valuationRelative.map((item: ValuationRelativeItem, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.metric}</TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 text-right font-medium">
                    {String(item.current)}
                  </TableCell>
                  <TableCell className="text-foreground/85 text-right">
                    {item.percentile5y != null ? String(item.percentile5y) : '—'}
                  </TableCell>
                  <TableCell className="text-foreground/85 text-right">
                    {item.industryAvg != null ? String(item.industryAvg) : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[200px] truncate">
                    {item.note ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}

      {report.valuationSotp && report.valuationSotp.length > 0 && (
        <div className="mb-6">
          <SubHeading>{t('report.valuationSotp')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('ui.report.segment')}</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.valuation')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('ui.report.method')}</TableHead>
                <TableHead className="text-muted-foreground text-right">
                  {t('ui.report.multiple')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.valuationSotp.map((item: SotpItem, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.segment}</TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 text-right font-medium">
                    {String(item.valuation)}
                  </TableCell>
                  <TableCell className="text-foreground/85">{item.method}</TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {item.multiple != null ? String(item.multiple) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}

      {report.valuationMethodology && (
        <div>
          <SubHeading>{t('ui.report.valuationMethod')}</SubHeading>
          <ParagraphBlock content={report.valuationMethodology} />
        </div>
      )}
    </section>
  );
};

// ⑥ Industry & Competition
/** Industry overview, market size, competitive position, and trends as narrative blocks */
const IndustrySection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    report.industryOverview ||
    report.marketSize ||
    report.competitivePosition ||
    report.industryTrends;
  if (!hasContent) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="industry">{t('report.industryOverview')}</SectionTitle>

      {report.industryOverview && (
        <div className="mb-5">
          <SubHeading>{t('report.industryOverview')}</SubHeading>
          <ParagraphBlock content={report.industryOverview} />
        </div>
      )}
      {report.marketSize && (
        <div className="mb-5">
          <SubHeading>{t('report.marketSize')}</SubHeading>
          <ParagraphBlock content={report.marketSize} />
        </div>
      )}
      {report.competitivePosition && (
        <div className="mb-5">
          <SubHeading>{t('report.competitivePosition')}</SubHeading>
          <ParagraphBlock content={report.competitivePosition} />
        </div>
      )}
      {report.industryTrends && (
        <div>
          <SubHeading>{t('report.industryTrends')}</SubHeading>
          <ParagraphBlock content={report.industryTrends} />
        </div>
      )}
    </section>
  );
};

// ⑦ Bull + ⑧ Bear
/** Side-by-side bull (emerald) and bear (rose) argument columns; each side self-hides if empty */
const BullBearSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasBull = report.bullPoints && report.bullPoints.length > 0;
  const hasBear = report.bearPoints && report.bearPoints.length > 0;
  if (!hasBull && !hasBear) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="bull-bear">{t('ui.report.bullBearSection')}</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Bull */}
        <div
          className={cn(
            'rounded-lg border p-5',
            hasBull ? 'bg-emerald-900/10 border-emerald-700/40' : 'bg-card/80 border-border',
          )}
        >
          <h3 className="font-serif text-xl font-bold text-emerald-700 dark:text-emerald-400 mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {t('ui.report.bullArgument')}
          </h3>
          {hasBull ? (
            <div className="space-y-4">
              {report.bullPoints!.map((point: BullBearPoint, idx: number) => (
                <div key={point.id ?? idx} className="border-l-2 border-emerald-500/60 pl-4">
                  <h4 className="text-emerald-800 dark:text-emerald-300 font-semibold mb-1">
                    {idx + 1}. {point.title}
                  </h4>
                  <ParagraphBlock content={point.detail} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t('ui.report.noData')}</p>
          )}
        </div>

        {/* Bear */}
        <div
          className={cn(
            'rounded-lg border p-5',
            hasBear ? 'bg-rose-900/10 border-rose-700/40' : 'bg-card/80 border-border',
          )}
        >
          <h3 className="font-serif text-xl font-bold text-rose-700 dark:text-rose-400 mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            {t('ui.report.bearArgument')}
          </h3>
          {hasBear ? (
            <div className="space-y-4">
              {report.bearPoints!.map((point: BullBearPoint, idx: number) => (
                <div key={point.id ?? idx} className="border-l-2 border-rose-500/60 pl-4">
                  <h4 className="text-rose-800 dark:text-rose-300 font-semibold mb-1">
                    {idx + 1}. {point.title}
                  </h4>
                  <ParagraphBlock content={point.detail} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t('ui.report.noData')}</p>
          )}
        </div>
      </div>
    </section>
  );
};

// ⑨ Critic
/** Critic challenges: original claim, the critique, and the revised conclusion; badge shows resolved vs open */
const CriticSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  if (!report.criticPoints || report.criticPoints.length === 0) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="critic">{t('ui.report.criticSection')}</SectionTitle>
      <div className="space-y-4">
        {report.criticPoints.map((point: CriticPoint, idx: number) => (
          <div
            key={point.id ?? idx}
            className="bg-amber-900/10 border border-amber-700/40 rounded-lg p-5"
          >
            <div className="flex items-start justify-between mb-3">
              <h4 className="text-amber-800 dark:text-amber-300 font-semibold">
                {t('ui.report.challenge', { index: idx + 1 })}
              </h4>
              <Badge
                className={cn(
                  point.resolved
                    ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40'
                    : 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/40',
                )}
              >
                {point.resolved ? t('ui.report.resolved') : t('ui.report.unresolved')}
              </Badge>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wider mb-1">
                  {t('ui.report.originalClaim')}
                </p>
                <p className="text-foreground">{point.originalClaim}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wider mb-1">
                  {t('ui.report.challengeContent')}
                </p>
                <p className="text-amber-900 dark:text-amber-200">{point.critique}</p>
              </div>
              {point.revision && (
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wider mb-1">
                    {t('ui.report.revisedConclusion')}
                  </p>
                  <p className="text-foreground/85">{point.revision}</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

// ⑩ Catalysts
/** Chronological catalyst timeline; items are sorted by date and colored by type/impact */
const CatalystsSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  if (!report.catalystsTimeline || report.catalystsTimeline.length === 0) return null;

  // Sort catalysts chronologically (copy first to avoid mutating report data)
  const sorted = [...report.catalystsTimeline].sort(
    (a: CatalystItem, b: CatalystItem) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const catalystTypeLabel: Record<CatalystItem['type'], string> = {
    earnings: t('ui.report.earnings'),
    product: t('ui.report.product'),
    policy: t('ui.report.policy'),
    industry: t('ui.report.industry'),
    other: t('ui.rules.other'),
  };

  const catalystTypeColor: Record<CatalystItem['type'], string> = {
    earnings: 'bg-blue-500/20 text-blue-800 dark:text-blue-300 border-blue-500/40',
    product: 'bg-violet-500/20 text-violet-800 dark:text-violet-300 border-violet-500/40',
    policy: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40',
    industry: 'bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border-cyan-500/40',
    other: 'bg-slate-500/20 text-foreground/85 border-slate-500/40',
  };

  const impactColor: Record<CatalystItem['impact'], string> = {
    positive: 'text-emerald-700 dark:text-emerald-400',
    negative: 'text-rose-700 dark:text-rose-400',
    neutral: 'text-muted-foreground',
  };

  return (
    <section className="mb-16">
      <SectionTitle id="catalysts">{t('ui.report.catalystsSection')}</SectionTitle>
      <div className="relative">
        <div className="absolute left-24 top-0 bottom-0 w-px bg-border" />
        <div className="space-y-5">
          {sorted.map((item: CatalystItem, idx: number) => (
            <div key={item.id ?? idx} className="relative flex gap-6 items-start">
              <div className="w-24 shrink-0 text-right pt-0.5">
                <span className="text-amber-700 dark:text-amber-400 font-mono text-sm font-medium">
                  {item.date}
                </span>
              </div>
              <div className="absolute left-24 top-1.5 -translate-x-1/2 w-3 h-3 rounded-full bg-amber-500 border-2 border-background z-10" />
              <div className="flex-1 pl-4">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h4 className="text-foreground font-semibold">{item.title}</h4>
                  <Badge className={cn('text-[10px]', catalystTypeColor[item.type])}>
                    {catalystTypeLabel[item.type]}
                  </Badge>
                  <span className={cn('text-xs font-medium', impactColor[item.impact])}>
                    {item.impact === 'positive'
                      ? t('ui.report.positive')
                      : item.impact === 'negative'
                        ? t('ui.report.negative')
                        : t('ui.report.neutral')}
                  </span>
                </div>
                {item.detail && (
                  <p className="text-muted-foreground text-sm leading-relaxed">{item.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

// ⑪ Risks
/** Quantified risk table: probability/impact badges (high=rose, medium=amber, low=emerald) and mitigations */
const RisksSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  if (!report.riskItems || report.riskItems.length === 0) return null;

  const levelBadge = (level: 'high' | 'medium' | 'low') => {
    const map = {
      high: {
        label: t('ui.report.high'),
        cls: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/40',
      },
      medium: {
        label: t('ui.report.medium'),
        cls: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40',
      },
      low: {
        label: t('ui.report.low'),
        cls: 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40',
      },
    };
    const m = map[level];
    return <Badge className={m.cls}>{m.label}</Badge>;
  };

  return (
    <section className="mb-16">
      <SectionTitle id="risks">{t('ui.report.riskQuantificationSection')}</SectionTitle>
      <DarkTable>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="text-muted-foreground w-[30%]">
              {t('ui.report.riskItem')}
            </TableHead>
            <TableHead className="text-muted-foreground text-center">
              {t('report.probability')}
            </TableHead>
            <TableHead className="text-muted-foreground text-center">
              {t('ui.report.impact')}
            </TableHead>
            <TableHead className="text-muted-foreground">{t('ui.report.mitigation')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.riskItems.map((item: RiskItem, idx: number) => (
            <TableRow key={item.id ?? idx} className="border-border hover:bg-muted">
              <TableCell className="text-foreground font-medium">{item.risk}</TableCell>
              <TableCell className="text-center">{levelBadge(item.probability)}</TableCell>
              <TableCell className="text-center">{levelBadge(item.impact)}</TableCell>
              <TableCell className="text-muted-foreground">{item.mitigation}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DarkTable>
    </section>
  );
};

// ⑫ Risk Gate
/** Snapshot of risk-gate rule results captured at report generation; emerald row = passed, rose = failed */
const RiskGateSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  if (!report.riskGateSnapshot || report.riskGateSnapshot.length === 0) return null;

  return (
    <section className="mb-16">
      <SectionTitle id="risk-gate">{t('ui.report.riskGateSection')}</SectionTitle>
      <div className="space-y-2">
        {report.riskGateSnapshot.map((result: RiskGateResult, idx: number) => (
          <div
            key={result.id ?? idx}
            className={cn(
              'flex items-center justify-between p-4 rounded-lg border',
              result.passed
                ? 'bg-emerald-900/10 border-emerald-700/30'
                : 'bg-rose-900/10 border-rose-700/30',
            )}
          >
            <div className="flex items-center gap-3">
              <Badge
                className={cn(
                  'w-16 justify-center',
                  result.passed
                    ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40'
                    : 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/40',
                )}
              >
                {result.passed ? t('ui.agent.passed') : t('ui.agent.failedStatus')}
              </Badge>
              <div>
                <p className="text-foreground font-medium">{result.ruleName}</p>
                {result.detail && <p className="text-muted-foreground text-sm">{result.detail}</p>}
              </div>
            </div>
            <div className="text-right text-sm">
              {result.currentValue != null && (
                <p className="text-amber-700 dark:text-amber-400">
                  {t('ui.report.current')}：{result.currentValue}
                </p>
              )}
              {result.thresholdValue != null && (
                <p className="text-muted-foreground">
                  {t('ui.agent.threshold')}：{result.thresholdValue}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

// ⑬ PM Action
/** Portfolio-manager action recommendation: action badge, price range, position size, stop loss, execution plan */
const PmActionSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    report.pmAction ||
    report.pmPriceRange ||
    report.pmPositionSize ||
    report.pmStopLoss ||
    report.pmExecutionPlan;
  if (!hasContent) return null;

  // Picks a badge color by keyword matching against the (Chinese or English) action string
  const actionColor = (action: string | null): string => {
    if (!action) return 'bg-slate-500/20 text-foreground/85 border-slate-500/50';
    const a = action.toLowerCase();
    if (a.includes('买') || a.includes('buy'))
      return 'bg-emerald-600 text-white border-emerald-500';
    if (a.includes('卖') || a.includes('sell')) return 'bg-rose-600 text-white border-rose-500';
    if (a.includes('持') || a.includes('hold'))
      return 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/50';
    return 'bg-slate-500/20 text-foreground/85 border-slate-500/50';
  };

  return (
    <section className="mb-16">
      <SectionTitle id="pm-action">{t('ui.report.pmActionSection')}</SectionTitle>
      <Card className="min-w-0 bg-card border-border">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <CardTitle className="min-w-0 text-foreground">{t('ui.report.actionAdvice')}</CardTitle>
            {report.pmAction && (
              <Badge
                className={cn(
                  'max-w-full whitespace-normal break-words px-3 py-2 text-sm sm:px-6 sm:text-lg',
                  actionColor(report.pmAction),
                )}
              >
                {report.pmAction}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            {report.pmPriceRange && (
              <div className="bg-muted rounded-lg p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {t('ui.report.priceRange')}
                </p>
                <p className="text-amber-700 dark:text-amber-400 font-semibold text-lg">
                  {report.pmPriceRange}
                </p>
              </div>
            )}
            {report.pmPositionSize && (
              <div className="bg-muted rounded-lg p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {t('ui.report.suggestedPosition')}
                </p>
                <p className="text-emerald-700 dark:text-emerald-400 font-semibold text-lg">
                  {report.pmPositionSize}
                </p>
              </div>
            )}
            {report.pmStopLoss && (
              <div className="bg-muted rounded-lg p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {t('ui.report.stopLoss')}
                </p>
                <p className="text-rose-700 dark:text-rose-400 font-semibold text-lg">
                  {report.pmStopLoss}
                </p>
              </div>
            )}
          </div>
          {report.pmExecutionPlan && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                {t('ui.report.executionPlan')}
              </p>
              <ParagraphBlock content={report.pmExecutionPlan} />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
};

// ⑭ Tracking
/** Watch-list metrics (threshold/direction/frequency) and explicit view-change triggers */
const TrackingSection: React.FC<{ report: DeepReport }> = ({ report }) => {
  const { t } = useTranslation();
  const hasContent =
    (report.trackingMetrics && report.trackingMetrics.length > 0) || report.viewChangeTriggers;
  if (!hasContent) return null;

  const directionLabel = (d: TrackingMetric['direction']): string => {
    switch (d) {
      case 'above':
        return t('ui.report.breakoutUp');
      case 'below':
        return t('ui.report.breakoutDown');
      case 'cross':
        return t('ui.report.crossThrough');
      default:
        return d;
    }
  };

  return (
    <section className="mb-16">
      <SectionTitle id="tracking">{t('ui.report.trackingSection')}</SectionTitle>

      {report.trackingMetrics && report.trackingMetrics.length > 0 && (
        <div className="mb-6">
          <SubHeading>{t('report.trackingMetrics')}</SubHeading>
          <DarkTable>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('ui.report.metric')}</TableHead>
                <TableHead className="text-muted-foreground">{t('ui.agent.threshold')}</TableHead>
                <TableHead className="text-muted-foreground">{t('ui.report.direction')}</TableHead>
                <TableHead className="text-muted-foreground">{t('ui.report.frequency')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.trackingMetrics.map((item: TrackingMetric, idx: number) => (
                <TableRow key={idx} className="border-border hover:bg-muted">
                  <TableCell className="text-foreground font-medium">{item.metric}</TableCell>
                  <TableCell className="text-amber-700 dark:text-amber-400 font-medium">
                    {item.threshold}
                  </TableCell>
                  <TableCell className="text-foreground/85">
                    {directionLabel(item.direction)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.frequency}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DarkTable>
        </div>
      )}

      {report.viewChangeTriggers && (
        <div>
          <SubHeading>{t('ui.report.viewChangeConditions')}</SubHeading>
          <ParagraphBlock content={report.viewChangeTriggers} />
        </div>
      )}
    </section>
  );
};

// ─── Main Component ────────────────────────────────────────────────
/**
 * Top-level report layout: sticky desktop TOC + horizontal mobile chips + the
 * 14 rendered sections. The TOC is derived from which sections have data, and an
 * IntersectionObserver highlights the section currently in view.
 */
const DeepReportView: React.FC<DeepReportViewProps> = ({ report, runId, onBack }) => {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);
  const probabilities = formatScenarioProbabilities(report);

  // Build section list based on actual data
  const sections: SectionDef[] = [
    { id: 'analysis-trace', label: t('analysisFlow.traceTitle'), visible: !!report.analysisTrace },
    {
      id: 'executive-summary',
      label: t('ui.report.conclusionSummary'),
      visible:
        !!report.rating ||
        !!report.confidence ||
        !!report.coreThesis ||
        !!report.viewChange ||
        !!report.prevRating,
    },
    {
      id: 'company-business',
      label: t('ui.report.companyBusiness'),
      visible:
        !!report.companyOverview ||
        !!report.businessModel ||
        !!report.moat ||
        (!!report.revenueStructure && report.revenueStructure.length > 0),
    },
    {
      id: 'financial',
      label: t('ui.report.financialDeepDive'),
      visible:
        (!!report.financialAnnual && report.financialAnnual.length > 0) ||
        (!!report.financialQuarterly && report.financialQuarterly.length > 0) ||
        (!!report.profitability && report.profitability.length > 0) ||
        (!!report.cashFlow && report.cashFlow.length > 0) ||
        !!report.financialQuality,
    },
    {
      id: 'segments',
      label: t('ui.report.businessSegments'),
      visible: !!report.segmentAnalysis && report.segmentAnalysis.length > 0,
    },
    {
      id: 'valuation',
      label: t('ui.report.valuation'),
      visible:
        (!!report.valuationRelative && report.valuationRelative.length > 0) ||
        (!!report.valuationSotp && report.valuationSotp.length > 0) ||
        !!report.valuationMethodology,
    },
    {
      id: 'industry',
      label: t('ui.report.industryCompetition'),
      visible:
        !!report.industryOverview ||
        !!report.marketSize ||
        !!report.competitivePosition ||
        !!report.industryTrends,
    },
    {
      id: 'bull-bear',
      label: t('report.bullPoints'),
      visible:
        (!!report.bullPoints && report.bullPoints.length > 0) ||
        (!!report.bearPoints && report.bearPoints.length > 0),
    },
    {
      id: 'critic',
      label: t('ui.report.criticReview'),
      visible: !!report.criticPoints && report.criticPoints.length > 0,
    },
    {
      id: 'catalysts',
      label: t('report.catalystsTimeline'),
      visible: !!report.catalystsTimeline && report.catalystsTimeline.length > 0,
    },
    {
      id: 'risks',
      label: t('ui.report.riskQuantification'),
      visible: !!report.riskItems && report.riskItems.length > 0,
    },
    {
      id: 'risk-gate',
      label: t('ui.report.riskGate'),
      visible: !!report.riskGateSnapshot && report.riskGateSnapshot.length > 0,
    },
    {
      id: 'pm-action',
      label: t('ui.report.pmAction'),
      visible:
        !!report.pmAction ||
        !!report.pmPriceRange ||
        !!report.pmPositionSize ||
        !!report.pmStopLoss ||
        !!report.pmExecutionPlan,
    },
    {
      id: 'tracking',
      label: t('report.trackingMetrics'),
      visible:
        (!!report.trackingMetrics && report.trackingMetrics.length > 0) ||
        !!report.viewChangeTriggers,
    },
  ];

  const visibleSections = sections.filter((s: SectionDef) => s.visible);

  // Scroll spy: highlight the TOC entry whose section is most in view
  // (rootMargin shrinks the active band so it tracks the top reading area)
  useEffect(() => {
    if (visibleSections.length === 0) return;
    setActiveSection(visibleSections[0].id);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length > 0) {
          setActiveSection(visible[0].target.id);
        }
      },
      {
        rootMargin: '-20% 0px -70% 0px',
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    visibleSections.forEach((s: SectionDef) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [visibleSections.length, report.id]);

  // Smooth-scroll to a TOC target; scroll-mt-6 on SectionTitle keeps the heading below the sticky header
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="backdrop-blur-md bg-background/90 border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {onBack && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBack}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <ArrowLeft className="size-5" />
                </Button>
              )}
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="font-serif text-2xl md:text-3xl font-bold text-foreground tracking-tight">
                    {report.ticker}
                  </h1>
                  {report.rating && (
                    <Badge className={cn('text-sm px-3 py-1', ratingColor(report.rating))}>
                      {localizedRating(report.rating, t)}
                    </Badge>
                  )}
                  {report.confidence && (
                    <Badge className={cn('text-xs', confidenceColor(report.confidence))}>
                      {confidenceLabelKey(report.confidence)
                        ? t(confidenceLabelKey(report.confidence)!)
                        : '—'}
                    </Badge>
                  )}
                </div>
                {runId && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono">Run ID: {runId}</p>
                )}
              </div>
            </div>
          </div>

          {/* Three-scenario target prices */}
          {(report.targetBear || report.targetBase || report.targetBull) && (
            <div className="grid grid-cols-3 gap-3 mt-4 w-full">
              <Card className="bg-rose-900/10 border-rose-700/30">
                <CardContent className="p-3 md:p-4">
                  <p className="text-xs text-rose-700/80 dark:text-rose-400/80 uppercase tracking-wider mb-1">
                    {t('ui.report.bearScenario')}
                  </p>
                  <p className="font-serif text-xl md:text-2xl font-bold text-rose-800 dark:text-rose-300">
                    {report.targetBear ?? '—'}
                  </p>
                  {report.probBear != null && (
                    <p className="text-xs text-rose-700/70 dark:text-rose-400/70 mt-0.5">
                      {t('ui.report.probabilityValue', { value: probabilities.probBear })}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="bg-amber-900/10 border-amber-700/30">
                <CardContent className="p-3 md:p-4">
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/80 uppercase tracking-wider mb-1">
                    {t('ui.report.baseScenario')}
                  </p>
                  <p className="font-serif text-xl md:text-2xl font-bold text-amber-800 dark:text-amber-300">
                    {report.targetBase ?? '—'}
                  </p>
                  {report.probBase != null && (
                    <p className="text-xs text-amber-700/70 dark:text-amber-400/70 mt-0.5">
                      {t('ui.report.probabilityValue', { value: probabilities.probBase })}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="bg-emerald-900/10 border-emerald-700/30">
                <CardContent className="p-3 md:p-4">
                  <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 uppercase tracking-wider mb-1">
                    {t('ui.report.bullScenario')}
                  </p>
                  <p className="font-serif text-xl md:text-2xl font-bold text-emerald-800 dark:text-emerald-300">
                    {report.targetBull ?? '—'}
                  </p>
                  {report.probBull != null && (
                    <p className="text-xs text-emerald-700/70 dark:text-emerald-400/70 mt-0.5">
                      {t('ui.report.probabilityValue', { value: probabilities.probBull })}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        {/* Desktop layout: left nav + right content; mobile: stacked */}
        <div className="flex flex-col md:flex-row gap-8">
          {/* Desktop: sticky left nav */}
          <aside className="hidden md:block w-56 md:shrink-0">
            <nav className="sticky top-4">
              <p className="text-xs text-muted-foreground uppercase tracking-widest mb-3 pl-3">
                {t('ui.report.contents')}
              </p>
              <ul className="space-y-1">
                {visibleSections.map((s: SectionDef, idx: number) => (
                  <li key={s.id}>
                    <button
                      onClick={() => scrollToSection(s.id)}
                      className={cn(
                        'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors border-l-2',
                        activeSection === s.id
                          ? 'border-amber-500 text-amber-700 dark:text-amber-400 bg-amber-500/5 font-medium'
                          : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted',
                      )}
                    >
                      <span className="text-xs text-muted-foreground mr-2 font-mono">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          {/* Mobile: horizontal scroll tabs */}
          <div className="md:hidden -mx-4 px-4 mb-6 overflow-x-auto scrollbar-hide order-first">
            <div className="flex gap-2 min-w-max">
              {visibleSections.map((s: SectionDef, idx: number) => (
                <button
                  key={s.id}
                  onClick={() => scrollToSection(s.id)}
                  className={cn(
                    'shrink-0 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors border',
                    activeSection === s.id
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-400 font-medium'
                      : 'bg-card border-border text-muted-foreground',
                  )}
                >
                  <span className="text-muted-foreground mr-1 font-mono">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content area */}
          <main ref={contentRef} className="flex-1 min-w-0">
            {report.analysisTrace && <AnalysisTracePanel trace={report.analysisTrace} />}
            <ExecutiveSummarySection report={report} />
            <CompanyBusinessSection report={report} />
            <FinancialSection report={report} />
            <SegmentsSection report={report} />
            <ValuationSection report={report} />
            <IndustrySection report={report} />
            <BullBearSection report={report} />
            <CriticSection report={report} />
            <CatalystsSection report={report} />
            <RisksSection report={report} />
            <RiskGateSection report={report} />
            <PmActionSection report={report} />
            <TrackingSection report={report} />
          </main>
        </div>
      </div>
    </div>
  );
};

export default DeepReportView;
