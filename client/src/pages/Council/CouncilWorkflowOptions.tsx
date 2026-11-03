import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ResearchGoal } from '@shared/research-workflow.interface';
import { previewResearchMemory } from '@/api/research-memory';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { workflowCopy } from './workflow-copy';

export interface WorkflowDraft { goal: ResearchGoal; peers: string; recallEnabled: boolean; parallelism: 1 | 2 }
export default function CouncilWorkflowOptions({ ticker, value, onChange }: {
  ticker: string; value: WorkflowDraft; onChange: (draft: WorkflowDraft) => void;
}) {
  const { i18n } = useTranslation();
  const copy = workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  const [symbol, setSymbol] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSymbol(ticker.trim().toUpperCase()), 400); return () => clearTimeout(timer); }, [ticker]);
  const memory = useQuery({ queryKey: ['research-memory', 'preview', symbol, value.goal],
    queryFn: () => previewResearchMemory({ ticker: symbol, topic: value.goal }),
    enabled: /^[A-Z0-9][A-Z0-9.^-]{0,19}$/.test(symbol) && value.recallEnabled, retry: false });
  return <div className="space-y-4">
    <div className="space-y-2"><Label htmlFor="research-goal">{copy.goal}</Label>
      <select id="research-goal" value={value.goal} onChange={e => onChange({ ...value, goal: e.target.value as ResearchGoal })}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
        {Object.entries(copy.goals).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></div>
    {(value.goal === 'peers' || value.goal === 'comprehensive') && <div className="space-y-2">
      <Label htmlFor="research-peers">{copy.peers}</Label><Input id="research-peers" placeholder="MSFT, ORCL" maxLength={65}
        value={value.peers} onChange={e => onChange({ ...value, peers: e.target.value })} />
      <p className="text-xs leading-5 text-muted-foreground">{copy.peersHint}</p></div>}
    <div className="space-y-2"><Label className="gap-2"><Switch checked={value.recallEnabled}
      onCheckedChange={recallEnabled => onChange({ ...value, recallEnabled })} />{copy.recall}</Label>
      {value.recallEnabled && symbol && <p className="text-xs text-muted-foreground" role="status">{memory.isError ? copy.memoryFailed
        : memory.isPending ? copy.memoryLoading : !memory.data.preferences.recallEnabled ? copy.memoryOff
          : `${memory.data.items.length} ${copy.memoryCount}`}</p>}
      {value.recallEnabled && !!memory.data?.items.length && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{copy.memoryManage}</summary>
        <ul className="mt-2 space-y-2">{memory.data.items.map(item => <li key={`${item.kind}:${item.id}`}>
          <a className="text-primary underline" href={item.source.url} target="_blank" rel="noreferrer">v{item.source.reportVersion}</a> · {item.summary.slice(0, 180)}
        </li>)}</ul></details>}
    </div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{copy.parallel}: {value.parallelism}</summary>
      <select aria-label={copy.parallel} className="my-2 h-9 rounded border border-input bg-background px-2" value={value.parallelism}
        onChange={e => onChange({ ...value, parallelism: Number(e.target.value) as 1 | 2 })}>
        <option value={1}>{copy.parallelOne}</option><option value={2}>{copy.parallelTwo}</option></select>
      <p className="leading-5">{copy.cost}</p></details>
  </div>;
}
