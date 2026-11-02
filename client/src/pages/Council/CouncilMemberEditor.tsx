import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import type { CouncilMember, CouncilResearchKind, CouncilRole } from '@shared/council.interface';
import { COUNCIL_AVATARS, COUNCIL_RESEARCH_KINDS, COUNCIL_SPEAKING_STYLES } from '@shared/council-templates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import { councilModelValue, type CouncilModelOption } from './useCouncilModels';
import type { LocalAgentConnection } from '@/api/local-agents';
import { AGENT_MODEL_MAX_LENGTH, agentReasoningEfforts, agentSettingsProblem, cleanAgentSettings } from '@/utils/local-agent-settings';

interface CouncilMemberEditorProps {
  member: CouncilMember;
  webResearch: boolean;
  modelOptions: CouncilModelOption[];
  localAgents: LocalAgentConnection[];
  onSave: (member: CouncilMember) => string | null;
  onClose: () => void;
}

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function CouncilMemberEditor({ member, webResearch, modelOptions, localAgents, onSave, onClose }: CouncilMemberEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CouncilMember>({ ...member, researchFocus: [...(member.researchFocus ?? [])] });
  const [error, setError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(Boolean(member.agentSettings?.model
    && !localAgents.find(agent => agent.id === member.agentId)?.models?.some(model => model.id === member.agentSettings?.model)));
  const update = (value: Partial<CouncilMember>) => { setDraft((current) => ({ ...current, ...value })); setError(null); };
  const currentModel = modelOptions.find((option: CouncilModelOption) => option.value === councilModelValue(draft));
  const currentAgent = localAgents.find(agent => agent.id === draft.agentId);
  const agentHelp = currentAgent ? t(`council.localAgents.providerHelp.${currentAgent.provider}`,
    { defaultValue: currentAgent.configurationHelp ?? '' }) : '';
  const agentModels = currentAgent?.models ?? [];
  const modelSupported = currentAgent?.models !== undefined;
  const agentModel = draft.agentSettings?.model ?? '';
  const showCustomModel = customModel || Boolean(agentModel && !agentModels.some(model => model.id === agentModel));
  const reasoningEfforts = agentReasoningEfforts(currentAgent, agentModel);
  const effort = draft.agentSettings?.reasoningEffort ?? '';
  const invalidEffort = Boolean(effort && !reasoningEfforts?.includes(effort));
  const updateAgentModel = (model: string) => update({ agentSettings: {
    model, reasoningEffort: agentReasoningEfforts(currentAgent, model)?.includes(effort) ? effort : undefined,
  } });
  const save = () => {
    if (draft.executionMode === 'local') {
      if (!localAgents.some(agent => agent.id === draft.agentId && agent.available)) {
        setError(t('council.localAgents.unavailable')); return;
      }
      const problem = agentSettingsProblem(draft.agentSettings, currentAgent);
      if (problem) { setError(t(`council.localAgents.${problem}`)); return; }
    } else if (draft.connectionId && (!currentModel || currentModel.disabled)) { setError(t('council.members.connectionMissing')); return; }
    const problem = onSave({ ...draft, name: draft.name.trim(), roleTitle: draft.roleTitle?.trim(), personality: draft.personality?.trim(),
      agentSettings: draft.executionMode === 'local' ? cleanAgentSettings(draft.agentSettings) : undefined });
    if (problem) setError(problem); else onClose();
  };
  const toggleFocus = (focus: CouncilResearchKind) => {
    const current = draft.researchFocus ?? [];
    update({ researchFocus: current.includes(focus) ? current.filter((item) => item !== focus) : [...current, focus] });
  };

  return <Sheet open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
    <SheetContent className="w-[min(480px,96vw)] gap-0 p-0 sm:max-w-[480px]">
      <SheetHeader className="shrink-0 border-b border-border px-5 py-5 pr-12 text-left">
        <SheetTitle>{t('council.members.editTitle')}</SheetTitle><SheetDescription>{t('council.members.editHint')}</SheetDescription>
      </SheetHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); save(); }}>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="space-y-2"><Label>{t('council.members.avatar')}</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('council.members.avatar')}>
              {COUNCIL_AVATARS.map((avatar) => <button type="button" key={avatar} aria-pressed={draft.avatar === avatar}
                aria-label={t(`council.members.avatars.${avatar}`)} title={t(`council.members.avatars.${avatar}`)}
                onClick={() => update({ avatar })} className={`rounded-xl p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring ${draft.avatar === avatar ? 'ring-2 ring-primary' : 'hover:bg-muted'}`}>
                <CouncilMemberAvatar avatar={avatar} role={draft.role} />
              </button>)}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="member-editor-name">{t('council.team.name')}</Label>
              <Input id="member-editor-name" value={draft.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} /></div>
            <div className="space-y-2"><Label htmlFor="member-editor-title">{t('council.members.roleTitle')}</Label>
              <Input id="member-editor-title" value={draft.roleTitle ?? ''} maxLength={60} onChange={(event) => update({ roleTitle: event.target.value })} /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="member-editor-personality">{t('council.members.personality')}</Label>
            <Textarea id="member-editor-personality" rows={2} maxLength={240} value={draft.personality ?? ''}
              placeholder={t('council.members.personalityPlaceholder')} onChange={(event) => update({ personality: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="member-editor-style">{t('council.members.style')}</Label>
            <select id="member-editor-style" className={selectClass} value={draft.speakingStyle ?? 'concise'}
              onChange={(event) => update({ speakingStyle: COUNCIL_SPEAKING_STYLES.find((style) => style === event.target.value) ?? 'concise' })}>
              {COUNCIL_SPEAKING_STYLES.map((style) => <option key={style} value={style}>{t(`council.members.styles.${style}`)}</option>)}
            </select></div>
          <div className="space-y-2"><Label>{t('council.members.focus')}</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('council.members.focus')}>
              {COUNCIL_RESEARCH_KINDS.map((focus) => <Button key={focus} type="button" size="sm"
                variant={draft.researchFocus?.includes(focus) ? 'secondary' : 'outline'} aria-pressed={draft.researchFocus?.includes(focus) ?? false}
                disabled={focus === 'web' && !webResearch && draft.executionMode !== 'local'} onClick={() => toggleFocus(focus)}>
                {draft.researchFocus?.includes(focus) && <Check className="size-3" />}{t(`council.members.focuses.${focus}`)}
              </Button>)}
            </div>
            {draft.executionMode === 'local' ? <p className="text-xs leading-5 text-muted-foreground">{t('council.localAgents.toolsHint')}</p>
              : !webResearch && <p className="text-xs leading-5 text-muted-foreground">{t('council.members.webDisabled')}</p>}
          </div>
          <div className="space-y-2"><Label htmlFor="member-editor-execution">{t('council.localAgents.execution')}</Label>
            <select id="member-editor-execution" className={selectClass} value={draft.executionMode ?? 'model'} onChange={(event) => {
              const executionMode = event.target.value === 'local' ? 'local' : 'model';
              setCustomModel(false);
              update({ executionMode, agentSettings: undefined, ...(executionMode === 'local'
                ? { agentId: draft.agentId ?? localAgents.find(agent => agent.available)?.id, connectionId: undefined }
                : { agentId: undefined, researchFocus: draft.researchFocus?.filter(focus => focus !== 'web' || webResearch) }) });
            }}>
              <option value="local">{t('council.localAgents.routeAgent')}</option>
              <option value="model">{t('council.localAgents.routeModel')}</option>
            </select>
          </div>
          {draft.executionMode === 'local' ? <div className="space-y-2">
            <Label htmlFor="member-editor-agent">{t('council.localAgents.choose')}</Label>
            <select id="member-editor-agent" className={selectClass} value={draft.agentId ?? ''}
              onChange={(event) => { setCustomModel(false); update({ agentId: event.target.value, agentSettings: undefined }); }}>
              {!localAgents.some(agent => agent.id === draft.agentId) && <option value={draft.agentId ?? ''}>{t('council.localAgents.choose')}</option>}
              {localAgents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.name}{!agent.available ? ` · ${t(`council.localAgents.states.${agent.state === 'ready' ? 'offline' : agent.state}`)}`
                  : agent.busy ? ` · ${t('council.localAgents.states.busy')}` : ''}
              </option>)}
            </select>
            {agentHelp && <p className="break-words text-xs leading-5 text-muted-foreground">{agentHelp}</p>}
            <div className="space-y-2 pt-2">
              <Label htmlFor="member-editor-agent-model">{t('council.localAgents.model')}</Label>
              <NativeSelect id="member-editor-agent-model" className="w-full" disabled={!modelSupported}
                value={!modelSupported ? '' : showCustomModel ? '__custom_model__' : agentModel}
                onChange={(event) => {
                  const custom = event.target.value === '__custom_model__';
                  setCustomModel(custom); updateAgentModel(custom ? '' : event.target.value);
                }}>
                <option value="">{t('council.localAgents.inheritDefault')}</option>
                {agentModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                {modelSupported && <option value="__custom_model__">{t('council.localAgents.customModel')}</option>}
              </NativeSelect>
              {modelSupported && showCustomModel && <div className="space-y-2">
                <Label htmlFor="member-editor-agent-custom-model">{t('council.localAgents.modelId')}</Label>
                <Input id="member-editor-agent-custom-model" value={agentModel} maxLength={AGENT_MODEL_MAX_LENGTH}
                  autoComplete="off" spellCheck={false} onChange={(event) => updateAgentModel(event.target.value)}
                  aria-describedby="member-editor-agent-model-hint" />
              </div>}
              <p id="member-editor-agent-model-hint" className="text-xs leading-5 text-muted-foreground">
                {t(!modelSupported ? 'council.localAgents.modelUnsupported'
                  : showCustomModel ? 'council.localAgents.customModelHint' : 'council.localAgents.modelHint')}</p>
              {!modelSupported && agentModel && <Button type="button" size="sm" variant="outline"
                onClick={() => { setCustomModel(false); updateAgentModel(''); }}>{t('council.localAgents.inheritDefault')}</Button>}
            </div>
            <div className="space-y-2 pt-2">
              <Label htmlFor="member-editor-agent-effort">{t('council.localAgents.reasoning')}</Label>
              <NativeSelect id="member-editor-agent-effort" className="w-full" value={invalidEffort ? '' : effort}
                disabled={!reasoningEfforts?.length} aria-describedby="member-editor-agent-effort-hint"
                onChange={(event) => update({ agentSettings: { ...draft.agentSettings, reasoningEffort: event.target.value || undefined } })}>
                <option value="">{t('council.localAgents.inheritDefault')}</option>
                {reasoningEfforts?.map(value => <option key={value} value={value}>
                  {t(`council.localAgents.effortLevels.${value}`, { defaultValue: value })}</option>)}
              </NativeSelect>
              <p id="member-editor-agent-effort-hint" className="text-xs leading-5 text-muted-foreground">
                {t(reasoningEfforts === undefined ? 'council.localAgents.reasoningUnknown'
                  : reasoningEfforts.length ? 'council.localAgents.reasoningHint' : 'council.localAgents.reasoningUnsupported')}</p>
              {invalidEffort && <div className="space-y-2">
                <p className="text-xs text-destructive">{t('council.localAgents.reasoningInvalid')}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => update({
                  agentSettings: { ...draft.agentSettings, reasoningEffort: undefined },
                })}>{t('council.localAgents.inheritDefault')}</Button>
              </div>}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t('council.localAgents.budgetHint')}</p>
            <Link to="/settings#local-agents" className="inline-block text-xs text-primary hover:underline">{t('council.localAgents.manage')}</Link>
          </div> : <div className="space-y-2"><Label htmlFor="member-editor-model">{t('council.model')}</Label>
            <select id="member-editor-model" className={selectClass} value={councilModelValue(draft)} onChange={(event) => {
              const option = modelOptions.find((item: CouncilModelOption) => item.value === event.target.value);
              if (option) update({ connectionId: option.connectionId, model: option.model });
            }}>
              {!currentModel && <option value={councilModelValue(draft)} disabled>{t('council.members.connectionMissing')}</option>}
              {modelOptions.map((option: CouncilModelOption) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
            </select>
            <Link to="/settings" className="inline-block text-xs text-primary hover:underline">{t('council.members.manageModels')}</Link>
          </div>}
          <Collapsible className="rounded-xl border border-border">
            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto min-h-9 w-full justify-between px-3 py-2 text-left text-sm">
              <span className="min-w-0 whitespace-normal">{t('council.members.advanced')}</span><ChevronDown className="size-4" /></Button></CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 px-3 pb-4">
              <div className="space-y-2"><Label htmlFor="member-editor-role">{t('council.members.responsibility')}</Label>
                <select id="member-editor-role" className={selectClass} value={draft.role}
                  onChange={(event) => update({ role: event.target.value as CouncilRole })}>
                  <option value="researcher">{t('council.roles.researcher')}</option>
                  <option value="challenger">{t('council.roles.challenger')}</option>
                  <option value="manager">{t('council.members.moderator')}</option>
                </select><p className="text-xs leading-5 text-muted-foreground">{t('council.members.moderatorHint')}</p>
              </div>
              <div className="space-y-2"><Label htmlFor="member-editor-instructions">{t('council.members.prompt')}</Label>
                <Textarea id="member-editor-instructions" rows={5} maxLength={1000} value={draft.instructions}
                  onChange={(event) => update({ instructions: event.target.value })} />
                <p className="text-xs text-muted-foreground">{t('council.members.promptHint')}</p>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <div className="shrink-0 space-y-3 border-t border-border p-4">
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>{t('council.members.cancel')}</Button>
            <Button type="submit">{t('council.members.save')}</Button></div>
        </div>
      </form>
    </SheetContent>
  </Sheet>;
}
