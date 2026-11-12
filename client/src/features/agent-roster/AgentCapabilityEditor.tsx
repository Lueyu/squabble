import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dataLibraryApi } from '@/api/data-library';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import type { ResearchSourceRef } from '@shared/team-workspace.interface';

/** Declarative ceilings only. A selection never enables a source or grants a tool at runtime. */
export function AgentCapabilityEditor({ zh, sources, tools, availableTools, onSources, onTools }: { zh: boolean; sources: ResearchSourceRef[]; tools: readonly string[]; availableTools: readonly string[]; onSources: (value: ResearchSourceRef[]) => void; onTools: (value: string[]) => void }) {
  const [sourceId, setSourceId] = useState('');
  const library = useQuery({ queryKey: ['data-library', 'agent-ceilings'], queryFn: () => dataLibraryApi.list({ limit: 100 }) });
  const detail = useQuery({ queryKey: ['data-library', 'agent-ceiling', sourceId], queryFn: () => dataLibraryApi.detail(sourceId), enabled: Boolean(sourceId) });
  const labels: Record<string, string> = { get_quotes: '查询报价', get_financials: '核对财报', get_portfolio_quotes: '读取本轮持仓报价', get_portfolio_financials: '读取本轮持仓财务', get_valuation: '估值核查', get_research_memory: '读取已授权研究记忆', get_research_report: '读取已授权报告', search_data_library: '检索已授权资料', get_financial_source_data: '查询已配置金融数据', get_discussion_context: '读取本次讨论', read_browser_source: '读取已授权网页来源' };
  return <div className="space-y-4 mt-3"><p className="text-xs text-muted-foreground">{zh ? '这里只设置这位股友的可用范围。资料本身、团队和本次工作仍需分别授权；分享不会解除原来源限制。' : 'These are this agent’s ceilings. Sources, teams and each task still need their own authorization; sharing retains source restrictions.'}</p>
    <fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">{zh ? '可用工具范围' : 'Tool ceiling'}</legend>{[...new Set([...availableTools, ...tools])].map(id => <label className="flex gap-2 text-sm" key={id}><Checkbox checked={tools.includes(id)} onCheckedChange={checked => onTools(checked ? [...tools, id] : tools.filter(value => value !== id))} /><span>{zh ? labels[id] ?? id : id.split('_').join(' ')}</span></label>)}</fieldset>
    <div className="space-y-2"><label className="block text-sm font-medium" htmlFor="agent-private-source">{zh ? '可读取的私有资料版本' : 'Private source versions'}</label><select id="agent-private-source" className="w-full border rounded-md p-2 bg-background" value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">{zh ? '选择已保存的资料' : 'Choose saved material'}</option>{library.data?.items?.filter(source => source.enabled && source.latestVersionId).map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select>{detail.data?.versions.slice(0, 10).map(version => <label key={version.id} className="flex gap-2 text-sm"><Checkbox checked={sources.some(ref => ref.kind === 'document_version' && ref.id === version.id)} disabled={version.extractionState !== 'ready'} onCheckedChange={checked => onSources(checked ? [...sources.filter(ref => ref.id !== version.id), { kind: 'document_version', id: version.id, revision: String(version.version), availability: 'available' }] : sources.filter(ref => ref.id !== version.id))} /><span>v{version.version} · {new Date(version.observedAt).toLocaleString(zh ? 'zh-CN' : 'en')}</span></label>)}</div>
    {sources.length > 0 && <ul className="space-y-2 text-xs">{sources.map(ref => <li key={`${ref.kind}:${ref.id}:${ref.revision}`} className="flex items-start justify-between gap-2 border rounded p-2"><span className="break-all">{ref.kind} · {ref.id} · v{ref.revision}</span><Button size="sm" variant="ghost" onClick={() => onSources(sources.filter(item => item !== ref))}>{zh ? '移除' : 'Remove'}</Button></li>)}</ul>}
    {(library.isError || detail.isError) && <p role="alert" className="text-xs">{zh ? '资料目录暂时无法读取，已有选择保留。请到资料与记忆中核对。' : 'The material catalog is unavailable. Existing selections are retained; check Data & memory.'}</p>}
  </div>;
}
