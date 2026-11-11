import { Inject, Injectable } from '@nestjs/common';
import { createDeepAgent } from 'deepagents';
import { createMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import type { ToolRuntime } from '@langchain/core/tools';
import { BaseMessage } from '@langchain/core/messages';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { canonicalHash, assertFrozenInputSnapshot, parseJsonAction, validateAgentToolDescriptor } from '../../../common/agent-contract';
import type { AgentToolDescriptor, AgentToolScope } from '../../../../shared/agent-tooling.interface';
import type { RuntimeToolCall } from '../../../../shared/research-runtime.interface';
import { ModelStepService } from '../../research-core/model-step.service';
import type { ModelStepPort, ModelStepRequest, ModelStepResult } from '../../research-core/model-step.interface';
import { RuntimeJournalService } from '../runtime-journal.service';
import { RuntimeInvocationsService, RuntimeInvocationUnknownError } from '../runtime-invocations.service';
import type { RuntimeExecuteInput, RuntimeExecuteResult, RuntimeLoopPorts } from '../research-runtime.service';
import { runtimeLimits } from '../runtime-limits';
import { DeepAgentCheckpointsService } from './deep-agent-checkpoints.service';
import { ControlledLangChainModel, DEEP_SYSTEM_MARKER, FEEDBACK_TOOL_NAME, toLangChain } from './controlled-langchain-model';
import { assertDeepAgentsEnvironment, DEEP_AGENTS_POLICY } from './deep-agents-policy';
import type { RuntimeDriver } from './runtime-driver.interface';

class DriverStop extends Error {}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validArgs(descriptor: AgentToolDescriptor, args: Record<string, unknown>): boolean {
  try { return z.fromJSONSchema(descriptor.inputSchema).safeParse(args).success; } catch { return false; }
}

/** Per-run scheduling, never shared across members or owners. */
class ReadScheduler {
  private active = 0;
  private readonly connections = new Set<string>();
  private readonly queue: Array<{ connection: string; start: () => void; stop: () => void }> = [];
  private stopped = false;
  stop(): void {
    this.stopped = true;
    for (const queued of this.queue.splice(0)) queued.stop();
  }
  private drain(): void {
    if (this.stopped) return;
    while (this.active < 2) {
      const index = this.queue.findIndex(item => !this.connections.has(item.connection));
      if (index < 0) return;
      const next = this.queue.splice(index, 1)[0];
      this.active += 1; this.connections.add(next.connection); next.start();
    }
  }
  async run<T>(connection: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new DriverStop('DEEP_AGENT_STOPPED');
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ connection, start: resolve, stop: () => reject(new DriverStop('DEEP_AGENT_STOPPED')) });
      this.drain();
    });
    try { return await operation(); }
    finally { this.active -= 1; this.connections.delete(connection); this.drain(); }
  }
}

/** Actual Deep Agents loop with one guarded, durable model callback and a restricted read-only tool bridge. */
@Injectable()
export class DeepAgentsDriver implements RuntimeDriver {
  readonly id = 'deep_agents' as const;
  constructor(private readonly journal: RuntimeJournalService,
    @Inject(ModelStepService) private readonly model: ModelStepPort,
    private readonly invocations: RuntimeInvocationsService,
    private readonly checkpoints: DeepAgentCheckpointsService) {}

  capabilities() { return { ...DEEP_AGENTS_POLICY, checkpointing: 'durable-model-boundary-transcript' as const,
    restrictions: ['no host filesystem', 'no subagents', 'no automatic summarization', 'no external writes'] }; }

