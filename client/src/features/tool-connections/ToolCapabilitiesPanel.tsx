import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Globe, ChartNoAxesCombined, Calculator } from 'lucide-react';
import { activateToolCapabilities, listToolCapabilities, refreshToolCapabilities, revokeToolCapability } from '@/api/tool-capabilities';
import { toolRequestError } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import type { ToolCapabilityView } from '@shared/tool-capabilities.interface';
import { recommendedGrants } from './tool-capability-state';

const icons = { documents: FileText, market_data: ChartNoAxesCombined, browser: Globe, compute: Calculator };
const copy = {
  en: {
    title: 'Tools and capabilities', intro: 'Prepared tools run on your deployment server. Confirm the information they may process once, then use them in research.',
    names: { documents: 'Read documents', market_data: 'Financial data', browser: 'Read web pages', compute: 'Local sandbox and analytics' },
    descriptions: { documents: 'Read PDFs, scanned documents and DOCX with source locations.', market_data: 'Query supported public market data. Symbols and dates are sent to data websites.',
      browser: 'Read public web pages in an anonymous isolated browser.', compute: 'Calculate with fixed templates or exploratory Python in separate containers without network access.' },
    ready: 'Available', unavailable: 'Unavailable', starting: 'Preparing', disabled: 'Needs permission', changed: 'Changes need review',
    local: 'Allow private material and portfolio data to be processed on this deployment server.',
    network: 'Allow public web access and financial queries. Query conditions reveal research interests.',
    boundary: 'This does not authorize private data export to AI/cloud services or external writes. Model permissions and budgets remain in AI settings.',
    enable: 'Enable recommended capabilities', refresh: 'Check preparation', disable: 'Disable', review: 'Review and approve this capability',
    checking: 'Working…', details: 'Technical details', empty: 'No prepared capability information is available.',
  },
  zh: {
    title: '工具与能力', intro: '工具已由部署包准备，在你的部署服务器运行。一次确认可处理的信息，之后即可在研究中使用。',
    names: { documents: '资料阅读', market_data: '金融数据', browser: '网页阅读', compute: '本地沙箱与定量分析' },
    descriptions: { documents: '读取 PDF、扫描文档和 DOCX，保留来源定位。', market_data: '查询已支持的公开金融数据，证券代码与日期会发送到数据网站。',
      browser: '使用隔离匿名浏览器阅读公开网页。', compute: '固定模板或探索 Python 在独立禁网容器中计算。' },
    ready: '可用', unavailable: '不可用', starting: '准备中', disabled: '需要授权', changed: '变更需要审阅',
    local: '允许在本部署服务器处理私有资料和持仓信息。', network: '允许访问公开网页和查询金融数据；查询条件会暴露研究兴趣。',
    boundary: '这里不授权将私有资料外发给 AI/云服务，也不授权外部写入。模型权限和预算仍在 AI 设置中管理。',
    enable: '启用推荐能力', refresh: '检查准备情况', disable: '停用', review: '审阅并确认此能力',
    checking: '处理中…', details: '技术详情', empty: '暂无已准备的能力信息。',
  },
};

