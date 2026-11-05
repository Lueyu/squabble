import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BuilderProfile } from '@shared/api.interface';
import type { CouncilConfig } from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { DEFAULT_STRATEGY_AUTOMATION } from '@shared/strategy.interface';
import { createBuilderProfile } from '@/api/builder';
import { DEFAULT_CADENCE, validateCouncilSettings } from '@/utils/council-state';
import CouncilTeamEditor from '@/pages/Council/CouncilTeamEditor';
import { assignLocalAgents, useCouncilModels } from '@/pages/Council/useCouncilModels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Bootstrap the existing Builder contract; creation never activates a profile or publishes a mandate. */
export default function StrategyTeamSetup({ onCreated, onCancel }: { onCreated: (profile: BuilderProfile) => void; onCancel: () => void }) {
  const { i18n } = useTranslation(); const en = i18n.language.startsWith('en');
  const text = (english: string, chinese: string) => en ? english : chinese;
  const models = useCouncilModels();
  const [name, setName] = useState(text('Research execution team', '研究执行团队'));
  const [edited, setEdited] = useState<CouncilConfig | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const council = edited ?? { enabled: true, webResearch: false, members: assignLocalAgents(createCouncilPreset('balanced', i18n.language), models.localAgents) };
  const invalid = validateCouncilSettings(council, DEFAULT_CADENCE);
  const create = async () => {
    if (busy || invalid || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const reviewer = council.members.find(member => member.role === 'challenger') ?? council.members.find(member => member.role !== 'manager')!;
      const profile = await createBuilderProfile({ name: name.trim(), language: en ? 'en' : 'zh-CN', template: 'balanced', tickers: [],
        minimumRating: 'Buy', customPrompt: '', maxOrderPct: 4, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: true,
        council, cadence: { ...DEFAULT_CADENCE }, automation: { ...DEFAULT_STRATEGY_AUTOMATION, enabled: false, fastReviewer: { ...reviewer,
          id: 'fast-reviewer', name: text('Candidate reviewer', '候选复核员'), role: 'challenger' } } });
      onCreated(profile);
    } catch (cause) {
      const problem = cause as { response?: { data?: { message?: string } }; message?: string };
      setError(problem.response?.data?.message ?? problem.message ?? text('Team could not be saved.', '团队保存失败。'));
    } finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4" aria-label={text('Create research team', '创建研究团队')}>
    <div><h3 className="font-medium">{text('Set up your first research team', '配置首个研究团队')}</h3><p className="mt-1 text-xs text-muted-foreground">{text('Start with a value analyst, risk reviewer and moderator. Configure their existing model or native Agent connections below.', '默认包含价值研究、风险审视和主持人。可在下方选择已有模型或本地 Agent 连接。')}</p></div>
    <div><Label htmlFor="strategy-team-name">{text('Team name', '团队名称')}</Label><Input id="strategy-team-name" maxLength={64} value={name} onChange={event => setName(event.target.value)} /></div>
    <CouncilTeamEditor value={council} onChange={setEdited} />
    <p className="text-xs text-muted-foreground">{text('The risk reviewer also handles candidate checks. You can change this in Agent Builder. Connections are checked before publication.', '风险审视成员同时承担候选复核，可在 Agent 配置中调整。发布前会检查连接可用性。')} <Link className="underline" to="/settings/agents">{text('Manage connections', '管理连接')}</Link></p>
    <p className="text-xs text-muted-foreground">{text('This creates a team draft only. Save and review the strategy separately before publishing or starting paper monitoring.', '此操作仅创建团队草稿。策略须另行保存、检查和发布后才会启动模拟监控。')}</p>
    {invalid && <p role="alert" className="text-xs text-destructive">{text('Complete the team settings before saving.', '请补全团队配置后再保存。')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button data-action="create-team-draft" disabled={busy || models.loading || Boolean(invalid) || !name.trim()} onClick={create}>{busy ? text('Saving…', '保存中…') : text('Create team draft', '创建团队草稿')}</Button><Button variant="ghost" disabled={busy} onClick={onCancel}>{text('Cancel', '取消')}</Button></div>
  </section>;
}
