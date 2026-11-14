import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AgentExecutor, AgentProfile, AgentTemplate, AgentTemplateId, CreateAgentInput } from '@shared/agent-roster.interface';
import type { AnimalAvatarId } from '@shared/animal-avatar';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { LocalAgentConnection } from '@shared/local-agents.interface';
import type { ResearchSourceRef } from '@shared/team-workspace.interface';
import { agentRosterApi } from '@/api/agent-roster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import { AgentCapabilityEditor } from './AgentCapabilityEditor';
import { AnimalAvatarPicker } from './AnimalAvatarPicker';

function GuideSection({ title, items, numbered = false }: { title: string; items: string[]; numbered?: boolean }) {
  return <div className="min-w-0">
    <p className="font-medium text-foreground">{title}</p>
    <ul className={numbered ? 'list-decimal space-y-1 ps-4' : 'list-disc space-y-1 ps-4'}>
      {items.map((item, index) => <li key={index} className="break-words">{item}</li>)}
    </ul>
  </div>;
}

export function AgentEditorDialog({ editing, templates, models, locals, defaultExecutor, zh, initialTemplateId, onClose, onSaved, requestIntent }: {
  editing: AgentProfile | null;
  templates: AgentTemplate[];
  models: ModelConnection[];
  locals: LocalAgentConnection[];
  defaultExecutor: AgentExecutor | null;
  zh: boolean;
  initialTemplateId?: AgentTemplateId;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
  requestIntent?: ReturnType<typeof createRequestIntent>;
}) {
  const initial = editing?.currentVersion.config;
  const [templateId, setTemplateId] = useState<AgentTemplateId>(initial?.templateId ?? initialTemplateId ?? 'financials');
  const template = templates.find(item => item.id === templateId);
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [avatar, setAvatar] = useState<AnimalAvatarId>(editing?.avatar ?? template?.avatar ?? 'technical');
  const [avatarEdited, setAvatarEdited] = useState(false);
  const [instructions, setInstructions] = useState(initial?.instructions ?? (zh ? template?.instructions : template?.instructionsEn) ?? '');
  const [instructionsEdited, setInstructionsEdited] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<AgentTemplate | null>(null);
  const [preferences, setPreferences] = useState(initial?.preferences.userPreferences ?? '');
  const [executor, setExecutor] = useState<AgentExecutor | null>(initial?.executor ?? defaultExecutor);
  const [sources, setSources] = useState<ResearchSourceRef[]>(initial?.allowedSources ?? []);
  const [tools, setTools] = useState<string[] | null>(initial?.allowedToolIds ?? null);
  const [failure, setFailure] = useState('');
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const save = useMutation({ retry: false, mutationFn: async () => {
    if (!executor) throw new Error('AI connection required');
    const payload: Omit<CreateAgentInput, 'requestKey'> = {
      avatar, templateId, executor, name: name.trim() || undefined,
      description: editing ? description : description.trim() || undefined,
      instructions: instructions.trim(), allowedSources: sources,
      preferences: { ...initial?.preferences, language: initial?.preferences.language ?? (zh ? 'zh-CN' : 'en'), userPreferences: preferences },
      ...(tools !== null ? { allowedToolIds: tools } : {}),
      ...(editing && initial?.templateId !== templateId ? { specialty: zh ? template?.specialty : template?.specialtyEn } : {}),
    };
    const requestKey = (requestIntent ?? intent.current).keyFor({ editing: editing?.id, revision: editing?.revision, ...payload });
    return editing
      ? agentRosterApi.update(editing.id, { ...payload, requestKey, expectedRevision: editing.revision })
      : agentRosterApi.create({ ...payload, requestKey });
  }, onSuccess: async () => { await onSaved(); onClose(); }, onError: () => setFailure(zh
    ? '保存结果未确认，输入已保留。请核对名单后重试；版本冲突时重新打开股友。'
    : 'Save is not confirmed. Your input is retained. Check the roster before retrying; reopen the agent after a revision conflict.') });

  function changeTemplate(id: AgentTemplateId) {
    const next = templates.find(item => item.id === id);
    setTemplateId(id);
    if (!instructionsEdited) {
      // Untouched instructions follow the new specialty default; ceiling suggestion follows too.
      setInstructions((zh ? next?.instructions : next?.instructionsEn) ?? '');
      setTools([...(next?.allowedToolIds ?? [])]);
      if (!editing && !avatarEdited && next) setAvatar(next.avatar);
      setPendingTemplate(null);
    } else {
      // Customized instructions are preserved; adopting the new default is an explicit choice.
      setPendingTemplate(next ?? null);
    }
  }
  function adoptPendingTemplate() {
    if (!pendingTemplate) return;
    setInstructions((zh ? pendingTemplate.instructions : pendingTemplate.instructionsEn));
    // Suggestion ceiling applies when the user has not pinned their own tools.
    if (tools === null) setTools([...pendingTemplate.allowedToolIds]);
    if (!editing && !avatarEdited) setAvatar(pendingTemplate.avatar);
    setPendingTemplate(null);
  }

  return <Dialog open onOpenChange={value => { if (!value && !save.isPending) onClose(); }}>
    <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{editing ? (zh ? '了解与调整股友' : 'Edit agent') : (zh ? '添加自己的股友' : 'Add your agent')}</DialogTitle>
        <DialogDescription>{zh
          ? '选个动物头像，再说说希望这位股友怎样帮你。已有团队会保留原来的工作方式。'
          : 'Choose an animal and describe how this agent should help. Existing teams keep their saved working instructions.'}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <AnimalAvatarPicker zh={zh} value={avatar} onChange={value => { setAvatar(value); setAvatarEdited(true); }} />
        <div className="space-y-2">
          <Label htmlFor="agent-template">{zh ? '专长' : 'Specialty'}</Label>
          <select id="agent-template" className="w-full rounded-md border bg-background p-2" value={templateId}
            onChange={event => changeTemplate(event.target.value as AgentTemplateId)}>
            {templates.map(item => <option key={item.id} value={item.id}>{zh ? item.name : item.nameEn}</option>)}
          </select>
        </div>
        {template && <details className="rounded-md border p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1 text-sm font-medium text-foreground">{zh ? '这个专业会怎么做研究' : 'How this specialty researches'}</summary>
          <div className="mt-2 space-y-2">
            <GuideSection title={zh ? '擅长' : 'Strengths'} items={zh ? template.guide.strengths : template.guideEn.strengths} />
            <GuideSection title={zh ? '需要先确认' : 'Required inputs'} items={zh ? template.guide.requiredInputs : template.guideEn.requiredInputs} />
            <GuideSection title={zh ? '研究步骤' : 'Workflow'} items={zh ? template.guide.workflow : template.guideEn.workflow} numbered />
            <GuideSection title={zh ? '标准交付' : 'Output sections'} items={zh ? template.guide.outputSections : template.guideEn.outputSections} />
            <GuideSection title={zh ? '反证与未知' : 'Counterchecks and unknowns'} items={zh ? [...template.guide.counterchecks, ...template.guide.unknownHandling] : [...template.guideEn.counterchecks, ...template.guideEn.unknownHandling]} />
            <GuideSection title={zh ? '示例任务' : 'Example tasks'} items={zh ? template.guide.exampleTasks : template.guideEn.exampleTasks} />
            <GuideSection title={zh ? '通常担任' : 'Typical seats'} items={zh ? template.guide.recommendedSeats : template.guideEn.recommendedSeats} />
            <p>{zh ? '这些是专业预设说明，不代表已获得工具、资料或交易权限。' : 'Preset guidance only; not a grant of tools, data or trading permission.'}</p>
          </div>
        </details>}
        {pendingTemplate && <div role="status" className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <p>{zh ? '你的工作指令已经自定义。改用新专业时，请选择指令和工具上限的处理方式；保存前不会丢弃你的内容。' : 'Your instructions are customized. Choose how to apply the new specialty; nothing is discarded before you save.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={adoptPendingTemplate}>{zh ? '采用新专业默认指令' : 'Adopt new specialty defaults'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingTemplate(null)}>{zh ? '保留我的指令与工具' : 'Keep my instructions and tools'}</Button>
          </div>
        </div>}
        <div className="space-y-2">
          <Label htmlFor="agent-name">{zh ? '名字（可选）' : 'Name (optional)'}</Label>
          <Input id="agent-name" maxLength={80} value={name} onChange={event => setName(event.target.value)}
            placeholder={zh ? template?.name : template?.nameEn} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-instructions">{zh ? '工作指令' : 'Working instructions'}</Label>
          <Textarea id="agent-instructions" value={instructions} maxLength={16000} rows={5}
            onChange={event => { setInstructions(event.target.value); setInstructionsEdited(true); }} />
          <p className="text-xs text-muted-foreground">{zh ? '研究时会使用这些指令；例如关注现金流、区分事实与推断。' : 'These instructions guide research, such as checking cash flow and separating facts from estimates.'}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-preferences">{zh ? '回答偏好（可选）' : 'Response preferences (optional)'}</Label>
          <Textarea id="agent-preferences" maxLength={4000} value={preferences}
            onChange={event => setPreferences(event.target.value)}
            placeholder={zh ? '例如：回答简短，先说明数据缺口。' : 'For example: keep answers concise and explain missing data first.'} />
        </div>
        <details>
          <summary className="cursor-pointer py-1 text-sm">{zh ? '更多：个人介绍与连接' : 'More: introduction and connection'}</summary>
          <div className="mt-3 space-y-3">
            <Label htmlFor="agent-description">{zh ? '个人介绍（仅用于名片）' : 'Introduction (shown on the card)'}</Label>
            <Textarea id="agent-description" value={description} maxLength={4000} onChange={event => setDescription(event.target.value)} />
            <Label htmlFor="agent-connection">{zh ? '复用已保存的连接' : 'Reuse a saved connection'}</Label>
            <select id="agent-connection" className="w-full rounded border bg-background p-2"
              value={executor?.executionMode === 'local' ? `local:${executor.localAgentId}` : executor ? `${executor.executionMode}:${executor.connectionId}` : ''}
              onChange={event => {
                const [mode, id] = event.target.value.split(':');
                if (mode === 'model') {
                  const model = models.find(item => item.id === id);
                  setExecutor({ executionMode: 'model', connectionId: id, model: model?.fastModel ? 'fast' : 'slow' });
                } else if (mode === 'local') setExecutor({ executionMode: 'local', localAgentId: id });
              }}>
              <option value="" disabled>{zh ? '请选择连接' : 'Choose a connection'}</option>
              {models.map(item => <option key={item.id} value={`model:${item.id}`} disabled={!item.available}>{item.name}</option>)}
              {locals.map(item => <option key={item.id} value={`local:${item.id}`} disabled={!item.connected || !item.available}>{item.name}</option>)}
              {executor?.executionMode === 'a2a' && <option value={`a2a:${executor.connectionId}`}>{zh ? '当前外部连接' : 'Current external connection'}</option>}
            </select>
          </div>
        </details>
        <details>
          <summary className="cursor-pointer py-1 text-sm">{zh ? '高级：资料和工具范围' : 'Advanced: data and tool scopes'}</summary>
          <AgentCapabilityEditor zh={zh} sources={sources} tools={tools ?? template?.allowedToolIds ?? []}
            availableTools={templates.flatMap(item => [...item.allowedToolIds])} onSources={setSources} onTools={setTools} />
        </details>
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <Button disabled={save.isPending || !executor || !instructions.trim()} onClick={() => save.mutate()}>
          {save.isPending ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存股友' : 'Save agent')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
