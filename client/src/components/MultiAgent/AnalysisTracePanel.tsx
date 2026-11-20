/**
 * @file components/MultiAgent/AnalysisTracePanel.tsx
 * @description 分析过程追溯面板：渲染一次分析（AnalysisTrace）的可解释性记录 ——
 * 引擎标识（basic/llm）、生成时间与语言、按步骤的时间线、证据来源列表
 * （仅 http/https 渲染为外链）与辩论记录折叠区。
 * 上游类型来自 `@shared/api.interface`；被 DeepReportView 在报告首节内嵌渲染。
 */
import { CheckCircle2, CircleDashed, FileSearch, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AnalysisTrace } from '@shared/api.interface';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/utils/format';

/**
 * 校验并归一化来源链接：只放行 http/https 协议的 URL；
 * 空值或解析失败返回 undefined（渲染为纯文本而非可点击链接）。
 */
function publicLink(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 追溯面板主组件。结构：标题行（引擎徽章）-> 引擎/生成信息 -> 步骤时间线 ->
 * 证据来源折叠区（basic 引擎默认展开）-> 辩论记录折叠区（有记录才渲染）。
 * 锚点 id="analysis-trace" 供报告目录（TOC）滚动定位。
 */
export default function AnalysisTracePanel({ trace }: { trace: AnalysisTrace }) {
  const { t } = useTranslation();
  return (
    <section
      id="analysis-trace"
      className="mb-10 scroll-mt-6 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-serif text-xl font-semibold">
          <FileSearch className="size-5 text-primary" />
          {t('analysisFlow.traceTitle')}
        </h2>
        <Badge variant="secondary">
          {t(trace.engine === 'basic' ? 'analysisFlow.basic' : 'analysisFlow.ai')}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t('analysisFlow.traceDescription')}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('analysisFlow.generated', {
          time: formatDateTime(trace.generatedAt),
          language: t(trace.language === 'en' ? 'analysisFlow.english' : 'analysisFlow.chinese'),
        })}
      </p>
      {trace.engine === 'basic' && (
        <p className="mt-4 rounded-lg bg-muted/50 p-3 text-sm leading-relaxed">
          {t('analysisFlow.basicReport')}
        </p>
      )}
      {trace.engine === 'llm' && (
        <p className="mt-3 break-words text-xs text-muted-foreground">
          {t('analysisFlow.provider')}: {trace.provider ?? '—'} · {t('analysisFlow.model')}: {trace.model ?? '—'}
        </p>
      )}
      <ol className="my-5 space-y-4">
        {trace.steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            {step.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{t(`analysisFlow.steps.${step.id}`)}</h3>
                <span className="text-xs text-muted-foreground">
                  {t(`analysisFlow.stepStatus.${step.status}`)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                {step.summary}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <details className="border-t border-border pt-4" open={trace.engine === 'basic'}>
        <summary className="cursor-pointer text-sm font-semibold">
          {t('analysisFlow.sources')} ({trace.evidence.length})
        </summary>
        <div className="mt-3 space-y-3">
          {trace.evidence.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('analysisFlow.noSources')}</p>
          )}
          {trace.evidence.map((evidence) => {
            // 预校验链接：仅 http(s) 才渲染为外链，否则降级为纯文本。
            const href = publicLink(evidence.sourceUrl);
            return (
              <article key={evidence.id} className="min-w-0 rounded-lg border border-border p-3">
                <h4 className="break-words text-sm font-medium">{evidence.title}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                  {evidence.content}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 underline underline-offset-4"
                    >
                      {evidence.sourceName || t('analysisFlow.source')}
                      <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <span>{evidence.sourceName || '—'}</span>
                  )}
                  <span>
                    {t('analysisFlow.sourceDate')}: {formatDateTime(evidence.fetchedAt)}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </details>
      {trace.debate.length > 0 && (
        <details className="mt-4 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {t('analysisFlow.debate')}
          </summary>
          <div className="mt-3 space-y-3">
            {trace.debate.map((item) => (
              <article key={item.id} className="rounded-lg bg-muted/40 p-3">
                <h4 className="text-xs font-medium">
                  {t('analysisFlow.round', { round: item.round })} · {item.speaker}
                </h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {item.content}
                </p>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
