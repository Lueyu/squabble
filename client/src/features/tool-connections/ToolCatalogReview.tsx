import { useEffect, useState } from 'react';
import type { AgentDataClass } from '@shared/agent-tooling.interface';
import type { ToolCatalogView, ToolConnectionView } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToolConnectionCopy } from './tool-connection-copy';

export function ToolCatalogReview({ connection, catalog, pending, onEnable, changes }: {
  connection: ToolConnectionView; catalog: ToolCatalogView; pending: boolean;
  changes?: { added: string[]; removed: string[]; changed: string[] };
  onEnable: (toolIds: string[], dataClasses: AgentDataClass[], effects: Record<string, string>) => void;
}) {
  const copy = useToolConnectionCopy(), [selected, setSelected] = useState<string[]>(connection.allowedToolIds);
  const [dataClasses, setDataClasses] = useState<AgentDataClass[]>(connection.allowedDataClasses), [effects, setEffects] = useState<Record<string, string>>(connection.toolEffects);
  useEffect(() => { setSelected(connection.allowedToolIds); setDataClasses(connection.allowedDataClasses); setEffects(connection.toolEffects); },
    [catalog.id, connection.revision, connection.allowedToolIds, connection.allowedDataClasses, connection.toolEffects]);
  return <div className="space-y-4 border-t pt-4">
    <div><h3 className="font-semibold">{copy.catalog}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{catalog.schemaHash}</p></div>
    {changes && <div className="space-y-1 break-words rounded-lg bg-muted p-3 text-sm">
      <p>{copy.changes}</p>
      {(['added', 'removed', 'changed'] as const).map(kind => changes[kind].length > 0 && <p key={kind}>{copy[kind]}: {changes[kind].join(', ')}</p>)}
    </div>}
    {connection.provider === 'mcp' && <p className="text-sm text-muted-foreground">{copy.effectsHint}</p>}
    <div className="divide-y rounded-lg border">{catalog.descriptors.map(tool => <div key={tool.id} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Label className="flex min-w-0 items-center gap-3"><Checkbox checked={selected.includes(tool.id)} aria-label={tool.name}
          onCheckedChange={checked => setSelected(current => checked === true ? [...new Set([...current, tool.id])] : current.filter(id => id !== tool.id))} />
          <span className="break-all font-medium">{tool.name}</span></Label>
        {connection.provider === 'mcp' ? <Select value={effects[tool.id] ?? tool.effect} onValueChange={value => setEffects(current => ({ ...current, [tool.id]: value }))}>
          <SelectTrigger className="w-full sm:w-64" aria-label={`${tool.name} ${copy.read}`}><SelectValue /></SelectTrigger><SelectContent>
            {(['read', 'compute', 'external_write'] as const).map(effect => <SelectItem key={effect} value={effect}>{copy[effect]}</SelectItem>)}
          </SelectContent></Select> : <span className="text-xs text-muted-foreground">{copy[tool.effect]}</span>}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{tool.description}</p>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">{copy.schema}</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
    </div>)}</div>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">{copy.data}</legend><p className="text-xs text-muted-foreground">{copy.dataHint}</p>
      <div className="flex flex-wrap gap-4">{(['public', 'private_material', 'portfolio', 'application'] as const).map(dataClass => <Label key={dataClass} className="flex items-center gap-2">
        <Checkbox checked={dataClasses.includes(dataClass)} onCheckedChange={checked => setDataClasses(current => checked === true
          ? [...new Set([...current, dataClass])] : current.filter(item => item !== dataClass))} />{copy[dataClass]}</Label>)}</div>
    </fieldset>
    <Button disabled={pending || dataClasses.length === 0} onClick={() => onEnable(selected, dataClasses,
      Object.fromEntries(Object.entries(effects).filter(([id]) => selected.includes(id))))}>{copy.approveCatalog}</Button>
  </div>;
}
