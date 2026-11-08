import type {
  StrategyDraftInput,
  StrategyExecutionPreview,
  UserInvestmentStrategy,
} from '@shared/user-investment-strategy.interface';
import { businessTime } from '@/utils/strategy-dates';
import { strategyRiskLabels } from './strategy-editor-limits';

interface StrategyExecutionReviewProps {
  item: UserInvestmentStrategy | null;
  prepared: StrategyExecutionPreview | null | undefined;
  content: StrategyDraftInput;
  dirty: boolean;
  readyToApply: boolean;
  zh: boolean;
}

/** Keep the confirmed snapshot visible while a separate draft is edited or prepared. */
export default function StrategyExecutionReview({
  item,
  prepared,
  content,
  dirty,
  readyToApply,
  zh,
}: StrategyExecutionReviewProps) {
  const confirmedPreview = item?.status === 'confirmed' ? item.preview : null;
  const riskLabels = strategyRiskLabels(zh);
  return (
    <>
      {confirmedPreview && (
        <section
          aria-label={zh ? '已确认执行说明' : 'Confirmed execution details'}
          className="space-y-3 rounded-2xl border bg-muted/20 p-4"
        >
          <h3 className="font-semibold">
            {zh ? '已确认执行说明（固定保留）' : 'Confirmed execution details'}
          </h3>
          <p className="text-xs leading-6 text-muted-foreground">
            {zh
              ? '以下是当时确认的执行依据，修改正文不会改变它。另存草稿并重新核对后，才能应用新的说明。'
              : 'This is the confirmed execution authority. Editing the text does not change it. Copy to a draft and review new details before applying.'}
          </p>
          {item?.confirmedAt && (
            <p className="text-xs text-muted-foreground">
              {zh ? '确认于：' : 'Confirmed: '}
              {businessTime(item.confirmedAt, item.content.timezone)}
            </p>
          )}
          {confirmedPreview.entries.map((entry) => (
            <div
              key={entry.id}
              className="space-y-1 rounded-xl bg-background/60 p-3 text-sm leading-7 [overflow-wrap:anywhere]"
            >
              <p>{entry.explanation[zh ? 'zh-CN' : 'en']}</p>
              <p className="text-xs text-muted-foreground">
                {businessTime(entry.startsAt, entry.timezone)} —{' '}
                {businessTime(entry.endsAt, entry.timezone)} · {entry.timezone}
              </p>
            </div>
          ))}
        </section>
      )}
      {prepared && (
        <section
          aria-label={zh ? '执行说明' : 'Execution details'}
          className={`space-y-3 rounded-2xl border p-4 ${dirty ? 'opacity-60' : ''}`}
        >
          <h3 className="font-semibold">{content.title}</h3>
          <p className="text-xs leading-6 text-muted-foreground">
            {zh
              ? '请逐条核对股票、买卖方向、条件与数量。确认应用后，模拟盘以这些说明为依据。'
              : 'Review each security, buy/sell direction, condition and quantity. These details become the execution authority after you apply them.'}
          </p>
          {dirty && (
            <p className="text-sm text-amber-600">
              {zh
                ? '正文已修改，请重新核对说明后再应用。'
                : 'Your text changed. Review refreshed details before applying.'}
            </p>
          )}
          {prepared.entries.map((entry) => (
            <div
              key={entry.id}
              className="space-y-1 rounded-xl bg-muted/30 p-3 text-sm leading-7 [overflow-wrap:anywhere]"
            >
              <p>{entry.explanation[zh ? 'zh-CN' : 'en']}</p>
              <p className="text-xs text-muted-foreground">
                {businessTime(entry.startsAt, entry.timezone)} —{' '}
                {businessTime(entry.endsAt, entry.timezone)} · {entry.timezone}
              </p>
            </div>
          ))}
          {prepared.issues.map((issue, index) => (
            <p
              key={index}
              role={issue.severity === 'error' ? 'alert' : undefined}
              className="text-sm text-amber-600"
            >
              {issue.message[zh ? 'zh-CN' : 'en']}
            </p>
          ))}
        </section>
      )}
      {readyToApply && (
        <section
          aria-label={zh ? '核对风险边界' : 'Risk limits for review'}
          className="space-y-2 rounded-xl bg-primary/5 p-3"
        >
          <h3 className="text-sm font-semibold">
            {zh ? '风险边界' : 'Risk limits'}
          </h3>
          {content.limits ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
              {Object.entries(content.limits).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{riskLabels[key]}</dt>
                  <dd className="mt-1 font-medium">{value}%</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {zh
                ? '仅观察，不自动买卖。'
                : 'Observation only, without automatic trades.'}
            </p>
          )}
        </section>
      )}
    </>
  );
}
