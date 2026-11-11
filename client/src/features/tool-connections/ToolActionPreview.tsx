import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmToolAction, editToolAction, listToolActions, rejectToolAction, toolRequestError, type ToolActionView } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToolConnectionCopy } from './tool-connection-copy';

export function ToolActionPreview({ action }: { action: ToolActionView }) {
  const copy = useToolConnectionCopy(), client = useQueryClient();
  const [editing, setEditing] = useState(false), [payload, setPayload] = useState(''), [target, setTarget] = useState(action.target);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: (operation: () => Promise<unknown>) => operation(), retry: false,
    onSuccess: async () => { setError(null); setEditing(false); await client.invalidateQueries({ queryKey: ['tool-actions'] }); },
    onError: issue => setError(toolRequestError(issue)) });
  const expired = Date.parse(action.expiresAt) <= Date.now(), editable = ['pending', 'approved', 'draft'].includes(action.state);
  return <article className="space-y-4 rounded-xl border bg-card p-5" aria-label={`${copy.actions}: ${action.descriptor.name}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="break-all font-semibold">{action.descriptor.name}</h3>
      <span className="rounded-full border px-2 py-1 text-xs">{action.receipt?.state ?? action.state}</span></div>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{copy.account}</dt><dd className="mt-1 break-all">{action.accountId}</dd></div>
      <div><dt className="text-muted-foreground">{copy.target}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{action.target}</dd></div>
      <div><dt className="text-muted-foreground">{copy.cost}</dt><dd className="mt-1">{action.costLimit.maxAmount === null ? copy.unknownCost : `${action.costLimit.maxAmount} ${action.costLimit.currency ?? ''}`}</dd></div>
      <div><dt className="text-muted-foreground">{copy.expires}</dt><dd className="mt-1">{new Date(action.expiresAt).toLocaleString()}</dd></div>
    </dl>
    <div><p className="mb-2 text-sm font-medium">{copy.payload}</p><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs">{JSON.stringify(action.args, null, 2)}</pre></div>
    {action.attachments.length > 0 && <div><p className="text-sm font-medium">{copy.attachments}</p>
      <ul className="mt-2 space-y-2">{action.attachments.map(attachment => <li key={attachment.artifactId} className="break-all text-xs text-muted-foreground">{attachment.artifactId}<br />SHA-256 {attachment.sha256}</li>)}</ul></div>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{copy.error}: {error}</p>}
    {action.state === 'unknown' && <p role="status" className="rounded-lg border p-3 text-sm">{copy.unknownReceipt}</p>}
    {action.state === 'approved' && <p role="status" className="text-sm text-muted-foreground">{copy.approvalSaved}</p>}
    {expired && editable && <p className="text-sm text-muted-foreground">{copy.expired}</p>}
    {action.receipt && <div><p className="text-sm font-medium">{copy.receipt}</p><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(action.receipt, null, 2)}</pre></div>}
    {editing && <form className="space-y-3 border-t pt-4" onSubmit={event => {
      event.preventDefault();
      let args: unknown;
      try { args = JSON.parse(payload); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
      catch { setError('INVALID_TOOL_ACTION_PREVIEW'); return; }
      mutation.mutate(() => editToolAction(action, { args: args as Record<string, unknown>, accountId: action.accountId, target }));
    }}>
      <p className="text-sm text-muted-foreground">{copy.editHint}</p>
      <Label htmlFor={`${action.id}-target`}>{copy.target}</Label><Input id={`${action.id}-target`} required value={target} onChange={event => setTarget(event.target.value)} />
      <Label htmlFor={`${action.id}-payload`}>{copy.payload}</Label><Textarea id={`${action.id}-payload`} rows={12} value={payload} onChange={event => setPayload(event.target.value)} className="font-mono text-xs" />
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={mutation.isPending}>{copy.saveEdit}</Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{copy.cancelEdit}</Button></div>
    </form>}
    {editable && !editing && <div className="flex flex-wrap gap-2">
      {action.state === 'pending' && <Button disabled={mutation.isPending || expired} onClick={() => mutation.mutate(() => confirmToolAction(action))}>{copy.confirm}</Button>}
      <Button variant="outline" disabled={mutation.isPending} onClick={() => { setPayload(JSON.stringify(action.args, null, 2)); setTarget(action.target); setEditing(true); }}>{copy.edit}</Button>
      <Button variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate(() => rejectToolAction(action.id))}>{copy.reject}</Button>
    </div>}
  </article>;
}

export function ToolActionsPanel({ active }: { active: boolean }) {
  const copy = useToolConnectionCopy(), query = useQuery({ queryKey: ['tool-actions'], queryFn: () => listToolActions(), enabled: active,
    refetchOnWindowFocus: false, retry: false });
  return <section className="space-y-4" aria-label={copy.actions}><h2 className="text-lg font-semibold">{copy.actions}</h2>
    {query.isLoading && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">{copy.error}: {toolRequestError(query.error)}</p>}
    {query.data?.length === 0 && <p className="text-sm text-muted-foreground">{copy.actionEmpty}</p>}
    {query.data?.map(action => <ToolActionPreview key={`${action.id}:${action.revision}`} action={action} />)}
  </section>;
}
