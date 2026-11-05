import type { TFunction } from 'i18next';
import type { PortfolioReport, PortfolioReportSnapshot } from '@shared/portfolio-report.interface';
import { holdingDataGaps, portfolioEvidenceFact, portfolioReportSections } from '@/utils/portfolio-report';
import PortfolioDailyFactsPanel from './PortfolioDailyFactsPanel';

interface Props {
  report: PortfolioReport;
  snapshot: PortfolioReportSnapshot;
  t: TFunction;
}

export default function PortfolioReportContent({ report, snapshot, t }: Props) {
  return <div className="space-y-6">
    <PortfolioDailyFactsPanel facts={snapshot.dailyFacts} />
    <section aria-labelledby="portfolio-summary" className="rounded-xl border border-border bg-card p-5">
      <h2 id="portfolio-summary" className="font-serif text-xl font-semibold">{t('analysisFlow.portfolio.summary')}</h2>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{report.summary}</p>
    </section>

    <div className="grid gap-4 lg:grid-cols-2">
      {portfolioReportSections(report).map(section => <section key={section.key} className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-serif text-lg font-semibold">{t(`analysisFlow.portfolio.${section.key}`)}</h2>
        {section.values.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6">
          {section.values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
        </ul> : <p className="mt-3 text-sm text-muted-foreground">{t('analysisFlow.portfolio.noItems')}</p>}
      </section>)}
    </div>

    <section aria-labelledby="portfolio-holdings">
      <h2 id="portfolio-holdings" className="font-serif text-xl font-semibold">{t('analysisFlow.portfolio.holdings')}</h2>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {report.holdings.map(holding => <article key={holding.ticker} className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-mono text-lg font-semibold">{holding.ticker}</h3>
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{t(`analysisFlow.portfolio.stance.${holding.stance}`)}</span>
          </div>
          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('analysisFlow.portfolio.rationale')}</h4>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{holding.rationale}</p>
          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('analysisFlow.portfolio.evidence')}</h4>
          {holding.evidenceRefs.length ? <ul className="mt-1 list-disc space-y-2 pl-5 text-sm leading-6">{holding.evidenceRefs.map((ref, index) => {
            const fact = portfolioEvidenceFact(ref, snapshot);
            const suffix = fact?.field === 'weightPct' ? '%' : fact?.field.endsWith('Usd') ? ' USD' : '';
            return <li key={`${index}:${ref}`}>
              {fact && <span>{fact.subject === 'portfolio' ? t('analysisFlow.portfolio.title') : fact.subject}
                {' · '}{t(`analysisFlow.portfolio.fact.${fact.field}`)}: {fact.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}{suffix}
              </span>}
              <code className="block break-all text-xs text-muted-foreground">{ref}</code>
            </li>;
          })}</ul>
            : <p className="mt-1 text-sm text-muted-foreground">{t('analysisFlow.portfolio.noItems')}</p>}
          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('analysisFlow.portfolio.triggers')}</h4>
          {holding.triggers.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6">{holding.triggers.map((trigger, index) => <li key={`${index}:${trigger}`}>{trigger}</li>)}</ul>
            : <p className="mt-1 text-sm text-muted-foreground">{t('analysisFlow.portfolio.noItems')}</p>}
          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('analysisFlow.portfolio.dataGaps')}</h4>
          {holdingDataGaps(snapshot, holding.ticker).length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6">
            {holdingDataGaps(snapshot, holding.ticker).map(gap => <li key={gap}>{['currentPrice', 'costPrice', 'marketValueUsd', 'weightPct'].includes(gap)
              ? t(`analysisFlow.portfolio.field.${gap}`) : gap}</li>)}
          </ul> : <p className="mt-1 text-sm text-muted-foreground">{t('analysisFlow.portfolio.noItems')}</p>}
        </article>)}
      </div>
    </section>
  </div>;
}
