import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { AgentToolDescriptor, AgentToolErrorResult, AgentToolScope } from '../../../shared/agent-tooling.interface';
import type { RuntimeFrozenInputSnapshot, RuntimeToolCall } from '../../../shared/research-runtime.interface';
import { ModelStepService } from '../research-core/model-step.service';
import type { ModelStepPort, ModelStepRequest, ModelStepResult, ModelStepUsage } from '../research-core/model-step.interface';
import { RuntimeJournalService } from './runtime-journal.service';
import { RuntimeInvocationsService, RuntimeInvocationUnknownError } from './runtime-invocations.service';
import type { RuntimeInvocationHooks } from './runtime-invocations.service';
import { assertFrozenInputSnapshot, canonicalHash, parseJsonAction, validateAgentToolDescriptor } from './runtime-contract';
import { runtimeLimits } from './runtime-limits';

type RuntimeTx = Parameters<Parameters<import('../../common/platform').PostgresJsDatabase['transaction']>[0]>[0];
export interface RuntimeLoopPorts {
  dispatch: {
    reserve(tx: RuntimeTx, input: { owner: string; runId: string; dispatchKey: string; requestHash: string;
      model: string; request: ModelStepRequest }): Promise<{ budgetId: string }>;
    settle(owner: string, budgetId: string, usage: ModelStepUsage | null, failed?: boolean): Promise<void>;
  };
  assertScope(scope: AgentToolScope, stage: 'model' | 'tool' | 'accept', descriptor?: AgentToolDescriptor): Promise<void>;
  shouldContinue(scope: AgentToolScope): Promise<boolean>;
  tools: { invoke(descriptor: AgentToolDescriptor, args: Record<string, unknown>, scope: AgentToolScope,
    invocationId: string, signal?: AbortSignal): Promise<unknown>; receipts?: RuntimeInvocationHooks };
  approvals: { park(input: { owner: string; runId: string; stepId: string; scope: AgentToolScope;
    calls: RuntimeToolCall[]; catalog: ModelStepRequest['catalog'] }): Promise<{
      status: 'waiting_approval' | 'completed'; results: Array<{ call: RuntimeToolCall; result: unknown }>;
    }> };
}
export interface RuntimeExecuteInput {
  owner: string; runId: string; modelRequest: ModelStepRequest; scope: AgentToolScope;
  /** Exact turn/evidence parser. Failure is local and never schedules model repair. */
  validateFinal(text: string, scope: AgentToolScope): Promise<void>;
}
export interface RuntimeExecuteResult { status: string; text?: string; code?: string }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateArguments(descriptor: AgentToolDescriptor, args: Record<string, unknown>): string | null {
  try { return z.fromJSONSchema(descriptor.inputSchema).safeParse(args).success ? null : 'INVALID_TOOL_ARGUMENTS'; }
  catch { return 'INVALID_TOOL_ARGUMENTS'; }
}

/** The sole owner of model/tool iteration. Saved receipts are inputs, never new send permissions. */
@Injectable()
export class ResearchRuntimeService {
  constructor(private readonly journal: RuntimeJournalService,
    @Inject(ModelStepService) private readonly model: ModelStepPort,
    private readonly invocations: RuntimeInvocationsService,
    @Optional() @Inject('RUNTIME_LOOP_PORTS') private readonly ports?: RuntimeLoopPorts) {}

  initialRequest(request: ModelStepRequest, frozenInput: unknown): ModelStepRequest {
    assertFrozenInputSnapshot(frozenInput);
    const complete = clone(request);
    complete.messages = [{ role: 'system', content: `Frozen owner input (complete holdings and cash):\n${JSON.stringify(frozenInput.payload)}` }, ...complete.messages];
    return complete;
  }

  private async guard(scope: AgentToolScope, stage: 'model' | 'tool' | 'accept', descriptor?: AgentToolDescriptor): Promise<boolean> {
    if (!this.ports) throw new Error('RUNTIME_PORTS_UNAVAILABLE');
    const run = await this.journal.read(scope.owner, scope.runId);
    if (run.cancelRequested || ['cancelled', 'cancelling', 'settled_unknown', 'accepted', 'provider_unknown'].includes(run.state)) return false;
    if (!await this.ports.shouldContinue(scope)) {
      await this.journal.cancel(scope.owner, scope.runId);
      return false;
    }
    await this.ports.assertScope(scope, stage, descriptor);
    return true;
  }

