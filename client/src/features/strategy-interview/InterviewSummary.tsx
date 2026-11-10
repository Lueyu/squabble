import type {
  StrategyInterviewField,
  StrategyInterviewValue,
  StrategyInterviewView,
} from '@shared/strategy-interview.interface';
import { Check, Pencil, CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { interviewDate, interviewFieldLabels } from './interview-state';

export function interviewValueLabel(
  value: StrategyInterviewValue,
  zh: boolean,
): string {
  switch (value.kind) {
    case 'idea':
      return value.text;
    case 'security':
      return `${value.ticker} · ${value.side === 'buy' ? (zh ? '买入' : 'Buy') : zh ? '卖出' : 'Sell'}`;
    case 'amount':
      return value.quantity !== undefined
        ? `${value.quantity} ${zh ? '股' : 'shares'}`
        : `${zh ? '操作后总仓位' : 'Total position after action'} ${value.positionPct}%`;
    case 'frequency':
      return value.frequency === 'once'
        ? zh
          ? '只执行一次'
          : 'Execute once'
        : zh
          ? '每个交易日最多一次'
          : 'At most once per trading day';
    case 'period':
      return `${interviewDate(value.startsAt, value.timezone, zh)} → ${interviewDate(value.endsAt, value.timezone, zh)} (${value.timezone})`;
    case 'condition': {
      const symbols: Record<string, string> = {
        price_lt: '<',
        price_lte: '≤',
        price_gt: '>',
        price_gte: '≥',
      };
      return symbols[value.trigger.kind]
        ? `${zh ? '价格' : 'Price'} ${symbols[value.trigger.kind]} ${value.trigger.price}`
        : value.trigger.kind === 'always'
          ? zh
            ? '在有效期内按已确认频率执行'
            : 'Execute within the effective period at the confirmed frequency'
          : (value.trigger.text ?? (zh ? '继续观察' : 'Observe'));
    }
  }
}

export default function InterviewSummary({
  view,
  zh,
  busy,
  edit,
}: {
  view: StrategyInterviewView;
  zh: boolean;
  busy: boolean;
  edit: (field: StrategyInterviewField, quote: string) => void;
}) {
  return (
    <aside className="interview-summary">
      <div className="interview-eyebrow">
        {zh ? '与你一起确认' : 'Confirmed together'}
      </div>
      <h2>{zh ? '你的想法，逐步变清楚' : 'Your idea, taking shape'}</h2>

      <p className="interview-note">
        {view.account.name} ·{' '}
        {zh ? '只对这个模拟仓生效' : 'For this simulation only'}
      </p>
      <div className="interview-summary-list">
        {view.confirmed.map((answer) => (
          <section key={answer.field}>
            <div className="interview-summary-label">
              <span>
                <Check size={14} />
                {interviewFieldLabels[answer.field][zh ? 0 : 1]}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={
                  (zh ? '修改' : 'Edit ') +
                  interviewFieldLabels[answer.field][zh ? 0 : 1]
                }
                onClick={() => edit(answer.field, answer.quote)}
              >
                <Pencil size={13} />
              </Button>
            </div>
            <strong>{interviewValueLabel(answer.value, zh)}</strong>
            <details>
              <summary>{zh ? '查看你的原话' : 'Your original words'}</summary>
              <blockquote>{answer.quote}</blockquote>
            </details>
          </section>
        ))}
      </div>
      <section className="interview-pending">
        <h3>{zh ? '沿用账户边界' : 'Account limits still apply'}</h3>
        <dl className="interview-note">
          {(
            [
              ['minCashPct', zh ? '最低现金' : 'Minimum cash'],
              ['maxPositionPct', zh ? '单标的上限' : 'Position cap'],
              ['maxOrderPct', zh ? '单笔上限' : 'Order cap'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {Number.isFinite(view.account.limits[key])
                  ? view.account.limits[key] + '%'
                  : '—'}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      {view.pending.length > 0 && (
        <section className="interview-pending">
          <h3>
            <CircleHelp size={15} />
            {zh ? '接下来问清楚' : 'Still to clarify'}
          </h3>
          <ol>
            {view.pending.map((question) => (
              <li key={question.field}>
                {interviewFieldLabels[question.field][zh ? 0 : 1]}
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="interview-note">
        {zh
          ? '只有你点过“确认”的理解才会成为规则。修改原话后，旧预览会失效。'
          : 'Only interpretations you explicitly accept become rules. Editing an answer invalidates the old review.'}
      </p>
    </aside>
  );
}
