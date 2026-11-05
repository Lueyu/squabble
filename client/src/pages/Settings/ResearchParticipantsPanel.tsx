import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchExperiencePreferences, saveExperiencePreferences } from '@/api/simple-experience';
import { fetchLocalAgents } from '@/api/local-agents';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchIntegrationSettings } from '@/api/settings';
import { createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';

export default function ResearchParticipantsPanel() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const client = useQueryClient();
  const preferences = useQuery({ queryKey: ['experience', 'preferences'], queryFn: fetchExperiencePreferences });
  const agents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const models = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const integration = useQuery({ queryKey: ['settings', 'integrations'], queryFn: fetchIntegrationSettings });
  const [draft, setDraft] = useState<string[] | null>(null); const [auto, setAuto] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState(false); const [saved, setSaved] = useState(false);
  const lock = useRef(false); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const selected = draft ?? preferences.data?.defaultMembers ?? [];
  const automatic = auto ?? !(preferences.data?.defaultMembers.length);
  const options = [...(agents.data || []).filter(agent => agent.connected).map(agent => ({ id: agent.id, name: agent.name, detail: `${agent.provider} · ${agent.source === 'native' ? (zh ? '本机客户端' : 'Local client') : (zh ? '已连接客户端' : 'Connected client')}`, available: agent.available })),
    ...(models.data || []).map(model => ({ id: model.id, name: model.name, detail: model.fastModel, available: model.available })),
    ...(integration.data?.llm.available && integration.data.llm.engine !== 'basic' ? [{ id: 'default', name: zh ? '默认模型连接' : 'Default model connection', detail: integration.data.llm.fastModel || integration.data.llm.engine, available: true }] : [])];
  const save = async () => {
    if (lock.current || (!automatic && (!selected.length || selected.length > 3))) return;
    const payload = { defaultMembers: automatic ? [] : selected };
    lock.current = true; setPending(true); setError(false); setSaved(false);
    try { const result = await saveExperiencePreferences({ ...payload, requestKey: intent.current.keyFor(payload) }); client.setQueryData(['experience', 'preferences'], result); setDraft(null); setAuto(null); setSaved(true); intent.current.complete(); }
    catch { setError(true); } finally { setPending(false); lock.current = false; }
  };
  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"><div><h2 className="font-semibold">{zh ? '允许参与研究的 AI' : 'AI connections allowed to research'}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{zh ? '只需在这里选择一次。每次提问直接开始，实际参与来源会在讨论中显示。' : 'Choose once here. Questions start directly, and each discussion shows the actual sources that participated.'}</p></div>
    {preferences.isError || agents.isError || models.isError ? <p role="alert" className="text-sm text-destructive">{zh ? '连接或偏好暂时不可读取，请刷新后再保存。' : 'Connections or preferences are unavailable. Refresh before saving.'}</p> : <>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="radio" name="research-selection" checked={automatic} onChange={() => { setAuto(true); setSaved(false); }} /><span>{zh ? '自动选择最多 3 个可用来源' : 'Automatically select up to 3 available sources'}</span></label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="radio" name="research-selection" checked={!automatic} onChange={() => { setAuto(false); setSaved(false); }} /><span>{zh ? '只允许我勾选的来源参与（最多 3 个）' : 'Allow only selected sources (up to 3)'}</span></label>
      {!automatic && <fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-1 text-xs text-muted-foreground">{zh ? '选择连接' : 'Choose connections'}</legend>{options.map(option => <label key={option.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={selected.includes(option.id)} disabled={!selected.includes(option.id) && selected.length >= 3} onChange={event => { setDraft(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id)); setSaved(false); }} /><span className="min-w-0"><strong className="break-words font-medium">{option.name}</strong><span className="mt-1 block break-words text-xs text-muted-foreground">{option.detail}{!option.available && (zh ? ' · 暂不可用，恢复连接后才参与' : ' · Unavailable; joins after reconnection')}</span></span></label>)}{selected.filter(id => !options.some(option => option.id === id)).map(id => <label className="flex items-center gap-2 text-sm" key={id}><input type="checkbox" checked onChange={() => setDraft(selected.filter(item => item !== id))} /><span className="break-all text-muted-foreground">{zh ? '已断开来源：' : 'Disconnected source: '}{id}</span></label>)}{!options.length && <p className="text-sm text-muted-foreground">{zh ? '连接 AI 后可在这里选择参与者。' : 'Connect an AI source to choose participants here.'}</p>}</fieldset>}
      <p className="text-xs leading-6 text-muted-foreground">{zh ? '一个可用来源时进行单人分析。新股票首次自主买入需要两个实际独立来源复核。' : 'One available source provides single-source analysis. A new stock’s first autonomous purchase requires two actual independent sources.'}</p>
      <Button size="sm" disabled={pending || preferences.isPending || (!automatic && (!selected.length || selected.length > 3))} onClick={() => void save()}>{pending ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存参与范围' : 'Save participation scope')}</Button>
    </>}{error && <p role="alert" className="text-sm text-destructive">{zh ? '未能确认保存，请重试。' : 'Save was not confirmed. Retry.'}</p>}{saved && <p role="status" className="text-sm">{zh ? '已保存，应用于新讨论。' : 'Saved for new discussions.'}</p>}
  </section>;
}
