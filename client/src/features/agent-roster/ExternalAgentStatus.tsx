import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { a2aAgentsApi } from '@/api/a2a-agents';
import { Button } from '@/components/ui/button';

export function ExternalAgentStatus({ connectionId, zh }: { connectionId: string; zh: boolean }) {
  const query = useQueryClient();
  const connections = useQuery({ queryKey: ['a2a-agents'], queryFn: a2aAgentsApi.list });
  const connection = connections.data?.find(row => row.id === connectionId);
  const control = useMutation({ retry: false, mutationFn: async (action: 'refresh' | 'disable') => {
    if (!connection) throw new Error('Connection unavailable');
    return a2aAgentsApi[action](connectionId, { requestKey: `${action}:${connectionId}:${connection.revision}`, expectedRevision: connection.revision });
  }, onSuccess: async () => { await query.invalidateQueries({ queryKey: ['a2a-agents'] }); await query.invalidateQueries({ queryKey: ['agent-roster'] }); } });
  return <div className="space-y-2 mt-3"><p>{zh ? '外部连接' : 'External connection'}: {connection?.status ?? (zh ? '未知' : 'Unknown')} · {connection?.capabilities.structuredOutputVerified ? (zh ? '结构化交付已验证' : 'Structured delivery verified') : (zh ? '结构化交付尚未验证' : 'Structured delivery unverified')}</p><p>{zh ? '刷新能力卡后需重新核对版本；停用连接会阻止新任务和迟到验收。内部费用保持未知。' : 'A refreshed card requires a version review. Disabling blocks new work and late acceptance. Internal fees remain unknown.'}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!connection || control.isPending || connection.status === 'disabled'} onClick={() => control.mutate('refresh')}>{zh ? '刷新能力卡' : 'Refresh card'}</Button><Button size="sm" variant="ghost" disabled={!connection || control.isPending || connection.status === 'disabled'} onClick={() => control.mutate('disable')}>{zh ? '停用外部连接' : 'Disable connection'}</Button></div>{control.isError && <p role="alert">{zh ? '结果未确认，请先重新读取连接状态再继续。' : 'The result is unconfirmed. Reload the connection state before continuing.'}</p>}</div>;
}
