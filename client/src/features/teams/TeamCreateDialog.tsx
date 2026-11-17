import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TEAM_TEMPLATES } from '@shared/team-templates';
import type { TeamSummary } from '@shared/team-workspace.interface';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import { agentRosterApi } from '@/api/agent-roster';
import { previewAiInvestment } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { friendlyError } from '@/utils/error-message';
import { TeamNotice, TeamSelect } from '@/features/teams/TeamPrimitives';
import { ownedSpecialtyIds } from '@/features/teams/team-staffing';
import { quickStartPreviewRequest, validVirtualCash, type QuickStartInput } from './team-quick-start';
import { guidedSeedBlockers } from './guided-team-state';
import { TeamAccountSeedReview } from './TeamAccountSeedReview';

export interface TeamCreationDraft { name: string; description: string; avatar: string; mode: 'blank' | 'copy' | 'template'; copyVersionId: string; templateId: string; virtualCash?: Record<string, string>; seedPreviewIntent?: { digest: string; key: string } }
/** Reads the same browser-recovery slot the previous creation dialog used. */
export function readTeamCreationDraft(): TeamCreationDraft | null {
  try {
    if (typeof window === 'undefined') return null;
    const value = JSON.parse(window.sessionStorage.getItem('squabble.team-create') ?? 'null');
    if (!value || typeof value.name !== 'string' || !['blank', 'copy', 'template'].includes(value.mode)) return null;
    return { name: value.name, description: typeof value.description === 'string' ? value.description : '', avatar: typeof value.avatar === 'string' ? value.avatar : '', mode: value.mode, copyVersionId: typeof value.copyVersionId === 'string' ? value.copyVersionId : '', templateId: typeof value.templateId === 'string' ? value.templateId : TEAM_TEMPLATES[0]?.id ?? '', virtualCash: value.virtualCash, seedPreviewIntent: value.seedPreviewIntent };
  } catch { return null; }
}

interface TeamCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: TeamSummary[];
  recovery?: TeamCreationDraft | null;
  copyFrom?: TeamSummary | null;
  onCreate: (input: QuickStartInput) => void;
}

/**
 * Unified new-team entry: choose one of the eleven organization templates (or a
 * blank/copy starting point), review a frozen real-position/virtual-cash seed,
 * then create one independent paper account and bind it through the durable chain.
 */
