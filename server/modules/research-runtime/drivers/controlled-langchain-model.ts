import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { ModelMessage } from 'ai';
import type { ModelStepResult } from '../../research-core/model-step.interface';

export const DEEP_SYSTEM_MARKER = 'Squabble Deep Agents driver v1';
export const FEEDBACK_TOOL_NAME = 'runtime_feedback';

function text(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content.some(part => part.type !== 'text')) throw new Error('DEEP_AGENT_MULTIMODAL_UNSUPPORTED');
  return content.map(part => 'text' in part ? String(part.text) : '').join('');
}
export function fromLangChain(messages: BaseMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [], names = new Map<string, string>();
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.name);
      result.push({ role: 'assistant', content: [
        ...(text(message.content) ? [{ type: 'text' as const, text: text(message.content) }] : []),
        ...(message.tool_calls ?? []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id,
          toolName: call.name, input: call.args })),
      ] });
    } else if (ToolMessage.isInstance(message)) {
      result.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.tool_call_id,
        toolName: message.name ?? names.get(message.tool_call_id) ?? FEEDBACK_TOOL_NAME,
        output: { type: 'text', value: text(message.content) } }] });
    } else if (message.type === 'system') result.push({ role: 'system', content: text(message.content) });
    else if (message.type === 'human') result.push({ role: 'user', content: text(message.content) });
    else throw new Error('DEEP_AGENT_MESSAGE_UNSUPPORTED');
  }
  return result;
}
export function toLangChain(messages: ModelMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') result.push(new SystemMessage(message.content));
    else if (message.role === 'user') {
      if (typeof message.content !== 'string') throw new Error('DEEP_AGENT_MULTIMODAL_UNSUPPORTED');
      result.push(new HumanMessage(message.content));
    } else if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
      if (parts.some(part => !['text', 'tool-call'].includes(part.type))) throw new Error('DEEP_AGENT_MESSAGE_UNSUPPORTED');
      result.push(new AIMessage({ content: parts.filter(part => part.type === 'text').map(part => part.text).join(''),
        tool_calls: parts.filter(part => part.type === 'tool-call').map(part => ({ id: part.toolCallId,
          name: part.toolName, args: part.input as Record<string, unknown>, type: 'tool_call' as const })) }));
    } else {
      for (const part of message.content) {
        if (part.type !== 'tool-result') throw new Error('DEEP_AGENT_APPROVAL_UNSUPPORTED');
        result.push(new ToolMessage({ name: part.toolName, tool_call_id: part.toolCallId,
          content: part.output.type === 'text' ? part.output.value : JSON.stringify(part.output) }));
      }
    }
  }
  return result;
}

/** A real LangChain model interface; the callback is the only route to an actual model request. */
export class ControlledLangChainModel extends BaseChatModel {
  constructor(private readonly generateStep: (messages: ModelMessage[], signal?: AbortSignal) => Promise<ModelStepResult>,
    private readonly aliases: Record<string, string>) {
    super({ maxRetries: 0, cache: false, verbose: false, disableStreaming: true, callbacks: [] });
  }
  _llmType(): string { return 'squabble-controlled-runtime'; }
  bindTools(tools: BindToolsInput[]): this {
    const allowed = new Set([...Object.keys(this.aliases), FEEDBACK_TOOL_NAME]);
    for (const value of tools) {
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !allowed.has(candidate.name)) throw new Error('DEEP_AGENT_UNCONTROLLED_TOOL');
    }
    return this;
  }
  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const result = await this.generateStep(fromLangChain(messages), options.signal);
    const toolCalls = result.toolCalls.map(call => ({ id: call.id,
      name: call.toolId === FEEDBACK_TOOL_NAME ? FEEDBACK_TOOL_NAME
        : Object.keys(this.aliases).find(alias => this.aliases[alias] === call.toolId),
      args: call.arguments, type: 'tool_call' as const }));
    if (toolCalls.some(call => !call.name)) throw new Error('DEEP_AGENT_UNCONTROLLED_TOOL');
    const message = new AIMessageChunk({ content: result.text, tool_calls: toolCalls });
    return { generations: [{ text: result.text, message }], llmOutput: { usageKnown: result.usage !== null,
      usage: result.usage, providerRequestId: result.providerRequestId } };
  }
}
