import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentRosterApi } from '@/api/agent-roster';
import { teamsApi } from '@/api/teams';
import { createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AgentProfile, AgentMemory } from '@shared/agent-roster.interface';

/** Personal notes stay private until the owner selects an exact note and receiving team. */
export function AgentMemoryPanel({ agent, zh }: { agent: AgentProfile; zh: boolean }) {
  const query = useQueryClient();
  const [note, setNote] = useState(''); const [teamId, setTeamId] = useState(''); const [message, setMessage] = useState('');
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const memories = useQuery({ queryKey: ['agent-memory', agent.id, 'personal'], queryFn: () => agentRosterApi.memories(agent.id, { kind: 'personal' }) });
  const teams = useQuery({ queryKey: ['teams', 'list', {}], queryFn: () => teamsApi.list() });
  const save = useMutation({ retry: false, mutationFn: () => {
    const payload = { expectedRevision: agent.revision, scope: { kind: 'personal' as const }, content: note.trim(), origin: 'user_note' as const, sourceRefs: [] };
    return agentRosterApi.remember(agent.id, { ...payload, requestKey: intent.current.keyFor(payload) });
  }, onSuccess: async () => { intent.current.complete(); setNote(''); setMessage(zh ? '已记住，仅用于与这位股友的个人交流。' : 'Saved for personal conversations with this agent.'); await query.invalidateQueries({ queryKey: ['agent-memory', agent.id] }); }, onError: () => setMessage(zh ? '保存未确认，内容已保留。请重新读取后核对。' : 'Save is not confirmed; your note is retained. Reload to check.') });
  const share = useMutation({ retry: false, mutationFn: (memory: AgentMemory) => agentRosterApi.share(agent.id, memory.id, { requestKey: `share:${memory.id}:${teamId}:${agent.revision}`, expectedRevision: agent.revision, targetAgentId: agent.id, targetScope: { kind: 'team', teamId } }), onSuccess: () => setMessage(zh ? '已分享这条内容给所选团队，原来源限制继续生效。' : 'This note is shared with the selected team; source restrictions remain.'), onError: () => setMessage(zh ? '分享未确认。请检查团队与资料是否仍可用。' : 'Share is not confirmed. Check the team and source availability.') });
  return <div className="space-y-3 border-t pt-3 mt-3">
    <h3 className="font-medium text-foreground">{zh ? '个人记忆' : 'Personal memory'}</h3><p>{zh ? '写下希望这位股友记住的偏好。团队内容不会自动进入这里。' : 'Add preferences for this agent. Team information is not copied here automatically.'}</p>
    {memories.isError && <p role="alert">{zh ? '记忆暂时无法读取。' : 'Memory could not be loaded.'} <button className="underline" onClick={() => void memories.refetch()}>{zh ? '重新读取' : 'Reload'}</button></p>}
    <Textarea aria-label={zh ? '告诉股友记住什么' : 'What should this agent remember?'} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
    <Button size="sm" disabled={!note.trim() || save.isPending} onClick={() => save.mutate()}>{zh ? '记住这条偏好' : 'Remember this preference'}</Button>
    <select aria-label={zh ? '分享给哪个团队' : 'Receiving team'} className="w-full border rounded-md p-2 bg-background" value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">{zh ? '需要时，选择接收团队' : 'Choose a team when sharing'}</option>{teams.data?.items.filter(t => t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
    <ul className="space-y-2">{memories.data?.items.map(memory => <li key={memory.id} className="rounded border p-2"><p className="whitespace-pre-wrap break-words">{memory.content}</p><Button size="sm" variant="ghost" disabled={!teamId || share.isPending} onClick={() => share.mutate(memory)}>{zh ? '只分享这条给所选团队' : 'Share only this note with the selected team'}</Button></li>)}</ul>
    {message && <p role="status">{message}</p>}
  </div>;
}