export function TeamCreateDialog({ open, onOpenChange, teams, recovery, copyFrom, onCreate }: TeamCreateDialogProps) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const language = zh ? 'zh-CN' : 'en';
  const [mode, setMode] = useState<'blank' | 'copy' | 'template'>('template');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatar, setAvatar] = useState('');
  const [copyVersionId, setCopyVersionId] = useState('');
  const [templateId, setTemplateId] = useState(TEAM_TEMPLATES[0]?.id ?? '');
  const [validation, setValidation] = useState('');
  const [virtualCash, setVirtualCash] = useState<Record<string, string>>({ CNY: '10000', USD: '10000', HKD: '10000' });
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const [ack, setAck] = useState(false);
  const intent = useRef<{ digest: string; key: string } | null>(null);
  const roster = useQuery({ queryKey: ['agent-roster', 'list'], queryFn: agentRosterApi.list, enabled: open && mode === 'template', retry: false });
  const owned = ownedSpecialtyIds(roster.data?.items ?? []);
  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!name.trim() || name.trim().length > 60) throw new Error(zh ? '请输入 1–60 字符的团队名称。' : 'Enter a team name of 1–60 characters.');
      if (mode === 'copy' && !copyVersionId) throw new Error(zh ? '请选择已发布的来源版本。' : 'Choose a published source version.');
      const cash = ['CNY', 'USD', 'HKD'].map(currency => ({ currency: currency as 'CNY' | 'USD' | 'HKD', amount: Number(virtualCash[currency]) }));
      if (Object.values(virtualCash).some(value => !value.trim()) || !validVirtualCash(cash)) throw new Error(zh ? '请填写三种币种各自有效的非负虚拟金额。' : 'Enter a finite non-negative virtual amount for each currency.');
      const digest = JSON.stringify(cash);
      if (intent.current?.digest !== digest) intent.current = { digest, key: crypto.randomUUID() };
      try { window.sessionStorage.setItem('squabble.team-create', JSON.stringify({ name, description, avatar, mode, copyVersionId, templateId, virtualCash, seedPreviewIntent: intent.current } satisfies TeamCreationDraft)); } catch { /* Keep the current dialog available if session storage is unavailable. */ }
      return previewAiInvestment(quickStartPreviewRequest({ kind: 'holdings', virtualCash: cash }, intent.current.key));
    },
    onSuccess: value => { setPreview(value); setAck(false); },
  });
  useEffect(() => {
    if (!open) return;
    if (copyFrom?.currentVersionId) {
      setMode('copy');
      setCopyVersionId(copyFrom.currentVersionId);
      setName(`${copyFrom.name} ${zh ? '副本' : 'copy'}`.slice(0, 60));
      setDescription('');
      setAvatar('');
      return;
    }
    const saved = recovery ?? null;
    if (saved) { setMode(saved.mode); setName(saved.name); setDescription(saved.description); setAvatar(saved.avatar); setCopyVersionId(saved.copyVersionId); setTemplateId(saved.templateId || TEAM_TEMPLATES[0]?.id || ''); if (saved.virtualCash) setVirtualCash({ CNY: '10000', USD: '10000', HKD: '10000', ...saved.virtualCash }); intent.current = saved.seedPreviewIntent ?? null; }
  }, [open, recovery, copyFrom, zh]);
  useEffect(() => {
    if (!open || !name.trim()) return;
    try { window.sessionStorage.setItem('squabble.team-create', JSON.stringify({ name, description, avatar, mode, copyVersionId, templateId, virtualCash, seedPreviewIntent: intent.current ?? undefined } satisfies TeamCreationDraft)); } catch { /* storage unavailable */ }
    setPreview(null); setAck(false);
  }, [open, name, description, avatar, mode, copyVersionId, templateId, virtualCash]);
  const chooseTemplate = (id: string): void => { setTemplateId(id); const item = TEAM_TEMPLATES.find(candidate => candidate.id === id); if (item && !name.trim()) setName(item.name[language]); };
  const missingFriends = (item: (typeof TEAM_TEMPLATES)[number]): number => (item.staffing ?? []).filter(slot => !owned.has(slot.recommendedTemplateId)).length;
  const template = TEAM_TEMPLATES.find(item => item.id === templateId);
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next); }}>
    <DialogContent className="team-dialog team-create-dialog">
      <DialogHeader>
        <DialogTitle>{zh ? '新建研究团队' : 'Create a research team'}</DialogTitle>
        <DialogDescription>{zh ? '每个团队都会新建独立模拟盘：复制实仓持仓，使用可编辑的虚拟本金。确认后创建并关联账户，再配置成员和运行规则；本步骤不发起研究或交易。' : 'Every team gets a new independent paper account: copy real positions and use editable virtual capital. Review creation and binding here, then configure members and run rules; this step starts no research or trades.'}</DialogDescription>
      </DialogHeader>
      {!preview && <fieldset disabled={create.isPending} className="contents">
      <div className="team-mode-tabs" role="group" aria-label={zh ? '创建方式' : 'Creation method'}>
        {(['template', 'blank', 'copy'] as const).map(value => <Button key={value} variant={mode === value ? 'secondary' : 'outline'} aria-pressed={mode === value} disabled={create.isPending} onClick={() => { setMode(value); setValidation(''); create.reset(); }}>{value === 'template' ? (zh ? '选择组织模板' : 'Organization templates') : value === 'blank' ? (zh ? '空白组织' : 'Blank organization') : (zh ? '复制现有配置' : 'Copy a configuration')}</Button>)}
      </div>
      {mode === 'copy' && <TeamSelect label={zh ? '来源团队与已发布版本' : 'Source team and published version'} value={copyVersionId} options={[{ value: '', label: zh ? '请选择已发布配置' : 'Choose a published configuration' }, ...teams.filter(team => team.currentVersionId).map(team => ({ value: team.currentVersionId!, label: `${team.name} · v${team.currentVersion}` }))]} onChange={setCopyVersionId} />}
      {mode === 'template' && <>
        <div className="team-template-grid" role="radiogroup" aria-label={zh ? '选择组织模板' : 'Choose an organization template'}>
          {TEAM_TEMPLATES.map(item => <button key={item.id} type="button" role="radio" aria-checked={templateId === item.id} className={`team-template-card${templateId === item.id ? ' is-selected' : ''}`} onClick={() => chooseTemplate(item.id)}>
            <strong>{item.name[language]}</strong>
            <span>{item.category === 'playful' ? (zh ? '趣味组织' : 'Playful') : (zh ? '专业研究' : 'Professional')} · {item.config.roles.length} {zh ? '岗位' : 'roles'} · {item.config.departments.length} {zh ? '部门' : 'departments'}{roster.data ? ` · ${missingFriends(item) ? (zh ? `缺 ${missingFriends(item)} 位专业股友` : `${missingFriends(item)} friends to match`) : (zh ? '可满员配员' : 'fully matchable')}` : ''}</span>
            <p>{item.description[language]}</p>
          </button>)}
        </div>
        {template && <div className="team-template-preview">
          <h3>{template.name[language]}</h3>
          <p>{template.config.roles.map(role => template.display.roleLabels[role.id]).join(' · ')}</p>
          <p className="team-muted team-small">{zh ? '模板只提供岗位、职责与研究分工起点；配员优先匹配你已有的股友，缺员岗位会保留。模板与配员不会授予资料或工具权限。' : 'Templates only provide seats, responsibilities and a starting division of labour; staffing prefers the friends you already have and keeps unfilled seats. No template grants source or tool permissions.'}</p>
          {template.researchSources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ({source.year}, {zh ? '预印本' : 'preprint'})</a>)}
        </div>}
      </>}
      <div className="team-form-grid">
        <label className="team-field"><span>{zh ? '团队名称 *' : 'Team name *'}</span><Input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
        <label className="team-field"><span>{zh ? '头像标记（选填）' : 'Avatar label (optional)'}</span><Input value={avatar} maxLength={40} onChange={event => setAvatar(event.target.value)} /></label>
      </div>
      <label className="team-field"><span>{zh ? '团队说明' : 'Description'}</span><Textarea value={description} maxLength={500} onChange={event => setDescription(event.target.value)} /></label>
      <fieldset className="rounded-lg border p-4 space-y-3"><legend className="px-1 font-medium">{zh ? '独立模拟盘的虚拟本金' : 'Virtual capital for the new paper account'}</legend><p className="text-sm text-muted-foreground">{zh ? '持仓复制当前实仓，现金仅使用以下虚拟金额，不复制实盘现金。' : 'Positions copy the current real portfolio; cash uses only the virtual amounts below, with no copied real cash.'}</p><div className="grid gap-3 sm:grid-cols-3">{['CNY', 'USD', 'HKD'].map(currency => <label className="team-field" key={currency}><span>{currency}</span><Input aria-label={zh ? `${currency} 虚拟本金` : `${currency} virtual capital`} type="number" min="0" max="1000000000000" step="0.01" value={virtualCash[currency]} disabled={create.isPending} onChange={event => setVirtualCash(current => ({ ...current, [currency]: event.target.value }))} /></label>)}</div></fieldset>
      </fieldset>}
      {preview && <><TeamAccountSeedReview preview={preview} zh={zh} />{guidedSeedBlockers(preview.needsInput).length > 0 && <TeamNotice error>{zh ? '当前持仓资料或行情尚未齐全，请先核对实仓后重新预览。' : 'Position information or quotes need attention. Review the real portfolio and refresh this seed.'}</TeamNotice>}<label className="team-check-row"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} />{zh ? '已核对持仓及虚拟现金，确认创建团队、发布初始配置并关联新的独立模拟盘。本次不启动研究或交易。' : 'I reviewed positions and virtual cash. Create the team, publish its initial configuration and link a new independent paper account. This does not start research or trades.'}</label></>}
      {(validation || create.isError) && <TeamNotice error>{validation || friendlyError(create.error, zh, { zh: '创建未确认，请使用相同输入核对并重试。', en: 'Creation was not confirmed. Check and retry with the same input.' })}</TeamNotice>}
      <div className="team-dialog-actions">
        <Button variant="outline" disabled={create.isPending} onClick={() => { if (preview) { setPreview(null); setAck(false); intent.current = null; } else onOpenChange(false); }}>{preview ? (zh ? '返回修改起点' : 'Edit starting point') : (zh ? '取消' : 'Cancel')}</Button>
        {!preview ? <Button disabled={create.isPending || !name.trim()} onClick={() => { setValidation(''); create.mutate(); }}>{create.isPending ? (zh ? '正在读取持仓…' : 'Reading positions…') : create.isError ? (zh ? '重读同一持仓预览' : 'Retry the same seed preview') : (zh ? '预览持仓与虚拟本金' : 'Preview positions and virtual capital')}</Button> : <Button disabled={!ack || guidedSeedBlockers(preview.needsInput).length > 0} onClick={() => {
          if (Date.parse(preview.expiresAt) <= Date.now()) { setPreview(null); setAck(false); intent.current = null; setValidation(zh ? '快照已过期，请重新预览后确认。' : 'The snapshot expired. Preview again before confirming.'); return; }
          onCreate({ name: name.trim(), description: description.trim(), avatar: avatar.trim(), templateId, creationMode: mode, ...(mode === 'copy' ? { copyFromTeamVersionId: copyVersionId } : {}), accountName: '', connectionId: null, seed: { kind: 'holdings', virtualCash: ['CNY', 'USD', 'HKD'].map(currency => ({ currency: currency as 'CNY' | 'USD' | 'HKD', amount: Number(virtualCash[currency]) })) }, reviewedSeed: { previewId: preview.previewId, requestKey: intent.current!.key } });
        }}>{zh ? '确认创建团队与独立模拟盘' : 'Create team and independent paper account'}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
