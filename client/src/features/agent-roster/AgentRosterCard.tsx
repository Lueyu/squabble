import { Link } from 'react-router-dom';
import { Archive, MessageSquare } from 'lucide-react';
import type { AgentProfile, AgentTemplate } from '@shared/agent-roster.interface';
import { Button } from '@/components/ui/button';
import { AgentIdentity } from './AgentIdentity';
import { AgentMemoryPanel } from './AgentMemoryPanel';
import { ExternalAgentStatus } from './ExternalAgentStatus';

function GuideList({ title, items, numbered = false }: { title: string; items: string[]; numbered?: boolean }) {
  return <div className="min-w-0">
    <p className="font-medium text-foreground">{title}</p>
    <ul className={numbered ? 'list-decimal space-y-1 ps-4' : 'list-disc space-y-1 ps-4'}>
      {items.map((item, index) => <li key={index} className="break-words">{item}</li>)}
    </ul>
  </div>;
}

export function AgentRosterCard({ agent, zh, template, memoryOpen, archiving, onEdit, onMemory, onArchive }: {
  agent: AgentProfile;
  zh: boolean;
  template?: AgentTemplate;
  memoryOpen: boolean;
  archiving: boolean;
  onEdit: () => void;
  onMemory: () => void;
  onArchive: () => void;
}) {
  const executor = agent.currentVersion.config.executor;
  const guide = template ? (zh ? template.guide : template.guideEn) : null;
  const connectionLabel = executor.executionMode === 'model'
    ? (zh ? '共用模型连接' : 'Shared model connection')
    : executor.executionMode === 'a2a'
      ? (zh ? '外部助手' : 'External agent')
      : (zh ? '本地助手' : 'Local assistant');

  return <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5">
    <div className="flex items-center justify-between gap-2">
      <AgentIdentity avatar={agent.avatar} avatarClassName="size-14" />
      <span className="text-xs rounded-full bg-muted px-2 py-1">
        {agent.availability === 'configured' ? (zh ? '已配置' : 'Configured') : (zh ? '需要连接' : 'Connection needed')}
      </span>
    </div>
    <h2 className="break-words font-semibold text-lg">{agent.name}</h2>
    <p className="break-words text-sm font-medium">{agent.specialty}</p>
    <p className="break-words text-sm text-muted-foreground">{agent.description}</p>
    {template && <p className="break-words text-sm">{zh ? '典型交付' : 'Typical delivery'}：{zh ? template.delivery : template.deliveryEn}</p>}
    {guide && <details className="min-w-0 text-xs text-muted-foreground">
      <summary className="min-h-6 cursor-pointer py-1 font-medium text-foreground">{zh ? '工作方式与专业说明' : 'How this specialty works'}</summary>
      <div className="mt-2 space-y-3">
        <GuideList title={zh ? '工作步骤' : 'Workflow'} items={guide.workflow} numbered />
        <GuideList title={zh ? '反证核查' : 'Counterchecks'} items={guide.counterchecks} />
        <GuideList title={zh ? '典型任务' : 'Example tasks'} items={guide.exampleTasks} />
        <GuideList title={zh ? '推荐岗位' : 'Typical seats'} items={guide.recommendedSeats} />
        <p>{zh ? '以上仅为专业预设说明，不会自动授予资料、工具或交易权限。' : 'Preset guidance only; it grants no data, tool or trading permission.'}</p>
      </div>
    </details>}
    <footer className="mt-auto space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to={`/research?agent=${encodeURIComponent(agent.id)}`}>
            <MessageSquare size={14} />{zh ? '聊一聊' : 'Chat'}
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>{zh ? '了解与调整' : 'Details and edit'}</Button>
        <Button size="sm" variant="ghost" onClick={onMemory}>{zh ? '记忆' : 'Memory'}</Button>
      </div>
      {memoryOpen && <AgentMemoryPanel agent={agent} zh={zh} />}
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-6 cursor-pointer py-1">{zh ? '能力版本与资料范围' : 'Version and data scope'}</summary>
        <p className="mt-2">{zh ? '能力版本' : 'Version'} {agent.currentVersion.version} · {connectionLabel}</p>
        <p>{zh ? '团队内部记忆各自隔离；只使用明确授权的资料和工具。' : 'Team memories are isolated; only explicitly allowed data and tools are used.'}</p>
        {executor.executionMode === 'a2a' && <ExternalAgentStatus connectionId={executor.connectionId} zh={zh} />}
        <p className="mt-2">{zh ? '归档后不能开始新工作，已派发任务按原权限结算。' : 'Archiving stops new work; dispatched tasks settle under existing permissions.'}</p>
        <Button className="mt-2" size="sm" variant="ghost" disabled={archiving} onClick={onArchive}>
          <Archive size={12} />{zh ? '归档股友' : 'Archive agent'}
        </Button>
      </details>
    </footer>
  </article>;
}
