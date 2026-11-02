import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { CouncilConfig, CouncilMember } from '@shared/council.interface';
import {
  COUNCIL_MEMBER_TEMPLATES, COUNCIL_TEAM_PRESETS, councilLanguage, createCouncilMember, createCouncilPreset,
  type CouncilMemberTemplate, type CouncilTemplateId,
} from '@shared/council-templates';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { validateCouncilSettings } from '@/utils/council-state';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import CouncilMemberEditor from './CouncilMemberEditor';
import { assignLocalAgents, useCouncilModels } from './useCouncilModels';
import { Link } from 'react-router-dom';

interface CouncilTeamEditorProps {
  value: CouncilConfig;
  onChange: (value: CouncilConfig) => void;
}

export default function CouncilTeamEditor({ value, onChange }: CouncilTeamEditorProps) {
  const { t, i18n } = useTranslation();
  const language = councilLanguage(i18n.language);
  const webId = useId();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CouncilMember | null>(null);
  const models = useCouncilModels();
  const selectTemplate = (templateId: CouncilTemplateId, custom = false) => {
    if (value.members.length >= 6) return;
    const [member] = assignLocalAgents([createCouncilMember(templateId, i18n.language, `${templateId}-${crypto.randomUUID().replace(/-/gu, '').slice(0, 16)}`)], models.localAgents);
    setEditing(custom ? { ...member, name: '', roleTitle: '', personality: '', instructions: '', researchFocus: [] } : member);
    setAdding(false);
  };
  const saveMember = (member: CouncilMember): string | null => {
    const exists = value.members.some((item: CouncilMember) => item.id === member.id);
    let members = exists ? value.members.map((item: CouncilMember) => item.id === member.id ? member : item) : [...value.members, member];
    if (member.role === 'manager') members = members.map((item: CouncilMember) => item.id !== member.id && item.role === 'manager'
      ? { ...item, role: 'researcher' } : item);
    const problem = validateCouncilSettings({ ...value, enabled: true, members }, undefined);
    if (problem) return t(`council.${problem}`);
    onChange({ ...value, members });
    return null;
  };

  return <div className="space-y-4">
    {models.localAgents.some(agent => agent.available) && value.members.some(member => member.executionMode !== 'local')
      && <Button type="button" variant="secondary" size="sm" className="h-auto min-h-9 whitespace-normal"
        onClick={() => onChange({ ...value, members: assignLocalAgents(value.members, models.localAgents) })}>
        <Bot className="size-4" />{t('council.localAgents.useForTeam')}
      </Button>}
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('council.members.presets')}>
      {COUNCIL_TEAM_PRESETS.map((preset) => <Tooltip key={preset.id}><TooltipTrigger asChild>
        <Button type="button" variant="outline" size="sm" onClick={() => {
          onChange({ ...value, members: assignLocalAgents(createCouncilPreset(preset.id, i18n.language), models.localAgents) }); setAdding(false);
        }}>{preset.name[language]}</Button>
      </TooltipTrigger><TooltipContent>{preset.description[language]}</TooltipContent></Tooltip>)}
    </div>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t('council.members.selected', { count: value.members.length })}</h3>
      <span className="text-[11px] text-muted-foreground">{t('council.members.bounds')}</span>
    </div>
    <div className="space-y-2">
      {value.members.map((member: CouncilMember) => <div key={member.id} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3">
        <CouncilMemberAvatar role={member.role} avatar={member.avatar} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium"><span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{member.name}</span>
            {member.role === 'manager' && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t('council.members.moderator')}</span>}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{member.roleTitle || t(`council.roles.${member.role}`)}</p>
          <p className="mt-1 truncate text-[10px] text-muted-foreground" title={models.memberLabel(member)}>
            {models.memberLabel(member)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t('council.members.editMember', { name: member.name })}
          onClick={() => setEditing(member)}><Pencil className="size-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground"
          disabled={value.members.length <= 2 || member.role === 'manager'}
          title={member.role === 'manager' ? t('council.members.removeModeratorHint') : t('council.members.removeMember', { name: member.name })}
          aria-label={t('council.members.removeMember', { name: member.name })}
          onClick={() => onChange({ ...value, members: value.members.filter((item: CouncilMember) => item.id !== member.id) })}><Trash2 className="size-3.5" /></Button>
      </div>)}
    </div>
    {models.error && <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('council.members.modelsLoadFailed')}</span><Button type="button" variant="ghost" className="h-auto p-0 text-xs text-primary hover:underline" onClick={models.refetch}>{t('council.retry')}</Button>
    </div>}
    {adding ? <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between"><p className="text-sm font-medium">{t('council.members.chooseTemplate')}</p>
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={t('council.close')} onClick={() => setAdding(false)}><X className="size-4" /></Button></div>
      <div className="grid gap-2 sm:grid-cols-2">
        {COUNCIL_MEMBER_TEMPLATES.map((template: CouncilMemberTemplate) => <button key={template.id} type="button" onClick={() => selectTemplate(template.id)}
          className="flex items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          <CouncilMemberAvatar role={template.role} avatar={template.id} className="size-8" />
          <span className="min-w-0"><span className="block text-xs font-medium">{template.text[language].roleTitle}</span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{template.text[language].description}</span></span>
        </button>)}
        <Button type="button" variant="outline" className="h-auto min-h-16 justify-start whitespace-normal text-xs" onClick={() => selectTemplate('value', true)}>
          <Plus className="size-4" />{t('council.members.custom')}</Button>
      </div>
    </div> : <Button type="button" variant="outline" className="w-full border-dashed" disabled={value.members.length >= 6} onClick={() => setAdding(true)}>
      <Plus className="size-4" />{t(value.members.length >= 6 ? 'council.members.full' : 'council.members.add')}
    </Button>}
    {value.members.some(member => member.executionMode === 'local') && <div className="rounded-xl bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
      <p>{t('council.localAgents.toolsHint')}</p>
      <p className="mt-2">{t('council.localAgents.budgetHint')}{' '}
        <Link to="/settings#research-budget" className="text-primary hover:underline">{t('council.budget.open')}</Link></p>
    </div>}
    {value.members.some(member => member.executionMode !== 'local') && <div className="rounded-xl bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-3"><Label htmlFor={webId} className="text-sm">{t('council.members.webResearch')}</Label>
        <Switch id={webId} checked={Boolean(value.webResearch)} onCheckedChange={(enabled: boolean) => onChange({ ...value, webResearch: enabled,
          members: enabled ? value.members : value.members.map((member: CouncilMember) => member.executionMode === 'local' ? member
            : ({ ...member, researchFocus: member.researchFocus?.filter((focus) => focus !== 'web') })) })} /></div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('council.members.webResearchHint')}</p>
    </div>}
    {editing && <CouncilMemberEditor key={editing.id} member={editing} webResearch={Boolean(value.webResearch)}
      modelOptions={models.options} localAgents={models.localAgents} onSave={saveMember} onClose={() => setEditing(null)} />}
  </div>;
}
