import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, RefreshCw } from 'lucide-react';
import { authorizeToolApp, authorizeToolOAuth, completeToolApp, completeToolOAuth, saveToolConnectionWithDiscovery, discoverToolConnection, disconnectToolConnection,
  enableToolConnection, getToolCatalog, getToolCatalogReview, listToolConnections, toolRequestError, updateToolCredential,
  discoverSavedToolConnection, prepareAuthorizedToolConnection,
  type CreateToolConnection, type ToolConnectionView } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToolConnectionEditor } from './ToolConnectionEditor';
import { ToolCatalogReview } from './ToolCatalogReview';
import { ToolActionsPanel } from './ToolActionPreview';
import { useToolConnectionCopy } from './tool-connection-copy';
import { ModelToolCapabilityCard } from './ModelToolCapabilityCard';
import { ToolCapabilitiesPanel } from './ToolCapabilitiesPanel';
import { useTranslation } from 'react-i18next';

function ToolConnectionCard({ connection, active }: { connection: ToolConnectionView; active: boolean }) {
  const copy = useToolConnectionCopy(), client = useQueryClient(), [params] = useSearchParams();
  const [expanded, setExpanded] = useState(false), [credential, setCredential] = useState(''), [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null);
  const [sessionUri, setSessionUri] = useState(params.get('session_uri') ?? '');
  const catalog = useQuery({ queryKey: ['tool-catalog', connection.id], queryFn: () => getToolCatalog(connection.id),
    enabled: active && expanded, retry: false, refetchOnWindowFocus: false });
  const review = useQuery({ queryKey: ['tool-catalog-review', connection.id, connection.candidateCatalogVersionId], queryFn: () => getToolCatalogReview(connection.id),
    enabled: active && expanded && Boolean(connection.candidateCatalogVersionId), retry: false, refetchOnWindowFocus: false });
  const operation = useMutation({ mutationFn: (execute: () => Promise<unknown>) => execute(), retry: false,
    onSuccess: async result => { setCredential('');
      if (result && typeof result === 'object' && 'discoveryError' in result) {
        setMetadataNotice(typeof result.discoveryError === 'string' ? result.discoveryError : null);
        setExpanded(true);
      }
      await client.invalidateQueries({ queryKey: ['tool-connections'] });
      await client.invalidateQueries({ queryKey: ['tool-catalog', connection.id] });
      await client.invalidateQueries({ queryKey: ['tool-catalog-review', connection.id] }); } });
  return <article className="min-w-0 space-y-4 rounded-xl border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="flex items-center gap-2 font-semibold"><Plug size={16} aria-hidden="true" />{connection.provider === 'mcp' ? 'MCP' : connection.provider}</h2>
        {connection.endpoint && <p className="mt-1 break-all text-xs text-muted-foreground">{connection.endpoint}</p>}
        <p className="mt-2 text-sm">{copy.status[connection.status]}</p></div>
      <span className="text-xs text-muted-foreground">{copy.revision} {connection.revision}</span>
    </div>
    <p className="text-xs text-muted-foreground">{connection.hasCredential ? copy.keySaved : copy.noKey} · {copy.enabled}: {connection.allowedToolIds.length}<br />
      {copy.verified}: {connection.verifiedAt ? new Date(connection.verifiedAt).toLocaleString() : copy.never}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={operation.isPending || connection.status === 'unconfigured' || connection.status === 'authorization_required'}
        onClick={() => operation.mutate(async () => { const result = await discoverToolConnection(connection.id);
          client.setQueryData(['tool-catalog', connection.id], result.catalog); setExpanded(true); })}><RefreshCw size={14} />{copy.discover}</Button>
      <Button variant="ghost" size="sm" onClick={() => setExpanded(value => !value)}>{copy.catalog}</Button>
      <Button variant="ghost" size="sm" disabled={operation.isPending || connection.status === 'unconfigured'} onClick={() => operation.mutate(() => disconnectToolConnection(connection.id))}>{copy.disconnect}</Button>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{copy.discoverHint}</p>
    {connection.authKind === 'oauth' && <Button variant="outline" size="sm" disabled={operation.isPending}
      onClick={() => operation.mutate(async () => setAuthorizationUrl((await authorizeToolOAuth(connection.id)).authorizationUrl))}>{copy.authorize}</Button>}
    {authorizationUrl && <p><a href={authorizationUrl} target="_blank" rel="noreferrer noopener" className="text-sm underline">{copy.authLink}</a></p>}
    {connection.provider === 'composio' && <div className="space-y-3 border-t pt-4">
      <p className="text-xs text-muted-foreground">{copy.authHint}</p>
      <Button variant="outline" size="sm" disabled={operation.isPending} onClick={() => operation.mutate(async () => setAuthorizationUrl((await authorizeToolApp(connection.id)).authorizationUrl))}>{copy.authorize}</Button>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); operation.mutate(async () => discoverSavedToolConnection(await completeToolApp(connection.id, sessionUri))); }}>
        <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${connection.id}-session`}>{copy.sessionUri}</Label>
          <Input id={`${connection.id}-session`} required value={sessionUri} onChange={event => setSessionUri(event.target.value)} autoComplete="off" /></div>
        <Button type="submit" size="sm" variant="outline" disabled={operation.isPending || !sessionUri}>{copy.completeAuth}</Button>
      </form>
    </div>}
    <details className="border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{copy.replaceKey}</summary>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); operation.mutate(async () => discoverSavedToolConnection(await updateToolCredential(connection.id, { revision: connection.revision, credential }))); }}>
        <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${connection.id}-key`}>{copy.credential}</Label>
          <Input id={`${connection.id}-key`} type="password" autoComplete="new-password" required value={credential} onChange={event => setCredential(event.target.value)} /></div>
        <Button type="submit" variant="outline" size="sm" disabled={operation.isPending || !credential}>{copy.save}</Button>
      </form>
    </details>
    {operation.isError && <p role="alert" className="break-words text-sm text-destructive">{copy.error}: {toolRequestError(operation.error)}</p>}
    {metadataNotice && <p role="alert" className="break-words text-sm text-destructive">{copy.discover}: {metadataNotice}</p>}
    {expanded && catalog.isLoading && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
    {expanded && catalog.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(catalog.error)}</p>}
    {expanded && catalog.data === null && <p className="text-sm text-muted-foreground">{copy.toolsEmpty}</p>}
    {expanded && catalog.data && <ToolCatalogReview connection={connection} catalog={catalog.data} pending={operation.isPending}
      changes={review.data?.changes}
      onEnable={(toolIds, dataClasses, effects) => operation.mutate(() => enableToolConnection(connection.id, { revision: connection.revision,
        catalogVersionId: catalog.data!.id, schemaHash: catalog.data!.schemaHash, toolIds, dataClasses, effects }))} />}
  </article>;
}

