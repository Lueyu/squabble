import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { fetchHoldings, fetchCashAccounts } from '@/api';
import { agentRosterApi } from '@/api/agent-roster';
import { teamsApi } from '@/api/teams';
import { teamRunsApi } from '@/api/team-runs';
import { Button } from '@/components/ui/button';
import { onboardingSteps } from './onboarding-state';

/** Saved server facts drive progress; a lost response cannot manufacture a completed step. */
export default function GuidedOnboarding() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const holdings = useQuery({ queryKey: ['onboarding', 'holdings'], queryFn: fetchHoldings });
  const cash = useQuery({ queryKey: ['onboarding', 'cash'], queryFn: fetchCashAccounts });
  const friends = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list });
  const teams = useQuery({ queryKey: ['teams', 'list', {}], queryFn: () => teamsApi.list() });
  const teamIds = teams.data?.items.filter(team => team.status === 'active').map(team => team.id) ?? [];
  const runs = useQuery({ queryKey: ['onboarding', 'team-runs', teamIds], enabled: Boolean(teams.data), queryFn: () => Promise.all(teamIds.map(id => teamRunsApi.status(id))), retry: false });
  if (holdings.isPending || cash.isPending || friends.isPending || teams.isPending || Boolean(teams.data) && runs.isPending) return <p role="status" className="text-sm text-muted-foreground">{zh ? '正在读取开始使用的进度…' : 'Loading your setup progress…'}</p>;
  if (holdings.isError || cash.isError || friends.isError || teams.isError || runs.isError) return <p className="text-sm text-muted-foreground">{zh ? '开始使用进度暂时无法读取，已有记录保留。' : 'Setup progress is temporarily unavailable. Saved records are retained.'} <Link className="underline" to="/friends">{zh ? '查看我的股友' : 'View agents'}</Link></p>;
  const steps = onboardingSteps({ hasHoldings: Boolean(holdings.data?.length || cash.data?.some((row: { balance: string | number | null; reconciliationStatus?: string }) => row.reconciliationStatus === 'confirmed' || row.balance !== null && Number(row.balance) > 0)), hasFriends: Boolean(friends.data?.items.some(row => row.status === 'active')), hasRunningTeam: runs.data?.some(run => run.agreement && run.agreement.state !== 'confirmed') ?? false });
  const next = steps.find(step => !step.complete);
  if (!next) return null;
  return <section className="portfolio-onboarding rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-4" aria-label={zh ? '开始使用' : 'Get started'}>
    <div><h2 className="text-lg font-semibold">{zh ? '三步，建立自己的投研团队' : 'Three steps to your research team'}</h2><p className="text-sm text-muted-foreground mt-1">{zh ? '先了解你的持仓，再认识股友，最后让团队在模拟盘里工作。' : 'Start with your holdings, meet your agents, then let a team work in a simulation.'}</p></div>
    <ol className="grid gap-3 sm:grid-cols-3">{steps.map((step, index) => <li key={step.id} className="rounded-lg border bg-background p-3 flex items-center gap-2 text-sm">{step.complete ? <CheckCircle2 className="text-primary shrink-0" size={18} /> : <span className="rounded-full bg-muted w-6 h-6 text-center leading-6 shrink-0">{index + 1}</span>}<Link to={step.path} className={`inline-flex min-h-6 items-center ${step.id === next.id ? 'font-semibold' : 'text-muted-foreground'}`}>{zh ? step.label : step.labelEn}</Link></li>)}</ol>
    <Button asChild><Link to={next.path}>{zh ? `继续：${next.label}` : `Continue: ${next.labelEn}`}<ArrowRight size={15} /></Link></Button>
    {teams.data?.items.length ? <p className="text-xs text-muted-foreground">{zh ? '已有团队？进入团队概览，核对运行规则后启动。' : 'Already have a team? Review its run agreement in the team overview.'}</p> : null}
  </section>;
}
