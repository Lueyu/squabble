/**
 * local-agents Doubao CLI 适配：headless 模式的提交/等待/停止三段式流程。
 *
 * 职责边界：只封装 Doubao 的远端任务协议（ACK→wait→stop）；进度/用量事件
 * 解析复用 events.ts/activity.ts，进程执行复用 process.ts。
 *
 * 上下游：import node:fs/promises、node:path、events/metadata/process/
 * activity/resolver 与 shared 接口；被 research.ts 调用。
 *
 * 关键约定：一次 ACK 即在上游启动真实任务——杀掉 `wait` 子进程并不会取消
 * 它；因此提交阶段刻意不挂 abort signal（保证即使被取消也能收到 ACK 并
 * 精确停掉那次 run）；恢复凭据落在工作区 doubao-recovery.json（mode 0o600，
 * state 'unconfirmed'，指示人工检查而非重发请求）；取消未确认时抛
 * NATIVE_AGENT_CANCEL_UNCONFIRMED，上游仍在跑时抛 NATIVE_AGENT_UPSTREAM_PENDING。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeEventCollector } from './events';
import { jsonValues, object, type JsonObject } from './metadata';
import {
  executeNativeProcess,
  NativeProcessFailure,
  type NativeProcessOptions,
  type NativeProcessResult,
} from './process';
import type { NativeLaunch } from './resolver';
import type { ResearchActivity } from '../../shared/research-events.interface';
import { NativeActivityCollector } from './activity';

/** 取 stdout 里最后一个 JSON 对象作为 CLI 的结构化响应。 */
function resultObject(result: NativeProcessResult): JsonObject {
  return object(jsonValues(result.stdout).at(-1));
}
/**
 * 从响应里提取 { conversationId, runId } 恢复凭据：顶层、result 嵌套层或
 * recoveryReceipt 三处都试；id 必须是 [a-zA-Z0-9_-] 且 <= 160 字符。
 */
function receiptFrom(value: JsonObject): { conversationId: string; runId: string } | null {
  const nested: JsonObject = object(value.result);
  const receipt: JsonObject = value.conversationId
    ? value
    : nested.conversationId
      ? nested
      : object(value.recoveryReceipt);
  const valid = (id: unknown): id is string =>
    typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/u.test(id);
  return valid(receipt.conversationId) && valid(receipt.runId)
    ? { conversationId: receipt.conversationId, runId: receipt.runId }
    : null;
}

