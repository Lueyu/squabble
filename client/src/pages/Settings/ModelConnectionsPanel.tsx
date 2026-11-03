import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Pencil, Plus, Trash2, Unplug } from 'lucide-react';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';
import { createModelConnection, fetchModelConnections, removeModelConnection,
  testModelConnection, updateModelConnection } from '@/api/model-connections';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

const EMPTY: SaveModelConnection = { name: '', baseUrl: '', fastModel: '', slowModel: '', apiKey: '' };
const QUERY_KEY = ['settings', 'model-connections'];

export default function ModelConnectionsPanel({ active = true }: { active?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: fetchModelConnections });
  const [editing, setEditing] = useState<ModelConnection | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SaveModelConnection>({ ...EMPTY });
  const [failure, setFailure] = useState('');
  const [deleting, setDeleting] = useState<ModelConnection | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const key = (name: string) => t(`integrations.connections.${name}`);
  const save = useMutation({
    mutationFn: () => editing ? updateModelConnection(editing.id, draft) : createModelConnection(draft),
    onSuccess: async () => { setOpen(false); setDraft({ ...EMPTY }); await client.invalidateQueries({ queryKey: QUERY_KEY }); },
    onError: (error: unknown) => setFailure(errorMessage(error, key('failed'))),
  });
  const remove = useMutation({
    mutationFn: removeModelConnection,
    onSuccess: async () => { setDeleting(null); await client.invalidateQueries({ queryKey: QUERY_KEY }); },
    onError: (error: unknown) => setFailure(errorMessage(error, key('failed'))),
  });
  const probe = useMutation({
    mutationFn: (id: string) => testModelConnection(id, i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    onSuccess: (result, id) => setResults(current => ({ ...current, [id]: result })),
    onError: (error: unknown, id: string) => setResults(current => ({ ...current,
      [id]: { ok: false, message: errorMessage(error, key('failed')) } })),
  });
  const edit = (row: ModelConnection | null) => {
    setEditing(row);
    setDraft(row ? { name: row.name, baseUrl: row.baseUrl, fastModel: row.fastModel, slowModel: row.slowModel, apiKey: '' } : { ...EMPTY });
    setFailure(''); setOpen(true);
  };
  const update = (field: keyof SaveModelConnection, value: string) => setDraft(current => ({ ...current, [field]: value }));
  return <Card id="model-connections" className="min-w-0 scroll-mt-6">
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl space-y-2"><CardTitle>{key('title')}</CardTitle><CardDescription>{key('intro')}</CardDescription></div>
      <Button size="sm" variant="outline" onClick={() => edit(null)} disabled={(list.data?.length ?? 0) >= 8}><Plus />{key('add')}</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {list.isPending && <p role="status" className="text-sm text-muted-foreground">{key('loading')}</p>}
      {list.isError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        {key('failed')}<Button size="sm" variant="outline" onClick={() => void list.refetch()}>{key('retry')}</Button></div>}
      {list.isSuccess && list.data.length === 0 && <p className="rounded-lg bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">{key('empty')}</p>}
      <div className="grid gap-3 lg:grid-cols-2">{list.data?.map(connection => <div key={connection.id} className="min-w-0 rounded-xl border border-border p-4">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 font-semibold">{connection.available ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <Unplug className="size-4 shrink-0 text-destructive" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{connection.name}</span></p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{connection.baseUrl}</p>
        </div><div className="flex shrink-0">
          <Button size="icon" variant="ghost" aria-label={`${key('edit')} ${connection.name}`} onClick={() => edit(connection)}><Pencil className="size-4" /></Button>
          <Button size="icon" variant="ghost" aria-label={`${key('remove')} ${connection.name}`} onClick={() => { setFailure(''); setDeleting(connection); }}><Trash2 className="size-4" /></Button>
        </div></div>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
          <dt className="text-muted-foreground">{key('fast')}</dt><dd className="break-all">{connection.fastModel}</dd>
          <dt className="text-muted-foreground">{key('slow')}</dt><dd className="break-all">{connection.slowModel}</dd>
        </dl>
        {connection.needsReentry && <p className="mt-2 text-xs text-destructive">{key('reentry')}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{connection.maskedApiKey}</span>
          <Button size="sm" variant="outline" disabled={probe.isPending || !connection.available} onClick={() => probe.mutate(connection.id)}>
            {probe.isPending && probe.variables === connection.id && <Loader2 className="size-3 animate-spin" />}{key('test')}</Button>
        </div>
        {results[connection.id] && <p role="status" className={`mt-2 break-words text-xs leading-5 ${results[connection.id].ok ? 'text-success' : 'text-destructive'}`}>{results[connection.id].message}</p>}
      </div>)}</div>
      <p className="text-xs leading-5 text-muted-foreground">{key('budget')}</p>
    </CardContent>
    <Dialog open={active && open} onOpenChange={value => { setOpen(value); if (!value) setDraft({ ...EMPTY }); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? key('edit') : key('add')}</DialogTitle><DialogDescription>{key('guide')}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); setFailure(''); save.mutate(); }}>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(current => ({ ...current,
              baseUrl: 'https://api.deepseek.com', fastModel: 'deepseek-flash', slowModel: 'deepseek-flash',
              apiKey: current.baseUrl === 'https://api.deepseek.com' ? current.apiKey : '' }))}>DeepSeek</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(current => ({ ...current,
              baseUrl: 'https://api.openai.com/v1', fastModel: '', slowModel: '',
              apiKey: current.baseUrl === 'https://api.openai.com/v1' ? current.apiKey : '' }))}>OpenAI</Button>
          </div>
          {(['name', 'baseUrl', 'fastModel', 'slowModel', 'apiKey'] as const).map(field => <div key={field} className="space-y-2">
            <Label htmlFor={`connection-${field}`}>{key(field)}</Label>
            <Input id={`connection-${field}`} type={field === 'apiKey' ? 'password' : 'text'} autoComplete="off"
              required={field !== 'apiKey' || !editing?.hasApiKey} value={draft[field] ?? ''}
              maxLength={field === 'apiKey' ? 4096 : field === 'name' ? 60 : field === 'baseUrl' ? 500 : 120}
              placeholder={field === 'apiKey' && editing?.hasApiKey ? key('keepKey') : undefined}
              onChange={event => update(field, event.target.value)} />
          </div>)}
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
          <Button className="w-full" type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />}{key('save')}</Button>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={active && Boolean(deleting)} onOpenChange={value => { if (!value) setDeleting(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{key('remove')}</AlertDialogTitle><AlertDialogDescription>{key('removeHint')}</AlertDialogDescription></AlertDialogHeader>
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <AlertDialogFooter><AlertDialogCancel>{key('cancel')}</AlertDialogCancel><AlertDialogAction disabled={remove.isPending} onClick={event => {
          event.preventDefault(); if (deleting) remove.mutate(deleting.id);
        }}>{remove.isPending && <Loader2 className="animate-spin" />}{key('remove')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
