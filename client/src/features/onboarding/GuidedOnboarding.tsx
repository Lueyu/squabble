import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { fetchHoldings } from '@/api';
import { teamsApi, teamKeys } from '@/api/teams';
import { teamRunsApi } from '@/api/team-runs';
import { Button } from '@/components/ui/button';
import { hasLegacyGuidedProgress, guidedOwnerScope, readGuidedProgress } from '@/features/teams/guided-team-storage';
import { readStoredQuickStart, storedQuickStartResumable } from '@/features/teams/team-quick-start';
import { OnboardingStepper } from './OnboardingStepper';
import { onboardingNext } from './onboarding-state';
import { useAiReadiness } from './use-ai-readiness';

const teamFilter = { status: 'active' } as const;

export default function GuidedOnboarding() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const holdings = useQuery({ queryKey: ['holdings'], queryFn: fetchHoldings, retry: false });
  const teams = useQuery({ queryKey: teamKeys.list(teamFilter), queryFn: () => teamsApi.list(teamFilter), retry: false });
  const team = teams.data?.items[0];
  const run = useQuery({
    queryKey: ['team-run', team?.id],
    queryFn: () => teamRunsApi.status(team!.id),
    enabled: Boolean(team),
    retry: false,
  });
  const hasCreationProgress = storedQuickStartResumable(readStoredQuickStart()) ||
    Boolean(readGuidedProgress(guidedOwnerScope())) || hasLegacyGuidedProgress();
  const agreementState = run.isSuccess ? run.data.agreement?.state ?? null : null;
  const readingConnection = !team && !hasCreationProgress && Boolean(holdings.data?.length);
  const ai = useAiReadiness({ enabled: readingConnection });
  const next = onboardingNext({
    hasHoldings: Boolean(holdings.data?.length),
    connection: ai.connection,
    connectionPath: ai.connectionPath,
    team: team ?? null,
    agreementState,
    latestCycleState: run.isSuccess ? run.data.recentCycles[0]?.state : undefined,
    hasCreationProgress,
  });

  if (!next) return null;
  const readingRun = Boolean(team) && run.isPending;
  const readingHoldings = !team && !hasCreationProgress;
  const pending = teams.isPending || readingRun || readingHoldings && holdings.isPending || readingConnection && ai.pending;
  const failed = teams.isError || Boolean(team) && run.isError || readingHoldings && holdings.isError || readingConnection && ai.error;
  const action = next.step === 'holdings' ? (zh ? '导入我的持仓' : 'Import my holdings')
    : next.step === 'connection' ? (zh ? '连接研究服务' : 'Connect a research service')
    : next.agreementState === 'paused' ? (zh ? '查看并恢复团队' : 'Review and resume team')
    : next.needsAttention ? (zh ? '处理团队运行问题' : 'Resolve a team run issue')
    : team || hasCreationProgress ? (zh ? '继续团队设置' : 'Continue team setup')
    : (zh ? '新建团队模拟盘' : 'Set up a team simulation');

  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="onboarding-title">
    <OnboardingStepper step={next.step} zh={zh} />
    <h2 id="onboarding-title" className="text-lg font-semibold">{zh ? '从我的持仓到团队运行' : 'From your holdings to team runs'}</h2>
    {pending ? <p role="status" className="text-sm text-muted-foreground">{zh ? '正在读取你的进度…' : 'Loading your setup progress…'}</p>
      : failed ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <p>{zh ? '暂时无法读取进度。' : 'Setup progress could not be checked.'}</p>
        <Button size="sm" variant="outline" onClick={() => {
          void holdings.refetch();
          void teams.refetch();
          if (team) void run.refetch();
          if (readingConnection) void ai.reload();
        }}>{zh ? '重试' : 'Retry'}</Button>
      </div>
        : <Button asChild><Link to={next.path}>{action}<ArrowRight size={16} /></Link></Button>}
  </section>;
}