  private normalize(response: ModelStepResult, request: ModelStepRequest, stepId: string, maxCalls: number,
    previousIds: Set<string>): ModelStepResult {
    const feedback = (code: string, ordinal = 0): RuntimeToolCall => ({ id: `feedback-${stepId}-${ordinal}`,
      toolId: FEEDBACK_TOOL_NAME, arguments: { code } });
    let calls = response.toolCalls, text = response.text;
    if (request.jsonActionMode) {
      const action = parseJsonAction(response.text, { stepId, maxToolCalls: maxCalls, catalog: request.catalog.descriptors,
        validateArguments: (descriptor, args) => validArgs(descriptor, args) ? null : 'INVALID_TOOL_ARGUMENTS' });
      calls = [...action.toolCalls, ...action.toolResults.map((error, ordinal) => feedback(error.error.code, ordinal))];
      text = action.text;
    }
    if (calls.length > maxCalls) return { ...response, text, toolCalls: [feedback('TOOL_CALL_LIMIT')] };
    const ids = calls.map(call => call.id);
    if (new Set(ids).size !== ids.length || ids.some(id => previousIds.has(id))) {
      return { ...response, text, toolCalls: [feedback('DUPLICATE_TOOL_CALL')] };
    }
    return { ...response, text, toolCalls: calls.map((call, ordinal) => {
      if (call.toolId === FEEDBACK_TOOL_NAME) return call;
      if (!call.id?.trim() || call.id.length > 160 || /[\u0000-\u001f]/u.test(call.id)) return feedback('INVALID_ACTION_SCHEMA', ordinal);
      const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId);
      if (!descriptor) return feedback('UNKNOWN_TOOL', ordinal);
      if ('invalid' in call && call.invalid || !validArgs(descriptor, call.arguments)) return feedback('INVALID_TOOL_ARGUMENTS', ordinal);
      return call;
    }) };
  }

  async execute(input: RuntimeExecuteInput, ports: RuntimeLoopPorts): Promise<RuntimeExecuteResult> {
    assertDeepAgentsEnvironment();
    if (input.owner !== input.scope.owner || input.runId !== input.scope.runId || input.modelRequest.owner !== input.owner) throw new Error('RUNTIME_SCOPE_MISMATCH');
    const run = await this.journal.read(input.owner, input.runId);
    if (run.driver !== 'deep_agents' || run.identity.sessionId !== input.scope.sessionId || run.identity.revision !== input.scope.revision) throw new Error('RUNTIME_SCOPE_MISMATCH');
    const limits = runtimeLimits(run.policy);
    if (input.modelRequest.catalog.descriptors.some(descriptor => descriptor.effect === 'external_write')) throw new Error('DEEP_AGENT_READ_ONLY_CATALOG_REQUIRED');
    input.modelRequest.catalog.descriptors.forEach(validateAgentToolDescriptor);
    assertFrozenInputSnapshot(run.frozenInput);
    if (canonicalHash(run.frozenInput) !== run.frozenInputHash) throw new Error('RUNTIME_FROZEN_INPUT_CHANGED');
    const initial: ModelStepRequest = clone(input.modelRequest);
    initial.messages.unshift({ role: 'system', content: `Frozen owner input (complete holdings and cash):\n${JSON.stringify(run.frozenInput.payload)}` });
    const { leaseToken: _lease, ...scopeIdentity } = input.scope;
    const contextHash = canonicalHash({ initial, scope: scopeIdentity, policy: run.policy, driver: DEEP_AGENTS_POLICY });
    if (run.state === 'accepted') {
      await ports.assertScope(input.scope, 'accept');
      const last = run.steps.at(-1), raw = await this.journal.response(input.owner, input.runId, last.id) as ModelStepResult;
      const text = this.normalize(raw, initial, last.id, limits.maxToolCallsPerStep, new Set()).text;
      await input.validateFinal(text, input.scope);
      return { status: 'accepted', text };
    }
    const restored = await this.checkpoints.load(input.owner, input.runId, contextHash);
    const claim = await this.journal.claim(input.owner, input.runId);
    if (!claim) return { status: (await this.journal.read(input.owner, input.runId)).state };
    const scope = { ...clone(input.scope), leaseToken: claim.token }, scheduler = new ReadScheduler(), abort = new AbortController();
    const context = { index: restored?.stepIndex ?? 0, stepId: '', calls: new Map<string, RuntimeToolCall>(), finalText: '' };
    const guard = async (stage: 'model' | 'tool' | 'accept', descriptor?: AgentToolDescriptor): Promise<void> => {
      const latest = await this.journal.read(input.owner, input.runId);
      if (abort.signal.aborted || latest.cancelRequested || ['provider_unknown', 'cancelled', 'settled_unknown', 'accepted'].includes(latest.state)) throw new DriverStop('DEEP_AGENT_STOPPED');
      if (!await ports.shouldContinue(scope)) {
        await this.journal.cancel(input.owner, input.runId);
        throw new DriverStop('DEEP_AGENT_STOPPED');
      }
      await ports.assertScope(scope, stage, descriptor);
    };
    const timer = setInterval(() => { void this.journal.heartbeat(input.owner, input.runId, claim.token)
      .then(() => guard('model')).catch(() => { scheduler.stop(); abort.abort(); }); }, 20_000);
    timer.unref();
    const frameworkPrompt = `${DEEP_SYSTEM_MARKER}. Read-only research. Use only the provided tools. Preserve complete frozen owner input.`;
    try {
      const controlledModel = new ControlledLangChainModel(async messages => {
        await guard('model');
        if (context.index >= limits.maxSteps) throw new Error('RUNTIME_STEP_LIMIT');
        // Strip only the framework's leading system message; literals inside owner facts stay intact.
        const stateMessages = messages.filter((message, ordinal) => ordinal !== 0 || message.role !== 'system'
          || !message.content.endsWith(frameworkPrompt));
        await this.checkpoints.save(input.owner, input.runId, claim.token, contextHash,
          { stepIndex: context.index, messages: stateMessages });
        const request: ModelStepRequest = { ...clone(initial), messages: clone(messages) };
        const existing = (await this.journal.read(input.owner, input.runId)).steps[context.index];
        if (existing && (existing.requestHash !== canonicalHash(request) || existing.model !== request.model)) throw new Error('RUNTIME_REQUEST_CONFLICT');
        const receipt = existing ? { step: existing, fresh: false } : await this.journal.beginStep(input.owner, input.runId, claim.token,
          { index: context.index, model: request.model, request }, async (tx, identity) => ports.dispatch.reserve(tx,
            { ...identity, owner: input.owner, runId: input.runId, model: request.model, request }));
        let raw: ModelStepResult;
        if (receipt.fresh) {
          await guard('model');
          try { raw = await this.model.generate(request, abort.signal); }
          catch {
            await this.journal.markUnknown(input.owner, input.runId, claim.token, 'MODEL_TRANSPORT_UNKNOWN');
            throw new DriverStop('MODEL_TRANSPORT_UNKNOWN');
          }
          await this.journal.receive(input.owner, input.runId, receipt.step.id, raw);
        } else {
          if (!receipt.step.responseEnc) {
            await this.journal.markUnknown(input.owner, input.runId, claim.token, 'MODEL_RECEIPT_UNRESOLVED');
            throw new DriverStop('MODEL_RECEIPT_UNRESOLVED');
          }
          raw = await this.journal.response(input.owner, input.runId, receipt.step.id) as ModelStepResult;
        }
        if (receipt.step.budgetId) await ports.dispatch.settle(input.owner, receipt.step.budgetId, raw.usage);
        await guard('model');
        await this.invocations.assertResolved(input.owner, input.runId, receipt.step.id);
        const previousIds = new Set<string>();
        for (const message of messages) if (message.role === 'assistant' && Array.isArray(message.content)) {
          for (const part of message.content) if (part.type === 'tool-call') previousIds.add(part.toolCallId);
        }
        const normalized = this.normalize(raw, request, receipt.step.id, limits.maxToolCallsPerStep, previousIds);
        if (!normalized.toolCalls.length) {
          try {
            if (!normalized.text.trim() || ['length', 'error'].includes(raw.finishReason)) throw new Error('MODEL_FINAL_INVALID');
            await input.validateFinal(normalized.text, scope);
          } catch {
            await this.journal.recordParse(input.owner, input.runId, receipt.step.id, false, 'MODEL_FINAL_INVALID',
              { leaseToken: claim.token, parserVersion: 'deep-agents-read-only-v1' });
            throw new DriverStop('MODEL_FINAL_INVALID');
          }
          context.finalText = normalized.text;
        }
        if (receipt.step.state !== 'parsed') await this.journal.recordParse(input.owner, input.runId, receipt.step.id, true, null,
          { leaseToken: claim.token, parserVersion: 'deep-agents-read-only-v1' });
        context.stepId = receipt.step.id;
        context.calls = new Map(normalized.toolCalls.map(call => [call.id, call]));
        context.index += 1;
        return normalized;
      }, initial.catalog.aliases);
      const tools = initial.catalog.descriptors.map(descriptor => {
        const alias = Object.keys(initial.catalog.aliases).find(name => initial.catalog.aliases[name] === descriptor.id);
        if (!alias) throw new Error('DEEP_AGENT_TOOL_ALIAS_INVALID');
        return tool(async (args: Record<string, unknown>, runtime: ToolRuntime) => {
          const call = context.calls.get(runtime.toolCallId);
          if (!call || call.toolId !== descriptor.id || canonicalHash(call.arguments) !== canonicalHash(args)) throw new Error('DEEP_AGENT_TOOL_IDENTITY_CONFLICT');
          return scheduler.run(descriptor.connectionId ?? `builtin:${descriptor.id}`, async () => {
            try {
              await guard('tool', descriptor);
              const outcome = await this.invocations.execute({ owner: input.owner, runId: input.runId, stepId: context.stepId,
                leaseToken: claim.token, descriptor, call }, async invocationId => {
                await guard('tool', descriptor);
                const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(descriptor.timeoutMs)]);
                return Promise.race([ports.tools.invoke(descriptor, args, scope, invocationId, signal),
                  new Promise<never>((_resolve, reject) => signal.addEventListener('abort',
                    () => reject(new Error('TOOL_TIMEOUT_OR_STOP')), { once: true }))]);
              }, ports.tools.receipts);
              return JSON.stringify(outcome.result);
            } catch (error) {
              scheduler.stop();
              if (error instanceof RuntimeInvocationUnknownError) {
                await this.journal.markUnknown(input.owner, input.runId, claim.token, 'TOOL_RECEIPT_UNRESOLVED');
              }
              throw error;
            }
          });
        }, { name: alias, description: descriptor.description, schema: z.object({}).catchall(z.unknown()) });
      });
      const feedbackTool = tool(async ({ code }: { code: string }) => JSON.stringify({ status: 'failed',
        error: { code, retryable: false } }), { name: FEEDBACK_TOOL_NAME, description: 'Local structured action feedback',
        schema: z.object({ code: z.string().max(160) }) });
      // Per-instance replacements suppress framework capabilities instead of registering global profiles.
      const neutralState = z.object({ deepDriverVersion: z.literal('1').optional() });
      const graph = createDeepAgent({ model: controlledModel, tools: [...tools, feedbackTool],
        systemPrompt: frameworkPrompt,
        stateSchema: neutralState,
        middleware: [createMiddleware({ name: 'FilesystemMiddleware', tools: [], stateSchema: neutralState }),
          createMiddleware({ name: 'subAgentMiddleware', tools: [], stateSchema: neutralState }),
          createMiddleware({ name: 'SummarizationMiddleware', tools: [], stateSchema: neutralState })] as const,
        subagents: [], memory: [], skills: [], checkpointer: false,
        permissions: [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }] });
      const state: unknown = { messages: toLangChain(restored?.messages ?? initial.messages) };
      // The SDK's conditional middleware-state type widens to `never` with strictNullChecks=false.
      // Validate the actual message-only graph boundary instead of casting an unrelated model type.
      const messageState = (value: unknown): value is Parameters<typeof graph.invoke>[0] => {
        if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages)) return false;
        return value.messages.every(message => BaseMessage.isInstance(message));
      };
      if (!messageState(state)) throw new Error('DEEP_AGENT_MESSAGE_STATE_INVALID');
      await graph.invoke(state,
        { recursionLimit: limits.maxSteps * 4 + 4, maxConcurrency: 2, signal: abort.signal, callbacks: [] });
      if (!context.finalText) throw new Error('DEEP_AGENT_FINAL_REQUIRED');
      await guard('accept');
      await this.journal.accept(input.owner, input.runId, claim.token);
      return { status: 'accepted', text: context.finalText };
    } catch (error) {
      scheduler.stop();
      const latest = await this.journal.read(input.owner, input.runId);
      if (latest.leaseToken !== claim.token || !latest.leaseUntil || latest.leaseUntil <= new Date()) {
        return { status: latest.state, code: 'RUNTIME_LEASE_EXPIRED' };
      }
      if (error instanceof RuntimeInvocationUnknownError && latest.state !== 'provider_unknown') {
        await this.journal.markUnknown(input.owner, input.runId, claim.token, 'TOOL_RECEIPT_UNRESOLVED');
      } else if (!['provider_unknown', 'cancelled', 'settled_unknown'].includes(latest.state)) {
        await this.journal.fail(input.owner, input.runId, claim.token,
          error instanceof Error && ['MODEL_FINAL_INVALID', 'RUNTIME_STEP_LIMIT'].includes(error.message) ? error.message : 'DEEP_AGENT_LOCAL_FAILURE');
      }
      return { status: (await this.journal.read(input.owner, input.runId)).state };
    } finally {
      clearInterval(timer);
      try { await this.journal.release(input.owner, input.runId, claim.token); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'RUNTIME_LEASE_EXPIRED') throw error; }
    }
  }
}
