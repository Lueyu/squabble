import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TEAM_TEMPLATES } from '@shared/team-templates';
import type { TeamSummary } from '@shared/team-workspace.interface';
import { agentRosterApi } from '@/api/agent-roster';
import { teamsApi } from '@/api/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { friendlyError } from '@/utils/error-message';
import { TeamNotice, TeamSelect } from '@/features/teams/TeamPrimitives';
import { ownedSpecialtyIds } from '@/features/teams/team-staffing';
import { nextTeamCreateIntent, type TeamCreateIntent } from '@/features/teams/team-create-intent';

export interface TeamCreationDraft { name: string; description: string; avatar: string; mode: 'blank' | 'copy' | 'template'; copyVersionId: string; templateId: string }
/** Reads the same browser-recovery slot the previous creation dialog used. */
export function readTeamCreationDraft(): TeamCreationDraft | null {
  try {
    if (typeof window === 'undefined') return null;
    const value = JSON.parse(window.sessionStorage.getItem('squabble.team-create') ?? 'null');
    if (!value || typeof value.name !== 'string' || !['blank', 'copy', 'template'].includes(value.mode)) return null;
    return { name: value.name, description: typeof value.description === 'string' ? value.description : '', avatar: typeof value.avatar === 'string' ? value.avatar : '', mode: value.mode, copyVersionId: typeof value.copyVersionId === 'string' ? value.copyVersionId : '', templateId: typeof value.templateId === 'string' ? value.templateId : TEAM_TEMPLATES[0]?.id ?? '' };
  } catch { return null; }
}

interface TeamCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: TeamSummary[];
  recovery?: TeamCreationDraft | null;
  copyFrom?: TeamSummary | null;
  onCreated: (teamId: string) => void;
}

/**
 * Unified new-team entry: choose one of the eleven organization templates (or a
 * blank/copy starting point), save it as a draft and continue on the canvas.
 * Creating never publishes, links an account, starts research or calls a model.
 */
export function TeamCreateDialog({ open, onOpenChange, teams, recovery, copyFrom, onCreated }: TeamCreateDialogProps) {
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
  const intent = useRef<TeamCreateIntent | null>(null);
  const roster = useQuery({ queryKey: ['agent-roster', 'list'], queryFn: agentRosterApi.list, enabled: open && mode === 'template', retry: false });
  const owned = ownedSpecialtyIds(roster.data?.items ?? []);
  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!name.trim() || name.trim().length > 60) throw new Error(zh ? '请输入 1–60 字符的团队名称。' : 'Enter a team name of 1–60 characters.');
      if (mode === 'copy' && !copyVersionId) throw new Error(zh ? '请选择已发布的来源版本。' : 'Choose a published source version.');
      const input = { name: name.trim(), description: description.trim(), avatar: avatar.trim() || null, ...(mode === 'copy' ? { copyFromTeamVersionId: copyVersionId } : {}), ...(mode === 'template' ? { templateId } : {}) };
      const next = nextTeamCreateIntent(input, intent.current, 'pending');
      intent.current = next;
      return teamsApi.create({ ...input, requestKey: next!.key });
    },
    onSuccess: team => {
      intent.current = nextTeamCreateIntent({}, intent.current, 'confirmed');
      try { window.sessionStorage.removeItem('squabble.team-create'); } catch { /* storage unavailable */ }
      onOpenChange(false);
      onCreated(team.id);
    },
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
    if (saved) { setMode(saved.mode); setName(saved.name); setDescription(saved.description); setAvatar(saved.avatar); setCopyVersionId(saved.copyVersionId); setTemplateId(saved.templateId || TEAM_TEMPLATES[0]?.id || ''); }
  }, [open, recovery, copyFrom, zh]);
  useEffect(() => {
    if (!open || !name.trim()) return;
    try { window.sessionStorage.setItem('squabble.team-create', JSON.stringify({ name, description, avatar, mode, copyVersionId, templateId } satisfies TeamCreationDraft)); } catch { /* storage unavailable */ }
  }, [open, name, description, avatar, mode, copyVersionId, templateId]);
  const chooseTemplate = (id: string): void => { setTemplateId(id); const item = TEAM_TEMPLATES.find(candidate => candidate.id === id); if (item && !name.trim()) setName(item.name[language]); };
  const missingFriends = (item: (typeof TEAM_TEMPLATES)[number]): number => (item.staffing ?? []).filter(slot => !owned.has(slot.recommendedTemplateId)).length;
  const template = TEAM_TEMPLATES.find(item => item.id === templateId);
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next); }}>
    <DialogContent className="team-dialog team-create-dialog">
      <DialogHeader>
        <DialogTitle>{zh ? '新建研究团队' : 'Create a research team'}</DialogTitle>
        <DialogDescription>{zh ? '选择一个组织模板，保存为草稿后在画布上配置岗位与股友。创建不会发布版本、关联账户或发起研究。' : 'Pick an organization template, save it as a draft and configure seats and friends on the canvas. Creating never publishes, links an account or starts research.'}</DialogDescription>
      </DialogHeader>
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
      {(validation || create.isError) && <TeamNotice error>{validation || friendlyError(create.error, zh, { zh: '创建未确认，请使用相同输入核对并重试。', en: 'Creation was not confirmed. Check and retry with the same input.' })}</TeamNotice>}
      <div className="team-dialog-actions">
        <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>{zh ? '取消' : 'Cancel'}</Button>
        <Button disabled={create.isPending || !name.trim()} onClick={() => { setValidation(''); create.mutate(); }}>{create.isPending ? (zh ? '正在保存…' : 'Saving…') : create.isError ? (zh ? '核对并重试同一创建' : 'Check and retry same creation') : (zh ? '创建组织草稿' : 'Create organization draft')}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
