import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeEventCollector } from './events';
import { jsonValues, object, type JsonObject } from './metadata';
import { executeNativeProcess, NativeProcessFailure, type NativeProcessOptions, type NativeProcessResult } from './process';
import type { NativeLaunch } from './resolver';
import type { ResearchActivity } from '../../shared/research-events.interface';
import { NativeActivityCollector } from './activity';
import { providerFailure } from './failures';

function resultObject(result: NativeProcessResult): JsonObject { return object(jsonValues(result.stdout).at(-1)); }
function receiptFrom(value: JsonObject): { conversationId: string; runId: string } | null {
  const nested: JsonObject = object(value.result);
  const receipt: JsonObject = value.conversationId ? value : nested.conversationId ? nested : object(value.recoveryReceipt);
  const valid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/u.test(id);
  return valid(receipt.conversationId) && valid(receipt.runId) ? { conversationId: receipt.conversationId, runId: receipt.runId } : null;
}

/** A Doubao ACK starts an upstream task. Killing `wait` does not cancel it. */
export async function runDoubao(launch: NativeLaunch, args: string[], processOptions: NativeProcessOptions,
  root: string, onProgress: (text: string) => void, onEvent?: (event: ResearchActivity) => void): Promise<{ text: string; usageTokens: number | null }> {
  const activity = new NativeActivityCollector('doubao', onEvent);
  const deadline: number = Date.now() + processOptions.timeoutMs;
  let receipt: { conversationId: string; runId: string } | null = null;
  let accepted: boolean = false;
  let submitted: boolean = false;
  const persist = async (): Promise<void> => {
    await writeFile(join(root, 'doubao-recovery.json'), JSON.stringify({ provider: 'doubao', ...receipt,
      state: 'unconfirmed', submittedAt: new Date().toISOString(), instruction: 'Inspect the existing Doubao task; do not resend this request.' }), { mode: 0o600 });
  };
  const stop = async (): Promise<boolean> => {
    if (!receipt) return false;
    try {
      const result = await executeNativeProcess(launch, ['headless', 'sessions', 'stop', receipt.conversationId,
        '--run', receipt.runId, '--json', '--timeout', '15'], { ...processOptions, input: undefined,
        signal: undefined, onLine: undefined, timeoutMs: 20_000 });
      return result.code === 0 && resultObject(result).stopped === true;
    } catch { return false; }
  };
  try {
    if (processOptions.signal?.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
    // Keep receiving the bounded submission ACK even if cancelled, to stop that exact run.
    submitted = true;
    const submission = await executeNativeProcess(launch,
      [...args.slice(0, -2), '--timeout', String(Math.max(1, Math.ceil(Math.min(processOptions.timeoutMs, 30_000) / 1000))), ...args.slice(-2)],
      { ...processOptions, signal: undefined, timeoutMs: Math.min(processOptions.timeoutMs, 35_000), onLine: undefined });
    const response: JsonObject = resultObject(submission);
    activity.read(response);
    receipt = receiptFrom(response);
    if (!receipt && response.accepted === false && response.status === 'failed') throw providerFailure(response);
    accepted = response.accepted === true || receipt !== null || submission.code === 0;
    if (submission.code !== 0 || !receipt) throw new Error(accepted ? 'NATIVE_AGENT_UPSTREAM_PENDING' : 'NATIVE_AGENT_FAILED');
    if (processOptions.signal?.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
    const remaining: number = deadline - Date.now();
    if (remaining <= 0) throw new Error('NATIVE_AGENT_TIMEOUT');
    onProgress('Analyzing sources…');
    const completion = await executeNativeProcess(launch, ['headless', 'sessions', 'wait', receipt.conversationId,
      '--run', receipt.runId, '--json', '--timeout', String(Math.max(1, Math.ceil(remaining / 1000)))],
      { ...processOptions, input: undefined, onLine: undefined, timeoutMs: remaining });
    const result: JsonObject = resultObject(completion);
    activity.read(result);
    if (result.status === 'failed' || result.status === 'cancelled') { accepted = false; throw providerFailure(result); }
    if (completion.code !== 0 || result.status !== 'completed') throw new Error('NATIVE_AGENT_UPSTREAM_PENDING');
    accepted = false;
    const collector = new NativeEventCollector('doubao', onProgress);
    collector.read(JSON.stringify(result));
    return collector.result();
  } catch (error: unknown) {
    if (!receipt && error instanceof NativeProcessFailure) receipt = receiptFrom(resultObject(error.result));
    if (receipt && (accepted || error instanceof NativeProcessFailure)) {
      if (!await stop()) { await persist(); throw new Error('NATIVE_AGENT_CANCEL_UNCONFIRMED'); }
    } else if (accepted || (submitted && error instanceof NativeProcessFailure)) {
      await persist(); throw new Error('NATIVE_AGENT_UPSTREAM_PENDING');
    }
    throw error;
  }
}
