import { useId, useState } from 'react';
import type { CreateToolConnection } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToolConnectionCopy } from './tool-connection-copy';

export function ToolConnectionEditor({ pending, onCreate }: { pending: boolean; onCreate: (input: CreateToolConnection) => Promise<void> }) {
  const copy = useToolConnectionCopy(), id = useId();
  const [provider, setProvider] = useState('mcp'), [endpoint, setEndpoint] = useState(''), [credential, setCredential] = useState('');
  const [authConfigId, setAuthConfigId] = useState(''), [version, setVersion] = useState(''), [app, setApp] = useState('googledrive');
  const [authKind, setAuthKind] = useState('bearer'), [clientId, setClientId] = useState(''), [authorizationUrl, setAuthorizationUrl] = useState(''),
    [tokenUrl, setTokenUrl] = useState(''), [scopes, setScopes] = useState('');
  return <form className="space-y-4 rounded-xl border bg-card p-5" onSubmit={event => {
    event.preventDefault();
    const tools = app === 'googledrive' ? ['GOOGLEDRIVE_GET_FILE_METADATA', 'GOOGLEDRIVE_GET_DOCUMENT']
      : app === 'notion' ? ['NOTION_RETRIEVE_PAGE', 'NOTION_CREATE_NOTION_PAGE'] : ['GMAIL_SEND_EMAIL'];
    void onCreate({ provider, ...(provider === 'mcp' ? { endpoint } : {}), ...(credential && !(provider === 'mcp' && authKind === 'oauth') ? { credential } : {}),
      ...(provider === 'mcp' && authKind === 'oauth' ? { oauth: { clientId, authorizationUrl, tokenUrl, scopes: scopes.split(/\s+/u).filter(Boolean) } } : {}),
      ...(provider === 'composio' ? { providerConfig: { authConfigId, toolVersions: Object.fromEntries(tools.map(tool => [tool, version])) } } : {}) })
      .then(() => { setCredential(''); setEndpoint(''); setAuthConfigId(''); setVersion(''); }).catch(() => {});
  }}>
    <h2 className="text-base font-semibold">{copy.create}</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor={`${id}-provider`}>{copy.provider}</Label>
        <Select value={provider} onValueChange={setProvider}><SelectTrigger id={`${id}-provider`}><SelectValue /></SelectTrigger>
          <SelectContent>{['mcp', 'tavily', 'exa', 'firecrawl', 'composio'].map(item => <SelectItem key={item} value={item}>{item === 'mcp' ? 'MCP' : item[0].toUpperCase() + item.slice(1)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {provider === 'mcp' && <div className="space-y-2"><Label htmlFor={`${id}-endpoint`}>{copy.endpoint}</Label>
        <Input id={`${id}-endpoint`} type="url" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://service.example.org/mcp" autoComplete="off" />
      </div>}
      {provider === 'mcp' && <div className="space-y-2"><Label htmlFor={`${id}-auth-kind`}>OAuth / Bearer</Label>
        <Select value={authKind} onValueChange={setAuthKind}><SelectTrigger id={`${id}-auth-kind`}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="bearer">Bearer / API key</SelectItem><SelectItem value="oauth">OAuth · PKCE</SelectItem>
        </SelectContent></Select></div>}
      {!(provider === 'mcp' && authKind === 'oauth') && <div className="space-y-2"><Label htmlFor={`${id}-key`}>{copy.credential}</Label>
        <Input id={`${id}-key`} type="password" required={provider !== 'mcp'} value={credential} onChange={event => setCredential(event.target.value)} autoComplete="new-password" />
        <p className="text-xs text-muted-foreground">{copy.optionalKey}</p>
      </div>}
      {provider === 'mcp' && authKind === 'oauth' && <>
        <div className="space-y-2"><Label htmlFor={`${id}-client-id`}>OAuth client ID</Label><Input id={`${id}-client-id`} required value={clientId} onChange={event => setClientId(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-authorize-url`}>OAuth authorization URL</Label><Input id={`${id}-authorize-url`} type="url" required value={authorizationUrl} onChange={event => setAuthorizationUrl(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-token-url`}>OAuth token URL</Label><Input id={`${id}-token-url`} type="url" required value={tokenUrl} onChange={event => setTokenUrl(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-scopes`}>OAuth scopes</Label><Input id={`${id}-scopes`} value={scopes} onChange={event => setScopes(event.target.value)} /></div>
      </>}
      {provider === 'composio' && <>
        <div className="space-y-2"><Label htmlFor={`${id}-app`}>{copy.app}</Label><Select value={app} onValueChange={setApp}>
          <SelectTrigger id={`${id}-app`}><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="googledrive">Google Drive</SelectItem><SelectItem value="notion">Notion</SelectItem><SelectItem value="gmail">Gmail</SelectItem>
          </SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor={`${id}-auth`}>{copy.authConfig}</Label><Input id={`${id}-auth`} required value={authConfigId} onChange={event => setAuthConfigId(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-version`}>{copy.version}</Label><Input id={`${id}-version`} required pattern="[0-9]{8}_[0-9]+" value={version} onChange={event => setVersion(event.target.value)} placeholder="YYYYMMDD_00" /></div>
      </>}
    </div>
    <Button type="submit" disabled={pending}>{copy.save}</Button>
  </form>;
}
