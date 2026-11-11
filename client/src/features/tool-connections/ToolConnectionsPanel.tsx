import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, RefreshCw } from 'lucide-react';
import { authorizeToolApp, authorizeToolOAuth, completeToolApp, completeToolOAuth, createToolConnection, discoverToolConnection, disconnectToolConnection,
  enableToolConnection, getToolCatalog, listToolConnections, toolRequestError, updateToolCredential,
  type CreateToolConnection, type ToolConnectionView } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToolConnectionEditor } from './ToolConnectionEditor';
import { ToolCatalogReview } from './ToolCatalogReview';
import { ToolActionsPanel } from './ToolActionPreview';
import { useToolConnectionCopy } from './tool-connection-copy';
import { ModelToolCapabilityCard } from './ModelToolCapabilityCard';

function ToolConnectionCard({ connection, active }: { connection: ToolConnectionView; active: boolean }) {
  const copy = useToolConnectionCopy(), client = useQueryClient(), [params] = useSearchParams();
  const [expanded, setExpanded] = useState(false), [credential, setCredential] = useState(''), [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [sessionUri, setSessionUri] = useState(params.get('session_uri') ?? '');
  const catalog = useQuery({ queryKey: ['tool-catalog', connection.id], queryFn: () => getToolCatalog(connection.id),
    enabled: active && expanded, retry: false, refetchOnWindowFocus: false });
  const operation = useMutation({ mutationFn: (execute: () => Promise<unknown>) => execute(), retry: false,
    onSuccess: async () => { setCredential(''); await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
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
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); operation.mutate(() => completeToolApp(connection.id, sessionUri)); }}>
        <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${connection.id}-session`}>{copy.sessionUri}</Label>
          <Input id={`${connection.id}-session`} required value={sessionUri} onChange={event => setSessionUri(event.target.value)} autoComplete="off" /></div>
        <Button type="submit" size="sm" variant="outline" disabled={operation.isPending || !sessionUri}>{copy.completeAuth}</Button>
      </form>
    </div>}
    <details className="border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{copy.replaceKey}</summary>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); operation.mutate(() => updateToolCredential(connection.id, { revision: connection.revision, credential })); }}>
        <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${connection.id}-key`}>{copy.credential}</Label>
          <Input id={`${connection.id}-key`} type="password" autoComplete="new-password" required value={credential} onChange={event => setCredential(event.target.value)} /></div>
        <Button type="submit" variant="outline" size="sm" disabled={operation.isPending || !credential}>{copy.save}</Button>
      </form>
    </details>
    {operation.isError && <p role="alert" className="break-words text-sm text-destructive">{copy.error}: {toolRequestError(operation.error)}</p>}
    {expanded && catalog.isLoading && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
    {expanded && catalog.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(catalog.error)}</p>}
    {expanded && catalog.data === null && <p className="text-sm text-muted-foreground">{copy.toolsEmpty}</p>}
    {expanded && catalog.data && <ToolCatalogReview connection={connection} catalog={catalog.data} pending={operation.isPending}
      onEnable={(toolIds, dataClasses, effects) => operation.mutate(() => enableToolConnection(connection.id, { revision: connection.revision,
        catalogVersionId: catalog.data!.id, schemaHash: catalog.data!.schemaHash, toolIds, dataClasses, effects }))} />}
  </article>;
}

export default function ToolConnectionsPanel({ active = true }: { active?: boolean }) {
  const copy = useToolConnectionCopy(), client = useQueryClient(), [params, setParams] = useSearchParams();
  const query = useQuery({ queryKey: ['tool-connections'], queryFn: listToolConnections, enabled: active, retry: false, refetchOnWindowFocus: false });
  const create = useMutation({ mutationFn: (body: CreateToolConnection) => createToolConnection(body), retry: false,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
  const oauthCallback = useMutation({ mutationFn: () => completeToolOAuth(params.get('state') ?? '', params.get('code') ?? ''), retry: false,
    onSuccess: async () => { const next = new URLSearchParams(params); next.delete('state'); next.delete('code'); setParams(next, { replace: true });
      await client.invalidateQueries({ queryKey: ['tool-connections'] }); } });
  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">{copy.toolsDirection} · <Link className="underline" to="/settings/mcp">{copy.mcpDirection}</Link></p>
    <ModelToolCapabilityCard active={active} />
    {params.has('state') && params.has('code') && <section className="space-y-3 rounded-xl border bg-card p-5">
      <p className="text-sm">{copy.authHint}</p><Button disabled={oauthCallback.isPending} onClick={() => oauthCallback.mutate()}>{copy.completeAuth}</Button>
      {oauthCallback.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(oauthCallback.error)}</p>}
    </section>}
    <ToolConnectionEditor pending={create.isPending} onCreate={async input => { await create.mutateAsync(input); }} />
    {create.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(create.error)}</p>}
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(query.error)}</p>}
    {query.data?.length === 0 && <p className="rounded-xl border p-6 text-sm text-muted-foreground">{copy.empty}</p>}
    <div className="space-y-4">{query.data?.map(connection => <ToolConnectionCard key={connection.id} connection={connection} active={active} />)}</div>
    <p className="text-xs leading-5 text-muted-foreground">{copy.budgetHint}</p>
    <ToolActionsPanel active={active} />
  </div>;
}
