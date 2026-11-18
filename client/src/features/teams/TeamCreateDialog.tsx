import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OnboardingStepper } from '@/features/onboarding/OnboardingStepper';
import { readTabRecovery, writeTabRecovery } from '@/utils/workspace-tab-recovery';

const virtualCurrencies = ['CNY', 'USD', 'HKD'] as const;
const defaultCash = { CNY: '10000', USD: '10000', HKD: '10000' };

function persistCreationDraft(draft: TeamCreationDraft, onboarding: boolean) {
  if (onboarding) return writeTabRecovery('team-create', draft);
  try {
    window.sessionStorage.setItem('squabble.team-create', JSON.stringify(draft));
    return true;
  } catch { return false; }
}

export interface TeamCreationDraft { name: string; description: string; avatar: string; mode: 'blank' | 'copy' | 'template'; copyVersionId: string; templateId: string; virtualCash?: Record<string, string>; seedPreviewIntent?: { digest: string; key: string } }
/** Reads the same browser-recovery slot the previous creation dialog used. */
export function readTeamCreationDraft(onboarding = false): TeamCreationDraft | null {
  try {
    if (typeof window === 'undefined') return null;
    const value = onboarding ? readTabRecovery('team-create') as TeamCreationDraft | null
      : JSON.parse(window.sessionStorage.getItem('squabble.team-create') ?? 'null');
    if (!value || typeof value.name !== 'string' || !['blank', 'copy', 'template'].includes(value.mode)) return null;
    return { name: value.name, description: typeof value.description === 'string' ? value.description : '', avatar: typeof value.avatar === 'string' ? value.avatar : '', mode: value.mode, copyVersionId: typeof value.copyVersionId === 'string' ? value.copyVersionId : '', templateId: typeof value.templateId === 'string' ? value.templateId : TEAM_TEMPLATES[0]?.id ?? '', virtualCash: value.virtualCash, seedPreviewIntent: value.seedPreviewIntent };
  } catch { return null; }
}

