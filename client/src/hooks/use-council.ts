/**
 * @file hooks/use-council.ts
 * @description Council 会话列表/详情的查询 hooks 与会话操作 mutations 的统一封装。
 *
 * 职责边界：
 *  - 只包装 react-query 的 queryKey/轮询/缓存更新；会话状态判定
 *    （是否可发消息、是否自动 run）在 utils/council-state.ts
 * 上下游：
 *  - 上游（谁调用这里）：useCouncilSessions / useCouncilSession / useCouncilActions
 *    → pages/Council/CouncilPage.tsx（CouncilConversation 以
 *    ReturnType<typeof useCouncilActions> 引用类型）
 *  - 下游（本文件调用谁）：@/api/council（会话 CRUD/消息/运行控制）
 * 关键约定：
 *  - queryKey 前缀 'council'：详情为 ['council','session',id]、列表为
 *    ['council','sessions']；任何 mutation 成功后统一走 update() 写缓存并
 *    失效列表与 'llm-budget' 查询
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CouncilSession } from '@shared/council.interface';
import {
  createCouncilSession,
  fetchCouncilSession,
  fetchCouncilSessions,
  pauseCouncilSession,
  postCouncilMessage,
  runCouncilSession,
} from '@/api/council';

/**
 * 订阅全部 Council 会话列表。
 * 每 15 秒轮询一次，保证多端/后台改动能反映到列表。
 */
export function useCouncilSessions() {
  return useQuery({
    queryKey: ['council', 'sessions'],
    queryFn: fetchCouncilSessions,
    refetchInterval: 15_000,
  });
}

/**
 * 订阅单个会话详情（含消息流）。
 * 轮询节奏自适应：会话处于 running 状态时 2 秒一轮（跟紧委员发言），
 * 其余状态 10 秒一轮；id 为空时不启用查询。
 */
export function useCouncilSession(id: string | null) {
  return useQuery({
    queryKey: ['council', 'session', id],
    queryFn: () => fetchCouncilSession(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : 10_000),
  });
}

/**
 * 会话操作集合：创建、发消息、触发发言、暂停。
 * 全部 mutation 不重试（retry: false，避免重复发言）；成功后把返回的
 * 会话写入详情缓存，并失效会话列表与 LLM 预算查询。
 */
export function useCouncilActions() {
  // 拿到 queryClient，供成功回调统一更新缓存。
  const client = useQueryClient();

  // 统一的缓存更新：写详情 + 失效列表与预算用量。
  const update = (session: CouncilSession) => {
    client.setQueryData(['council', 'session', session.id], session);
    void client.invalidateQueries({ queryKey: ['council', 'sessions'] });
    void client.invalidateQueries({ queryKey: ['llm-budget'] });
  };

  // 创建会话。
  const create = useMutation({ mutationFn: createCouncilSession, retry: false, onSuccess: update });

  // 向会话发送用户消息。
  const send = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      postCouncilMessage(id, content),
    retry: false,
    onSuccess: update,
  });

  // 立即触发一轮委员发言。
  const run = useMutation({ mutationFn: runCouncilSession, retry: false, onSuccess: update });

  // 暂停会话。
  const pause = useMutation({ mutationFn: pauseCouncilSession, retry: false, onSuccess: update });

  return { create, send, run, pause };
}