export function ToolCapabilitiesPanel({ active = true }: { active?: boolean }) {
  const { i18n } = useTranslation(), text = i18n.language.startsWith('zh') ? copy.zh : copy.en;
  const client = useQueryClient();
  const preparedOnce = useRef(false);
  const [publicNetwork, setPublicNetwork] = useState(true), [privateLocal, setPrivateLocal] = useState(true);
  const query = useQuery({ queryKey: ['tool-capabilities'], queryFn: listToolCapabilities, enabled: active,
    retry: false, refetchOnWindowFocus: false });
  const views = query.data ?? [], grants = recommendedGrants(views, { publicNetwork, privateLocal });
  const operation = useMutation({ mutationFn: (execute: () => Promise<ToolCapabilityView[]>) => execute(), retry: false,
    onSuccess: async result => { client.setQueryData(['tool-capabilities'], result);
      await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
  useEffect(() => {
    if (!active || preparedOnce.current || !query.data?.some(view => view.revision === 0)) return;
    preparedOnce.current = true;
    // Preparation only reads service metadata and creates disabled grants; it never grants permission or probes a model.
    operation.mutate(refreshToolCapabilities);
  }, [active, query.data, operation]);
  const status = (view: ToolCapabilityView) => view.grant === 'review_required' || view.catalog === 'changed' ? text.changed
    : view.installation === 'starting' ? text.starting : view.installation !== 'ready' || view.catalog === 'unavailable'
      ? text.unavailable : view.ready ? text.ready : text.disabled;
  return <section className="min-w-0 space-y-4" aria-label={text.title}>
    <div><h2 className="text-lg font-semibold">{text.title}</h2><p className="mt-2 text-sm text-muted-foreground">{text.intro}</p></div>
    <div className="grid gap-4 md:grid-cols-2">{views.map(view => {
      const Icon = icons[view.packId];
      return <article key={view.packId} className="min-w-0 space-y-3 rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-semibold"><Icon size={18} aria-hidden="true" />{text.names[view.packId]}</h3>
          <span className="text-sm" role="status">{status(view)}</span></div>
        <p className="text-sm text-muted-foreground">{text.descriptions[view.packId]}</p>
        {view.grant === 'enabled' && <Button size="sm" variant="outline" disabled={operation.isPending}
          onClick={() => operation.mutate(() => revokeToolCapability(view.packId, view.revision))}>{text.disable}</Button>}
        {(view.grant === 'review_required' || view.catalog === 'changed') && view.installation === 'ready' && <Button size="sm" variant="outline" disabled={operation.isPending || !publicNetwork && ['browser', 'market_data'].includes(view.packId) || !privateLocal && view.packId === 'documents'}
          onClick={() => operation.mutate(() => activateToolCapabilities({ publicNetwork, grants: [{ packId: view.packId, revision: view.revision,
            manifestHash: view.manifestHash, catalogVersionId: view.catalogVersionId, schemaHash: view.schemaHash,
            dataClasses: privateLocal && ['documents', 'compute'].includes(view.packId) ? ['public', 'private_material', 'portfolio'] : ['public'] }] }))}>{text.review}</Button>}
        <details><summary className="cursor-pointer text-xs text-muted-foreground">{text.details}</summary>
          <div className="mt-2 break-words text-xs text-muted-foreground">{view.reasonCode && <p>{view.reasonCode}</p>}
            <p>{view.manifestVersion} · {view.installation} · {view.catalog}</p>
            {Object.entries(view.facts ?? {}).map(([key, value]) => <p key={key}>{key}: {String(value ?? '—')}</p>)}
            {view.checkedAt && <p>{new Date(view.checkedAt).toLocaleString()}</p>}</div>
        </details>
      </article>;
    })}</div>
    {query.isLoading && <p role="status">{text.checking}</p>}
    {!query.isLoading && !query.isError && !views.length && <p>{text.empty}</p>}
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={privateLocal} onChange={event => setPrivateLocal(event.target.checked)} className="mt-1" />{text.local}</label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={publicNetwork} onChange={event => setPublicNetwork(event.target.checked)} className="mt-1" />{text.network}</label>
      <p className="text-xs leading-5 text-muted-foreground">{text.boundary}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={operation.isPending || !grants.length}
        onClick={() => operation.mutate(() => activateToolCapabilities({ grants, publicNetwork }))}>{operation.isPending ? text.checking : text.enable}</Button>
        <Button variant="outline" disabled={operation.isPending} onClick={() => operation.mutate(refreshToolCapabilities)}>{text.refresh}</Button></div>
    </div>
    {(operation.isError || query.isError) && <p role="alert" className="break-words text-sm text-destructive">{toolRequestError(operation.error ?? query.error)}</p>}
  </section>;
}