export default function ToolConnectionsPanel({ active = true }: { active?: boolean }) {
  const copy = useToolConnectionCopy(), client = useQueryClient(), [params, setParams] = useSearchParams();
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [discoveryNotice, setDiscoveryNotice] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['tool-connections'], queryFn: listToolConnections, enabled: active, retry: false, refetchOnWindowFocus: false });
  const create = useMutation({ mutationFn: (body: CreateToolConnection) => saveToolConnectionWithDiscovery(body), retry: false,
    onSuccess: async result => { setDiscoveryNotice(result.discoveryError);
      if (result.catalog) client.setQueryData(['tool-catalog', result.connection.id], result.catalog);
      await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
  const oauthCallback = useMutation({ mutationFn: async () => {
    const response = await completeToolOAuth(params.get('state') ?? '', params.get('code') ?? '');
    return prepareAuthorizedToolConnection(response.connectionId);
  }, retry: false,
    onSuccess: async result => { setDiscoveryNotice(result.discoveryError); const next = new URLSearchParams(params); next.delete('state'); next.delete('code'); setParams(next, { replace: true });
      await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
  return <div className="space-y-6">
    <ToolCapabilitiesPanel active={active} />
    <ModelToolCapabilityCard active={active} />
    <p className="text-sm text-muted-foreground">{copy.toolsDirection} · <Link className="underline" to="/settings/mcp">{copy.mcpDirection}</Link></p>
    {params.has('state') && params.has('code') && <section className="space-y-3 rounded-xl border bg-card p-5">
      <p className="text-sm">{copy.authHint}</p><Button disabled={oauthCallback.isPending} onClick={() => oauthCallback.mutate()}>{copy.completeAuth}</Button>
      {oauthCallback.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(oauthCallback.error)}</p>}
    </section>}
    <details className="rounded-xl border p-5"><summary className="cursor-pointer font-medium">{zh ? '添加工具与云服务' : 'Add tools and cloud services'}</summary>
      <p className="my-4 text-sm text-muted-foreground">{zh ? '选择服务预设后填写密钥，或添加自定义 MCP 地址。保存后自动检查目录，再由你确认权限。' : 'Choose a service preset and enter its key, or add a custom MCP endpoint. Saving checks metadata; you then approve permissions.'}</p>
      <ToolConnectionEditor pending={create.isPending} onCreate={async input => { await create.mutateAsync(input); }} />
    </details>
    {discoveryNotice && <p role="alert" className="break-words text-sm text-destructive">{zh ? '连接已保存，目录检查未完成，可在连接中重新检查：' : 'Connection saved; metadata check failed. Retry discovery on the saved connection: '}{discoveryNotice}</p>}
    {create.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(create.error)}</p>}
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(query.error)}</p>}
    {query.data?.length === 0 && <p className="rounded-xl border p-6 text-sm text-muted-foreground">{copy.empty}</p>}
    <div className="space-y-4">{query.data?.filter(connection => !connection.managedPresetId).map(connection => <ToolConnectionCard key={connection.id} connection={connection} active={active} />)}</div>
    <p className="text-xs leading-5 text-muted-foreground">{copy.budgetHint}</p>
    <ToolActionsPanel active={active} />
  </div>;
}
