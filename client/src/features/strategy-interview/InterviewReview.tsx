import type { StrategyInterviewExample } from '@shared/strategy-interview.interface';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { Button } from '@/components/ui/button';
import { interviewDate } from './interview-state';

export default function InterviewReview({
  strategy,
  examples,
  zh,
  busy,
  current,
  stage,
  back,
  checkExamples,
  loading = false,
  loadError = false,
  replacesBase = false,
}: {
  strategy?: UserInvestmentStrategy;
  examples: StrategyInterviewExample[];
  zh: boolean;
  busy: boolean;
  current: boolean;
  stage: () => void;
  back: () => void;
  checkExamples: () => void;
  loading?: boolean;
  loadError?: boolean;
  replacesBase?: boolean;
}) {
  const language = zh ? 'zh-CN' : 'en';
  return (
    <section className="interview-conversation-card interview-review">
      <span className="interview-eyebrow">
        {zh ? '3 / 4 · 先核对，再应用' : '3 / 4 · Review before applying'}
      </span>
      <h2>{zh ? '这是不是你的本意？' : 'Does this match your intent?'}</h2>
      {loading ? (
        <p role="status">
          {zh
            ? '正在读取保存的规则与例子…'
            : 'Loading saved rules and examples…'}
        </p>
      ) : loadError ? (
        <div role="alert">
          <p>
            {zh
              ? '无法读取原预览；如规则已变化，请回对话重新核对。'
              : 'Could not read the saved review. If the rules changed, return and review them again.'}
          </p>
          <Button variant="outline" onClick={checkExamples}>
            {zh ? '重新读取原预览' : 'Retry saved review'}
          </Button>
        </div>
      ) : !current ? (
        <p role="alert">
          {zh
            ? '原话或策略已经变化，请返回对话重新生成预览。'
            : 'The conversation or strategy has changed. Return and generate a fresh review.'}
        </p>
      ) : (
        <>
          <h3>{strategy?.content.title}</h3>
          {strategy?.preview?.entries.map((entry) => (
            <article className="interview-reviewed-rule" key={entry.id}>
              <span
                className={'interview-state interview-state-' + entry.state}
              >
                {entry.state === 'executable'
                  ? zh
                    ? '可执行规则'
                    : 'Executable'
                  : entry.state === 'observation'
                    ? zh
                      ? '观察项'
                      : 'Observation'
                    : entry.state === 'expired'
                      ? zh
                        ? '已过期'
                        : 'Expired'
                      : zh
                        ? '仍需核对'
                        : 'Needs review'}
              </span>
              <p>
                {
                  strategy.content.entries.find((item) => item.id === entry.id)
                    ?.text
                }
              </p>
              <p className="interview-note">
                {entry.explanation[language]
                  .replace(
                    entry.startsAt,
                    interviewDate(entry.startsAt, entry.timezone, zh),
                  )
                  .replace(
                    entry.endsAt,
                    interviewDate(entry.endsAt, entry.timezone, zh),
                  )}
              </p>
            </article>
          ))}
          {strategy?.preview?.issues.map((issue, index) => (
            <p
              role={issue.severity === 'error' ? 'alert' : undefined}
              className="interview-note"
              key={issue.code + index}
            >
              {issue.message[language]}
            </p>
          ))}
          <h3>{zh ? '用例子检查规则' : 'Check the rule with examples'}</h3>
          <p className="interview-note">
            {zh
              ? '以下是边界检查，不是历史回测或收益预测。'
              : 'These are rule boundary checks, not a backtest or a return forecast.'}
          </p>
          {replacesBase && (
            <p className="interview-note">
              {zh
                ? '本次修订会在组合草稿里替换原版本，保留原预算并暂时关闭；其他策略不受影响。运行中的组合要等下一步确认应用才会改变。'
                : 'This revision replaces its previous version in the combination draft, retaining its budget but starting disabled. Other strategies stay intact; the running combination changes only after explicit application.'}
            </p>
          )}
          {examples.length ? (
            examples.map((example) => (
              <article key={example.id} className="interview-example">
                <strong>{example.scenario[language]}</strong>
                <span>
                  {example.outcome === 'plan'
                    ? zh
                      ? '进入计划检查'
                      : 'Evaluate a plan'
                    : example.outcome === 'no_action'
                      ? zh
                        ? '不执行'
                        : 'No action'
                      : zh
                        ? '等待'
                        : 'Wait'}
                </span>
                <p>{example.explanation[language]}</p>
              </article>
            ))
          ) : (
            <Button variant="outline" disabled={busy} onClick={checkExamples}>
              {zh ? '加载规则检查例子' : 'Load rule examples'}
            </Button>
          )}
          <p className="interview-note">
            {zh
              ? '下一步只加入这个账户的组合草稿。新策略默认关闭，你还需要分配预算、核对组合并确认应用。'
              : 'Next, add this to the account’s combination draft. A new strategy starts disabled; set a budget, review the combination and explicitly apply it.'}
          </p>
        </>
      )}
      <div className="interview-actions">
        <Button variant="outline" disabled={busy} onClick={back}>
          {zh ? '回去修改' : 'Edit answers'}
        </Button>
        <Button
          disabled={
            busy ||
            loading ||
            loadError ||
            !current ||
            !strategy?.preview?.canConfirm
          }
          onClick={stage}
        >
          {busy
            ? zh
              ? '正在保存…'
              : 'Saving…'
            : zh
              ? '加入组合，继续核对'
              : 'Add to combination & review'}
        </Button>
      </div>
    </section>
  );
}
