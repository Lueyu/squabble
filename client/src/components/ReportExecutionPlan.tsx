import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Clipboard, FlaskConical, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchResearchDocument } from '@/api/research-documents';
import { quickApplyReport } from '@/api/ai-investment';
import { friendlyError } from '@/utils/error-message';
import type { ReportExecutionPlan } from '@shared/report-execution-plan.interface';
import type { StrategyDraftInput } from '@shared/user-investment-strategy.interface';

const READINESS_LABEL: Record<string, { zh: string; en: string }> = {
  ready: { zh: '可执行', en: 'Ready' },
  needs_info: { zh: '待确认', en: 'Needs review' },
  no_trade: { zh: '仅观察', en: 'Observation only' },
};

/** Build a plain-text copy of the strategy so it can be pasted elsewhere. */
function formatPlanText(strategy: StrategyDraftInput): string {
  const lines: string[] = [strategy.title];
  if (strategy.body?.trim()) lines.push('', strategy.body.trim());
  for (const entry of strategy.entries) {
    lines.push(`- ${entry.text}`);
    const directive = entry.directive;
    if (directive) {
      const parts = [
        `${directive.side.toUpperCase()} ${directive.ticker}`,
        directive.quantity ? `qty ${directive.quantity}` : '',
        directive.positionPct ? `${directive.positionPct}%` : '',
        directive.trigger.price ? `trigger ${directive.trigger.price}` : '',
      ].filter(Boolean);
      if (parts.length) lines.push(`  ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * The daily report's execution strategy with a single primary action:
 * apply it to the AI simulation. The text stays copyable, but no multi-step
 * wizard or separate account setup is required from the user.
 */
export default function ReportExecutionPlan({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const documentQuery = useQuery({
    queryKey: ['research-document', versionId],
    queryFn: () => fetchResearchDocument(versionId),
    enabled: Boolean(versionId),
    retry: false,
  });
  const plan: ReportExecutionPlan | undefined = documentQuery.data?.version.snapshot?.executionPlan;

  const copy = async () => {
    if (!plan) return;
    await window.navigator.clipboard.writeText(formatPlanText(plan.strategy));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const apply = async () => {
    setApplying(true);
    try {
      await quickApplyReport({ versionId, requestKey: crypto.randomUUID() });
      setApplied(true);
      toast.success(zh ? '已应用到模拟盘' : 'Applied to the simulation');
      void queryClient.invalidateQueries({ queryKey: ['ai-investment'] });
      void queryClient.invalidateQueries({ queryKey: ['investment-strategies'] });
    } catch (error) {
      toast.error(friendlyError(error, zh, { zh: '应用失败，请稍后重试。', en: 'Apply failed. Please try again.' }));
    } finally {
      setApplying(false);
    }
  };

  // The report has no execution plan: do not render an empty block.
  if (documentQuery.isPending) {
    return <p role="status" className="text-sm text-muted-foreground">{zh ? '正在读取执行策略…' : 'Loading execution strategy…'}</p>;
  }
  if (!plan) return null;

  const text = formatPlanText(plan.strategy);

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">{zh ? '监控执行策略' : 'Monitoring execution strategy'}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {READINESS_LABEL[plan.readiness]?.[zh ? 'zh' : 'en'] ?? plan.readiness}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
          {zh ? '复制' : 'Copy'}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap rounded-xl bg-muted/40 p-4 font-sans text-sm leading-6 text-foreground">
        {text}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void apply()} disabled={applying || applied} className="flex-1 sm:flex-none">
          {applying
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <FlaskConical className="h-4 w-4" />}
          {applied ? (zh ? '已在模拟盘执行' : 'Applied — view simulation') : zh ? '一键应用到模拟盘' : 'Apply to simulation'}
        </Button>
        {applied && (
          <Button variant="outline" onClick={() => navigate('/paper')}>
            {zh ? '查看模拟盘' : 'Open simulation'}
          </Button>
        )}
      </div>
    </section>
  );
}