  private feedback(stepId: string, ordinal: number, code: AgentToolErrorResult['error']['code'], call?: RuntimeToolCall): AgentToolErrorResult {
    return { toolCallId: call?.id ?? `feedback-${stepId}-${ordinal}`, toolId: call?.toolId ?? null,
      status: 'failed', error: { code, message: code, retryable: false } };
  }

  private actions(response: ModelStepResult, request: ModelStepRequest, stepId: string, maxCalls: number,
    priorIds: Set<string>): { calls: RuntimeToolCall[]; errors: AgentToolErrorResult[]; text: string } {
    if (request.jsonActionMode) {
      const parsed = parseJsonAction(response.text, { stepId, catalog: request.catalog.descriptors,
        maxToolCalls: maxCalls, validateArguments });
      if (parsed.toolCalls.some(call => priorIds.has(call.id))) {
        return { calls: [], errors: [this.feedback(stepId, 0, 'DUPLICATE_TOOL_CALL')], text: parsed.text };
      }
      return { calls: parsed.toolCalls, errors: parsed.toolResults.map((error, ordinal) =>
        priorIds.has(error.toolCallId) ? { ...error, toolCallId: `feedback-${stepId}-${ordinal}` } : error), text: parsed.text };
    }
    if (response.toolCalls.length > maxCalls) return { calls: [], errors: [this.feedback(stepId, 0, 'TOOL_CALL_LIMIT')], text: response.text };
    const ids = response.toolCalls.map(call => call.id);
    if (new Set(ids).size !== ids.length || ids.some(id => priorIds.has(id))) {
      return { calls: [], errors: [this.feedback(stepId, 0, 'DUPLICATE_TOOL_CALL')], text: response.text };
    }
    const calls: RuntimeToolCall[] = [], errors: AgentToolErrorResult[] = [];
    response.toolCalls.forEach((call, ordinal) => {
      if (typeof call.id !== 'string' || !call.id.trim() || call.id.length > 160 || /[\u0000-\u001f]/u.test(call.id)) {
        errors.push(this.feedback(stepId, ordinal, 'INVALID_ACTION_SCHEMA'));
        return;
      }
      const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId);
      if (!descriptor) errors.push(this.feedback(stepId, ordinal, 'UNKNOWN_TOOL', call));
      else if (call.invalid || validateArguments(descriptor, call.arguments)) errors.push(this.feedback(stepId, ordinal, 'INVALID_TOOL_ARGUMENTS', call));
      else calls.push(call);
    });
    return { calls, errors, text: response.text };
  }

  private appendAssistant(messages: ModelMessage[], text: string, calls: RuntimeToolCall[], errors: AgentToolErrorResult[],
    catalog: ModelStepRequest['catalog']): void {
    const alias = (id: string): string => Object.keys(catalog.aliases).find(name => catalog.aliases[name] === id) ?? 'runtime_feedback';
    messages.push({ role: 'assistant', content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: alias(call.toolId), input: call.arguments })),
      ...errors.map(error => ({ type: 'tool-call' as const, toolCallId: error.toolCallId,
        toolName: alias(error.toolId ?? ''), input: {} })),
    ] });
    for (const error of errors) this.appendResult(messages, error.toolCallId, alias(error.toolId ?? ''), error);
  }

  private appendResult(messages: ModelMessage[], id: string, name: string, output: unknown): void {
    messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: name,
      output: { type: 'text', value: JSON.stringify(output) } }] });
  }

  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult> {
    if (!this.ports) throw new Error('RUNTIME_PORTS_UNAVAILABLE');
    if (input.owner !== input.scope.owner || input.runId !== input.scope.runId
      || input.modelRequest.owner !== input.owner) throw new Error('RUNTIME_SCOPE_MISMATCH');
    let run = await this.journal.read(input.owner, input.runId);
    if (run.identity.sessionId !== input.scope.sessionId || run.identity.revision !== input.scope.revision) {
      throw new Error('RUNTIME_SCOPE_MISMATCH');
    }
    const limits = runtimeLimits(run.policy);
    const frozen = run.frozenInput as RuntimeFrozenInputSnapshot;
    if (canonicalHash(frozen) !== run.frozenInputHash) throw new Error('RUNTIME_FROZEN_INPUT_CHANGED');
    const request = this.initialRequest(input.modelRequest, frozen);
    request.catalog.descriptors.forEach(validateAgentToolDescriptor);
    if (run.state === 'accepted') {
      const last = run.steps.at(-1);
      const saved = last ? await this.journal.response(input.owner, input.runId, last.id) as ModelStepResult : null;
      await this.ports.assertScope(input.scope, 'accept');
      const text = saved ? this.actions(saved, request, last.id, limits.maxToolCallsPerStep, new Set()).text : '';
      await input.validateFinal(text, input.scope);
      return { status: 'accepted', text };
    }
    const claim = await this.journal.claim(input.owner, input.runId);
    if (!claim) return { status: (await this.journal.read(input.owner, input.runId)).state };
    const scope = { ...clone(input.scope), leaseToken: claim.token };
    const abort = new AbortController();
    const timer = setInterval(() => {
      void this.journal.heartbeat(input.owner, input.runId, claim.token)
        .then(async () => { if (!await this.guard(scope, 'model')) abort.abort(); })
        .catch(() => abort.abort());
    }, 20_000);
    timer.unref();
    const priorIds = new Set<string>();
    try {
      for (let index = 0; index < limits.maxSteps; index += 1) {
        if (!await this.guard(scope, 'model')) return { status: (await this.journal.read(input.owner, input.runId)).state };
        const stepRequest = clone(request);
        const existing = (await this.journal.read(input.owner, input.runId)).steps[index];
        if (existing && (existing.model !== request.model || existing.requestHash !== canonicalHash(stepRequest))) {
          throw new Error('RUNTIME_REQUEST_CONFLICT');
        }
        const { step, fresh } = existing ? { step: existing, fresh: false }
          : await this.journal.beginStep(input.owner, input.runId, claim.token,
            { index, model: request.model, request: stepRequest },
            async (tx, identity) => this.ports.dispatch.reserve(tx, { ...identity, owner: input.owner,
              runId: input.runId, model: request.model, request: stepRequest }));
        let response: ModelStepResult;
        if (!fresh) {
          if (!step.responseEnc) {
            await this.journal.markUnknown(input.owner, input.runId, claim.token, 'MODEL_RECEIPT_UNRESOLVED');
            return { status: 'provider_unknown' };
          }
          response = await this.journal.response(input.owner, input.runId, step.id) as ModelStepResult;
        } else {
          if (!await this.guard(scope, 'model') || abort.signal.aborted) {
            await this.journal.markUnknown(input.owner, input.runId, claim.token, 'STOPPED_BEFORE_MODEL_SEND');
            return { status: 'provider_unknown' };
          }
          try { response = await this.model.generate(stepRequest, abort.signal); }
          catch {
            await this.journal.markUnknown(input.owner, input.runId, claim.token, 'MODEL_TRANSPORT_UNKNOWN');
            return { status: 'provider_unknown' };
          }
          await this.journal.receive(input.owner, input.runId, step.id, response);
        }
        // Reconcile saved output after a crash between response persistence and billing settlement.
        if (step.budgetId) await this.ports.dispatch.settle(input.owner, step.budgetId, response.usage);
        if (!await this.guard(scope, 'model')) return { status: (await this.journal.read(input.owner, input.runId)).state };
        const action = this.actions(response, request, step.id, limits.maxToolCallsPerStep, priorIds);
        const final = !action.calls.length && !action.errors.length;
        if (final) {
          try {
            if (!action.text.trim() || response.finishReason === 'length' || response.finishReason === 'error') throw new Error('MODEL_FINAL_INVALID');
            await input.validateFinal(action.text, scope);
          } catch {
            await this.journal.recordParse(input.owner, input.runId, step.id, false, 'MODEL_FINAL_INVALID',
              { leaseToken: claim.token, parserVersion: 'controlled-loop-v1' });
            return { status: 'failed', code: 'MODEL_FINAL_INVALID' };
          }
        }
        if (step.state !== 'parsed') await this.journal.recordParse(input.owner, input.runId, step.id, true, null,
          { leaseToken: claim.token, parserVersion: 'controlled-loop-v1' });
        this.appendAssistant(request.messages, action.text, action.calls, action.errors, request.catalog);
        [...action.calls.map(call => call.id), ...action.errors.map(error => error.toolCallId)].forEach(id => priorIds.add(id));
        if (final) {
          if (!await this.guard(scope, 'accept')) return { status: (await this.journal.read(input.owner, input.runId)).state };
          await this.journal.accept(input.owner, input.runId, claim.token);
          return { status: 'accepted', text: action.text };
        }
        const reads = action.calls.filter(call => request.catalog.descriptors.find(tool => tool.id === call.toolId)?.effect !== 'external_write');
        const writes = action.calls.filter(call => !reads.includes(call));
        try { await this.invocations.assertResolved(input.owner, input.runId, step.id); }
        catch (error) {
          if (!(error instanceof RuntimeInvocationUnknownError)) throw error;
          await this.journal.markUnknown(input.owner, input.runId, claim.token, 'TOOL_RECEIPT_UNRESOLVED');
          return { status: 'provider_unknown' };
        }
        const remaining = [...reads];
        const outputs = new Map<string, unknown>();
        while (remaining.length) {
          const batch: RuntimeToolCall[] = [], connections = new Set<string>();
          for (const call of remaining) {
            const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId)!;
            const connection = descriptor.connectionId ?? `builtin:${descriptor.id}`;
            if (connections.has(connection)) continue;
            batch.push(call); connections.add(connection);
            if (batch.length === 2) break;
          }
          const completed = await Promise.allSettled(batch.map(async call => {
            const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId)!;
            if (!await this.guard(scope, 'tool', descriptor) || abort.signal.aborted) throw new Error('RUNTIME_STOPPED');
            const saved = await this.invocations.execute({ owner: input.owner, runId: input.runId, stepId: step.id,
              leaseToken: claim.token, descriptor, call }, async invocationId => {
              if (!await this.guard(scope, 'tool', descriptor)) throw new Error('RUNTIME_STOPPED');
              const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(descriptor.timeoutMs)]);
              return Promise.race([
                this.ports.tools.invoke(descriptor, call.arguments, scope, invocationId, signal),
                new Promise<never>((_resolve, reject) => signal.addEventListener('abort',
                  () => reject(new Error('RUNTIME_TOOL_TIMEOUT_OR_STOP')), { once: true })),
              ]);
            }, this.ports.tools.receipts);
            outputs.set(call.id, saved.result);
          }));
          const failure = completed.find(item => item.status === 'rejected');
          if (failure?.status === 'rejected') {
            if (failure.reason instanceof RuntimeInvocationUnknownError) {
              await this.journal.markUnknown(input.owner, input.runId, claim.token, 'TOOL_RECEIPT_UNRESOLVED');
              return { status: 'provider_unknown' };
            }
            throw failure.reason;
          }
          for (const call of batch) remaining.splice(remaining.indexOf(call), 1);
        }
        for (const call of reads) {
          const alias = Object.keys(request.catalog.aliases).find(name => request.catalog.aliases[name] === call.toolId)!;
          this.appendResult(request.messages, call.id, alias, outputs.get(call.id));
        }
        if (writes.length) {
          for (const call of writes) {
            const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId)!;
            if (!await this.guard(scope, 'tool', descriptor)) return { status: (await this.journal.read(input.owner, input.runId)).state };
          }
          const approval = await this.ports.approvals.park({ owner: input.owner, runId: input.runId, stepId: step.id,
            scope, calls: writes, catalog: request.catalog });
          if (approval.status === 'waiting_approval') {
            await this.journal.parkApproval(input.owner, input.runId, claim.token);
            return { status: 'waiting_approval' };
          }
          if (approval.results.length !== writes.length
            || new Set(approval.results.map(item => item.call.id)).size !== writes.length
            || approval.results.some(item => !writes.some(call => canonicalHash(call) === canonicalHash(item.call)))) {
            await this.journal.fail(input.owner, input.runId, claim.token, 'RUNTIME_APPROVAL_RESULT_INVALID');
            return { status: 'failed', code: 'RUNTIME_APPROVAL_RESULT_INVALID' };
          }
          for (const item of approval.results) {
            const alias = Object.keys(request.catalog.aliases).find(name => request.catalog.aliases[name] === item.call.toolId)!;
            this.appendResult(request.messages, item.call.id, alias, item.result);
          }
        }
        run = await this.journal.read(input.owner, input.runId);
      }
      await this.journal.fail(input.owner, input.runId, claim.token, 'RUNTIME_STEP_LIMIT');
      return { status: 'failed', code: 'RUNTIME_STEP_LIMIT' };
    } catch {
      await this.journal.fail(input.owner, input.runId, claim.token, 'RUNTIME_SCOPE_OR_EXECUTION_FAILED');
      return { status: (await this.journal.read(input.owner, input.runId)).state, code: 'RUNTIME_SCOPE_OR_EXECUTION_FAILED' };
    } finally {
      clearInterval(timer);
      try { await this.journal.release(input.owner, input.runId, claim.token); }
      catch (error) {
        // A replacement lease owns cleanup; do not hide the original execution result.
        if (!(error instanceof Error) || error.message !== 'RUNTIME_LEASE_EXPIRED') throw error;
      }
    }
  }
}