interface TeamCreateDialogProps {
  open: boolean;
  onboarding?: boolean;
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
export function TeamCreateDialog({ open, onboarding = false, onOpenChange, teams, recovery, copyFrom, onCreate }: TeamCreateDialogProps) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const language = zh ? 'zh-CN' : 'en';
  const [mode, setMode] = useState<'blank' | 'copy' | 'template'>(onboarding ? 'blank' : 'template');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatar, setAvatar] = useState('');
  const [copyVersionId, setCopyVersionId] = useState('');
  const [templateId, setTemplateId] = useState(TEAM_TEMPLATES[0]?.id ?? '');
  const [validation, setValidation] = useState('');
  const [virtualCash, setVirtualCash] = useState<Record<string, string>>(defaultCash);
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const [ack, setAck] = useState(false);
  const intent = useRef<{ digest: string; key: string } | null>(null);
  const reviewTitle = useRef<HTMLDivElement>(null);
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, enabled: open && (onboarding || mode === 'template'), retry: false });
  const cash = virtualCurrencies.map(currency => ({ currency, amount: Number(virtualCash[currency]) }));
  const owned = ownedSpecialtyIds(roster.data?.items ?? []);
  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!name.trim() || name.trim().length > 60) throw new Error(zh ? '请输入 1–60 字符的团队名称。' : 'Enter a team name of 1–60 characters.');
      if (mode === 'copy' && !copyVersionId) throw new Error(zh ? '请选择已发布的来源版本。' : 'Choose a published source version.');
      if (Object.values(virtualCash).some(value => !value.trim()) || !validVirtualCash(cash)) throw new Error(zh ? '请填写三种币种各自有效的非负虚拟金额。' : 'Enter a finite non-negative virtual amount for each currency.');
      const digest = JSON.stringify(cash);
      if (intent.current?.digest !== digest) intent.current = { digest, key: crypto.randomUUID() };
      if (!persistCreationDraft({ name, description, avatar, mode, copyVersionId, templateId, virtualCash, seedPreviewIntent: intent.current }, onboarding) && onboarding) {
        throw new Error(zh ? '无法在此浏览器保留起点核对。' : 'This browser could not retain the starting-point review.');
      }
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
    if (saved) { setMode(saved.mode); setName(saved.name); setDescription(saved.description); setAvatar(saved.avatar); setCopyVersionId(saved.copyVersionId); setTemplateId(saved.templateId || TEAM_TEMPLATES[0]?.id || ''); if (saved.virtualCash) setVirtualCash({ ...defaultCash, ...saved.virtualCash }); intent.current = saved.seedPreviewIntent ?? null; }
  }, [open, recovery, copyFrom, zh]);
  useEffect(() => {
    if (!open || !name.trim()) return;
    persistCreationDraft({ name, description, avatar, mode, copyVersionId, templateId, virtualCash, seedPreviewIntent: intent.current ?? undefined }, onboarding);
    setPreview(null); setAck(false);
  }, [open, onboarding, name, description, avatar, mode, copyVersionId, templateId, virtualCash]);
  useEffect(() => {
    if (onboarding && preview) reviewTitle.current?.focus();
  }, [onboarding, preview]);
  const chooseTemplate = (id: string): void => { setTemplateId(id); const item = TEAM_TEMPLATES.find(candidate => candidate.id === id); if (item && !name.trim()) setName(item.name[language]); };
  const missingFriends = (item: (typeof TEAM_TEMPLATES)[number]): number => (item.staffing ?? []).filter(slot => !owned.has(slot.recommendedTemplateId)).length;
  const template = TEAM_TEMPLATES.find(item => item.id === templateId);
  const content = <>
      {!onboarding && <DialogHeader>
        <DialogTitle>{zh ? '新建研究团队' : 'Create a research team'}</DialogTitle>
        <DialogDescription>{zh ? '每个团队都会新建独立模拟盘：复制实仓持仓，使用可编辑的虚拟本金。确认后创建并关联账户，再配置成员和运行规则；本步骤不发起研究或交易。' : 'Every team gets a new independent paper account: copy real positions and use editable virtual capital. Review creation and binding here, then configure members and run rules; this step starts no research or trades.'}</DialogDescription>
      </DialogHeader>}
      {!preview && <fieldset disabled={create.isPending} className={onboarding ? 'space-y-4' : 'contents'}>
      {onboarding ? <Card>
        <CardContent className="space-y-4 pt-5">
          <label className="team-field"><span>{zh ? '团队名称' : 'Team name'}</span><Input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
          <label className="team-field">
            <span>{zh ? '组织起点' : 'Organization starting point'}</span>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={mode === 'template' ? templateId : mode}
              onChange={event => {
                const value = event.target.value;
                if (value === 'blank' || value === 'copy') setMode(value);
                else { setMode('template'); chooseTemplate(value); }
              }}>
              <option value="blank">{zh ? '空白组织' : 'Blank organization'}</option>
              {TEAM_TEMPLATES.map(item => <option key={item.id} value={item.id}>{item.name[language]}</option>)}
              {teams.some(team => team.currentVersionId) && <option value="copy">{zh ? '复制现有配置' : 'Copy existing configuration'}</option>}
            </select>
          </label>
          {mode === 'copy' && <TeamSelect label={zh ? '来源团队与已发布版本' : 'Source team and published version'} value={copyVersionId} options={[
            { value: '', label: zh ? '请选择已发布配置' : 'Choose a published configuration' },
            ...teams.flatMap(team => team.currentVersionId ? [{ value: team.currentVersionId, label: `${team.name} · v${team.currentVersion}` }] : []),
          ]} onChange={setCopyVersionId} />}
          {roster.isSuccess && roster.data.items.every(friend => friend.status !== 'active')
            ? <p className="text-sm text-muted-foreground">{zh ? '创建后先添加一位股友，再为团队配员。' : 'Add a friend after creation to staff the team.'}</p>
            : <p className="text-sm text-muted-foreground">{zh ? '创建后可以指派已有股友。' : 'Assign saved friends after creation.'}</p>}
        </CardContent>
      </Card> : <>
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
      </>}
      <Card>
        <CardHeader><CardTitle>{zh ? '模拟起点' : 'Simulation starting point'}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{zh ? '持仓复制当前实仓。可用现金采用以下虚拟金额。' : 'Positions copy the current real portfolio. Available cash uses the virtual amounts below.'}</p>
          <div className="grid gap-3 sm:grid-cols-3">{virtualCurrencies.map(currency => <label className="team-field" key={currency}>
            <span>{currency}</span><Input aria-label={zh ? `${currency} 虚拟本金` : `${currency} virtual capital`} type="number" min="0" max="1000000000000" step="0.01"
              value={virtualCash[currency]} disabled={create.isPending} onChange={event => setVirtualCash(current => ({ ...current, [currency]: event.target.value }))} />
          </label>)}</div>
        </CardContent>
      </Card>
      </fieldset>}
      {preview && <><div ref={reviewTitle} tabIndex={-1}><TeamAccountSeedReview preview={preview} zh={zh} compact={onboarding} /></div>{guidedSeedBlockers(preview.needsInput).length > 0 && <TeamNotice error>{zh ? '当前持仓资料或行情尚未齐全，请先核对实仓后重新预览。' : 'Position information or quotes need attention. Review the real portfolio and refresh this seed.'}</TeamNotice>}<label className="team-check-row"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} />{zh ? '已核对持仓及虚拟现金，确认创建团队、发布初始配置并关联新的独立模拟盘。本次不启动研究或交易。' : 'I reviewed positions and virtual cash. Create the team, publish its initial configuration and link a new independent paper account. This does not start research or trades.'}</label></>}
      {(validation || create.isError) && <TeamNotice error>{validation || friendlyError(create.error, zh, { zh: '创建未确认，请使用相同输入核对并重试。', en: 'Creation was not confirmed. Check and retry with the same input.' })}</TeamNotice>}
      <div className="team-dialog-actions">
        <Button variant="outline" disabled={create.isPending} onClick={() => { if (preview) { setPreview(null); setAck(false); intent.current = null; } else onOpenChange(false); }}>{preview ? (zh ? '返回修改起点' : 'Edit starting point') : (zh ? '取消' : 'Cancel')}</Button>
        {!preview ? <Button disabled={create.isPending || !name.trim()} onClick={() => { setValidation(''); create.mutate(); }}>{create.isPending ? (zh ? '正在读取持仓…' : 'Reading positions…') : create.isError ? (zh ? '重读同一持仓预览' : 'Retry the same seed preview') : (zh ? '预览持仓与虚拟本金' : 'Preview positions and virtual capital')}</Button> : <Button disabled={!ack || guidedSeedBlockers(preview.needsInput).length > 0} onClick={() => {
          if (Date.parse(preview.expiresAt) <= Date.now()) { setPreview(null); setAck(false); intent.current = null; setValidation(zh ? '快照已过期，请重新预览后确认。' : 'The snapshot expired. Preview again before confirming.'); return; }
          if (!intent.current) return;
          onCreate({
            name: name.trim(), description: description.trim(), avatar: avatar.trim(), templateId, creationMode: mode,
            ...(mode === 'copy' ? { copyFromTeamVersionId: copyVersionId } : {}),
            onboarding, accountName: '', connectionId: null, seed: { kind: 'holdings', virtualCash: cash },
            reviewedSeed: { previewId: preview.previewId, requestKey: intent.current.key },
          });
        }}>{zh ? '确认创建团队与独立模拟盘' : 'Create team and independent paper account'}</Button>}
      </div>
  </>;

  if (onboarding) return <section className="space-y-4">
    <OnboardingStepper step="team" zh={zh} />
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold sm:text-3xl">{zh ? '新建团队模拟盘' : 'Create a team simulation'}</h1>
      <p className="text-sm text-muted-foreground">{zh ? '以我的实仓为起点，为团队建立独立的模拟账户。' : 'Use your real positions as the starting point for an independent team paper account.'}</p>
    </header>
    {content}
    <Button asChild variant="ghost"><Link to="/teams">{zh ? '返回团队列表' : 'Back to teams'}</Link></Button>
  </section>;

  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next); }}>
    <DialogContent className="team-dialog team-create-dialog">{content}</DialogContent>
  </Dialog>;
}
