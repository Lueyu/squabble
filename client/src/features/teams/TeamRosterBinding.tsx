import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { agentRosterApi } from '@/api/agent-roster';
import type { AgentExecutor, AgentProfile } from '@shared/agent-roster.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { TeamRole } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';
import { friendlyError } from '@/utils/error-message';
import { TeamSelect, TeamNotice } from './TeamPrimitives';
import { rosterTeamConfig } from './guided-team-state';
import { AgentIdentity } from '@/features/agent-roster/AgentIdentity';

/** A legacy seat can become a persistent person without copying its team-private history. */
export function TeamRosterBinding({ role, label, models, zh, disabled, onBind }: { role: TeamRole; label: string; models: ModelConnection[]; zh: boolean; disabled: boolean; onBind: (patch: Partial<TeamRole>) => void }) {
  const query = useQueryClient();
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const intent = useRef<{ digest: string; key: string } | null>(null);
  const [failure, setFailure] = useState('');
  const currentRole = useRef(role); currentRole.current = role;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const bind = (agent: AgentProfile) => {
    try {
      const seat = rosterTeamConfig([agent], models, [role.id]).roles[0];
      onBind({ agentId: seat.agentId, agentVersionId: seat.agentVersionId, executor: seat.executor, allowedToolIds: seat.allowedToolIds, participation: 'enabled' });
      setFailure('');
    } catch (error) { setFailure(friendlyError(error, zh, { zh: '请先修复这位股友的连接。', en: 'Restore this agent’s connection first.' })); }
  };
  const migrate = useMutation({ retry: false, mutationFn: async () => {
    if (!role.executor) throw new Error('A configured executor is required');
    let executor: AgentExecutor;
    if (role.executor.executionMode === 'model') {
      const savedExecutor = role.executor;
      const connection = models.find(row => row.id === savedExecutor.connectionId);
      if (!connection || ![connection.fastModel, connection.slowModel].includes(role.executor.model)) throw new Error('Select a saved connection model first');
      executor = { executionMode: 'model', connectionId: connection.id, model: savedExecutor.tier === 'fast' || savedExecutor.tier === 'slow' ? savedExecutor.tier : (savedExecutor.model === connection.fastModel ? 'fast' : 'slow') };
    } else executor = role.executor.executionMode === 'a2a' ? { executionMode: 'a2a', connectionId: role.executor.connectionId } : { executionMode: 'local', localAgentId: role.executor.localAgentId, settings: role.executor.settings };
    const input = { name: label.slice(0, 100), specialty: role.responsibility.slice(0, 200) || label, description: role.expectedOutput.slice(0, 2000), instructions: [role.responsibility, role.expectedOutput].filter(Boolean).join('\n') || label, executor, allowedToolIds: role.allowedToolIds, allowedSources: [], preferences: { language: zh ? 'zh-CN' as const : 'en' as const } };
    const digest = JSON.stringify(input);
    if (intent.current?.digest !== digest) intent.current = { digest, key: crypto.randomUUID() };
    const originRole = JSON.stringify(role);
    return { agent: await agentRosterApi.create({ ...input, requestKey: intent.current.key }), originRole };
  }, onSuccess: async ({ agent, originRole }) => {
    if (mounted.current && JSON.stringify(currentRole.current) === originRole) bind(agent);
    else if (mounted.current) setFailure(zh ? '股友已保存。当前岗位已变化，请从名单中明确选择后关联。' : 'The agent is saved. This seat changed; explicitly select the agent to link it.');
    await query.invalidateQueries({ queryKey: ['agent-roster'] });
  }, onError: error => setFailure(friendlyError(error, zh, { zh: '尚未完成转换，原岗位保留。请核对连接后继续。', en: 'Conversion is incomplete; the original seat is retained. Check the connection and continue.' })) });
  const active = roster.data?.items.filter(agent => agent.status === 'active') ?? [];
  const current = roster.data?.items.find(agent => agent.id === role.agentId);
  return <section className="space-y-3 border rounded-lg p-3">
    <TeamSelect label={zh ? '由哪位股友担任' : 'Agent in this seat'} value={role.agentId ?? ''} disabled={disabled || roster.isPending} options={[{ value: '', label: zh ? '尚未关联独立股友' : 'No persistent agent linked' }, ...active.map(agent => ({ value: agent.id, label: `${agent.name} · ${agent.specialty}${agent.availability === 'unavailable' ? (zh ? ' · 尚未连接' : ' · Connection required') : ''}`, disabled: agent.availability === 'unavailable' })), ...(role.agentId && !active.some(agent => agent.id === role.agentId) ? [{ value: role.agentId, label: zh ? '原股友已归档或不可用' : 'Original agent archived or unavailable' }] : [])]} onChange={id => { const agent = active.find(item => item.id === id); if (agent) bind(agent); }} />
    {current && <div><AgentIdentity avatar={current.avatar} name={current.name} avatarClassName="size-9" /><p className="text-xs text-muted-foreground break-words">{current.specialty}</p></div>}
    {active.some(agent => agent.availability === 'unavailable') && <p className="text-xs text-muted-foreground">{zh ? '未连接的股友暂不能选择。' : 'Agents without a connection cannot be selected yet.'}<Link className="underline ml-1" to="/friends">{zh ? '去设置连接' : 'Restore connections'}</Link></p>}
    {current && <p className="text-xs text-muted-foreground">{zh ? '已固定股友版本，个人聊天和其他团队记忆不会自动带入。' : 'This seat pins an agent version; personal chats and other teams’ memories are not imported.'}{current.currentVersionId !== role.agentVersionId && <Button variant="outline" size="sm" disabled={disabled || current.status !== 'active'} onClick={() => bind(current)}>{zh ? '改用最新版本' : 'Use latest version'}</Button>}</p>}
    {!role.agentId && role.executor && <><p className="text-xs text-muted-foreground">{zh ? '旧岗位仍可手动研究。转换后才可参与自动运行；只保留职责和连接，历史记忆仍归原团队。' : 'Legacy seats support manual research. Convert to enable automation; duties and connection are retained, and history stays in the original team.'}</p><Button variant="outline" size="sm" disabled={disabled || migrate.isPending} onClick={() => migrate.mutate()}>{zh ? '把此岗位保存为我的股友' : 'Save this seat as my agent'}</Button></>}
    <Link className="block text-xs underline" to="/friends">{zh ? '管理我的股友' : 'Manage my agents'}</Link>
    {(failure || roster.isError) && <TeamNotice error>{failure || (zh ? '名单读取失败，请稍后重试。' : 'Could not load the roster. Try again later.')}</TeamNotice>}
  </section>;
}
