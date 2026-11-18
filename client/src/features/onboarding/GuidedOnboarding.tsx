import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { TeamSummary } from '@shared/team-workspace.interface';
import type { fetchHoldings } from '@/api';
import { teamsApi, teamKeys } from '@/api/teams';
import { teamRunsApi } from '@/api/team-runs';
import { Button } from '@/components/ui/button';
import { hasLegacyGuidedProgress, guidedOwnerScope, readGuidedProgress } from '@/features/teams/guided-team-storage';
import { readStoredQuickStart, storedQuickStartResumable } from '@/features/teams/team-quick-start';
import { OnboardingStepper } from './OnboardingStepper';
import { onboardingNext } from './onboarding-state';
import { useAiReadiness } from './use-ai-readiness';

const teamFilter = { status: 'active', limit: 100 } as const;

export default function GuidedOnboarding({ holdings, returnTo }: {
  holdings: UseQueryResult<Awaited<ReturnType<typeof fetchHoldings>>>;
  returnTo: string;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const teams = useQuery({
    queryKey: [...teamKeys.list(teamFilter), 'all-pages'],
    queryFn: async () => {
      const items: TeamSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await teamsApi.list({ ...teamFilter, cursor });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    retry: false,
  });
  const items = teams.data ?? [];
  const runs = useQueries({
    queries: items.map(team => ({
      queryKey: ['team-run', team.id],
      queryFn: () => teamRunsApi.status(team.id),
      retry: false,
    })),
  });
  const hasCreationProgress = storedQuickStartResumable(readStoredQuickStart()) ||
    Boolean(readGuidedProgress(guidedOwnerScope())) || hasLegacyGuidedProgress();
  const hasHoldings = Boolean(holdings.data?.length);
  const readingHoldings = !items.length && !hasCreationProgress;
  const readingConnection = teams.isSuccess && readingHoldings && hasHoldings;
  const ai = useAiReadiness({ enabled: readingConnection });

  const teamSteps = items.map((team, index) => {
    const run = runs[index];
    if (!run.isSuccess) return undefined;
    return onboardingNext({
      hasHoldings,
      connection: null,
      connectionPath: ai.connectionPath,
      team,
      agreementState: run.data.agreement?.state ?? null,
      latestCycleState: run.data.recentCycles[0]?.state,
      hasCreationProgress: false,
    });
  });
  if (teamSteps.includes(null)) return null;
  const pending = teams.isPending || runs.some(run => run.isPending) ||
    (readingHoldings && holdings.isPending) || (readingConnection && ai.pending);
  if (pending) return null;
  const existingStep =
    teamSteps.find(step => step?.step === 'team' && step.needsAttention) ??
    teamSteps.find(step => step?.step === 'team' && step.agreementState === 'paused') ??
    teamSteps.find((_, index) => items[index].binding?.state === 'active') ??
    teamSteps.find(Boolean);
  const failed = teams.isError || (!existingStep && runs.some(run => run.isError)) ||
    (readingHoldings && holdings.isError) || (readingConnection && ai.error);
  const next = (hasCreationProgress ? undefined : existingStep) ?? onboardingNext({
    hasHoldings,
    connection: ai.connection,
    connectionPath: ai.connectionPath,
    team: null,
    agreementState: null,
    hasCreationProgress,
  });
  if (!next) return null;

  const action = next.step === 'connection' ? (zh ? '连接研究服务' : 'Connect a research service')
    : next.step === 'holdings' ? null
    : next.agreementState === 'paused' ? (zh ? '查看并恢复团队' : 'Review and resume team')
    : next.needsAttention ? (zh ? '处理团队运行问题' : 'Resolve a team run issue')
    : items.length || hasCreationProgress ? (zh ? '继续团队设置' : 'Continue team setup')
    : (zh ? '新建团队模拟盘' : 'Set up a team simulation');

  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="onboarding-title">
    <OnboardingStepper step={next.step} zh={zh} />
    <h2 id="onboarding-title" className="text-lg font-semibold">{zh ? '从我的持仓到团队运行' : 'From your holdings to team runs'}</h2>
    {failed ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p>{zh ? '暂时无法读取进度。' : 'Setup progress could not be checked.'}</p>
      <Button size="sm" variant="outline" onClick={() => {
        if (holdings.isError) void holdings.refetch();
        if (teams.isError) void teams.refetch();
        runs.filter(run => run.isError).forEach(run => void run.refetch());
        if (readingConnection && ai.error) void ai.reload();
      }}>{zh ? '重试' : 'Retry'}</Button>
    </div>
      : action && <Button asChild><Link to={next.path} state={{ returnTo }}>{action}<ArrowRight size={16} /></Link></Button>}
  </section>;
}