/** 一次 Doubao ACK 即开始一个上游任务；杀掉 `wait` 并不会取消它。 */
export async function runDoubao(
  launch: NativeLaunch,
  args: string[],
  processOptions: NativeProcessOptions,
  root: string,
  onProgress: (text: string) => void,
  onEvent?: (event: ResearchActivity) => void,
): Promise<{ text: string; usageTokens: number | null }> {
  const activity = new NativeActivityCollector('doubao', onEvent);
  const deadline: number = Date.now() + processOptions.timeoutMs;
  let receipt: { conversationId: string; runId: string } | null = null;
  let accepted: boolean = false;
  let submitted: boolean = false;
  // 落盘恢复凭据：工作区只有当前用户可读（0o600），并明确指示"检查既有任务，
  // 不要重发此请求"——重发会重复扣上游配额。
  const persist = async (): Promise<void> => {
    await writeFile(
      join(root, 'doubao-recovery.json'),
      JSON.stringify({
        provider: 'doubao',
        ...receipt,
        state: 'unconfirmed',
        submittedAt: new Date().toISOString(),
        instruction: 'Inspect the existing Doubao task; do not resend this request.',
      }),
      { mode: 0o600 },
    );
  };
  // 优雅停止：headless sessions stop <id> --run <id>，给上游 15s 窗口；
  // 停止失败只返回 false（由调用方决定是否落盘恢复凭据）。
  const stop = async (): Promise<boolean> => {
    if (!receipt) return false;
    try {
      const result = await executeNativeProcess(
        launch,
        [
          'headless',
          'sessions',
          'stop',
          receipt.conversationId,
          '--run',
          receipt.runId,
          '--json',
          '--timeout',
          '15',
        ],
        {
          ...processOptions,
          input: undefined,
          signal: undefined,
          onLine: undefined,
          timeoutMs: 20_000,
        },
      );
      return result.code === 0 && resultObject(result).stopped === true;
    } catch {
      return false;
    }
  };
  try {
    if (processOptions.signal?.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
    // 即使被取消也要收到有界的提交 ACK，才能停掉那一次具体的 run——
    // 所以提交阶段刻意不挂 signal：--timeout 压到 <=30s，外层进程超时 <=35s。
    submitted = true;
    const submission = await executeNativeProcess(
      launch,
      [
        ...args.slice(0, -2),
        '--timeout',
        String(Math.max(1, Math.ceil(Math.min(processOptions.timeoutMs, 30_000) / 1000))),
        ...args.slice(-2),
      ],
      {
        ...processOptions,
        signal: undefined,
        timeoutMs: Math.min(processOptions.timeoutMs, 35_000),
        onLine: undefined,
      },
    );
    const response: JsonObject = resultObject(submission);
    activity.read(response);
    receipt = receiptFrom(response);
    // 三者之一即视为上游已受理：显式 accepted、拿到凭据、或进程成功退出。
    accepted = response.accepted === true || receipt !== null || submission.code === 0;
    if (submission.code !== 0 || !receipt)
      throw new Error(accepted ? 'NATIVE_AGENT_UPSTREAM_PENDING' : 'NATIVE_AGENT_FAILED');
    if (processOptions.signal?.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
    const remaining: number = deadline - Date.now();
    if (remaining <= 0) throw new Error('NATIVE_AGENT_TIMEOUT');
    onProgress('Analyzing sources…');
    // 等待阶段：把剩余全部预算交给 sessions wait（--timeout 秒数 + 进程超时）。
    const completion = await executeNativeProcess(
      launch,
      [
        'headless',
        'sessions',
        'wait',
        receipt.conversationId,
        '--run',
        receipt.runId,
        '--json',
        '--timeout',
        String(Math.max(1, Math.ceil(remaining / 1000))),
      ],
      { ...processOptions, input: undefined, onLine: undefined, timeoutMs: remaining },
    );
    const result: JsonObject = resultObject(completion);
    activity.read(result);
    if (result.status === 'failed' || result.status === 'cancelled') {
      // 上游已终结且无结果：不再算"已受理"，走普通失败路径。
      accepted = false;
      throw new Error('NATIVE_AGENT_FAILED');
    }
    if (completion.code !== 0 || result.status !== 'completed')
      throw new Error('NATIVE_AGENT_UPSTREAM_PENDING');
    // 成功后清掉"已受理"标记：接下来不需要 stop/persist 兜底。
    accepted = false;
    const collector = new NativeEventCollector('doubao', onProgress);
    collector.read(JSON.stringify(result));
    return collector.result();
  } catch (error: unknown) {
    if (!receipt && error instanceof NativeProcessFailure)
      receipt = receiptFrom(resultObject(error.result));
    if (receipt && (accepted || error instanceof NativeProcessFailure)) {
      // 有凭据且上游在跑：先尝试优雅停止；停不掉就落盘凭据并如实报告"取消未确认"。
      if (!(await stop())) {
        await persist();
        throw new Error('NATIVE_AGENT_CANCEL_UNCONFIRMED');
      }
    } else if (accepted || (submitted && error instanceof NativeProcessFailure)) {
      // 上游已受理但拿不到凭据：只能落盘告知人工检查，任务可能仍在跑。
      await persist();
      throw new Error('NATIVE_AGENT_UPSTREAM_PENDING');
    }
    throw error;
  }
}
