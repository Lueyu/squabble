import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchActivity } from '../../shared/research-events.interface';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import { NativeEventCollector } from './events';

const fixtures: Partial<Record<LocalAgentProvider, unknown[]>> = {
  codex: [{ type: 'item.started', item: { id: 'call1', type: 'web_search', query: 'PRIVATE_SECRET' } },
    { type: 'item.completed', item: { id: 'call1', type: 'web_search', query: 'PRIVATE_SECRET' } }],
  claude: [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call1', name: 'WebSearch', input: { secret: 'PRIVATE_SECRET' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'PRIVATE_SECRET' }] } }],
  gemini: [{ type: 'tool_use', tool_id: 'call1', tool_name: 'google_web_search', parameters: { secret: 'PRIVATE_SECRET' } },
    { type: 'tool_result', tool_id: 'call1', status: 'success', output: 'PRIVATE_SECRET' }],
  antigravity: [{ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'search_web', text: 'PRIVATE_SECRET' } }],
  opencode: [{ type: 'tool_use', part: { callID: 'call1', tool: 'websearch', state: { status: 'running', input: 'PRIVATE_SECRET' } } },
    { type: 'tool_use', part: { callID: 'call1', tool: 'websearch', state: { status: 'completed', output: 'PRIVATE_SECRET' } } }],
  kimi: [{ role: 'assistant', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'WebSearch', arguments: 'PRIVATE_SECRET' } }] }],
  doubao: [{ status: 'running', reply: null }, { status: 'completed', reply: { role: 'assistant', text: 'Research complete' } }],
};
for (const [provider, lines] of Object.entries(fixtures)) {
  test(`${provider} emits only bounded public activity from its native JSONL fixture`, () => {
    const activity: ResearchActivity[] = [];
    const collector = new NativeEventCollector(provider as LocalAgentProvider, () => undefined, event => activity.push(event));
    for (const line of lines) collector.read(JSON.stringify(line));
    assert.ok(activity.length > 0);
    assert.equal(JSON.stringify(activity).includes('PRIVATE_SECRET'), false);
    assert.ok(activity.every(event => event.summary.length <= 240 && event.id && event.at));
    if (['codex', 'claude', 'gemini', 'opencode'].includes(provider)) {
      assert.deepEqual(activity.filter(event => event.kind === 'tool').map(event => event.status), ['running', 'succeeded']);
      const tools = activity.filter(event => event.kind === 'tool');
      assert.equal(tools[0].callId, tools[1].callId); assert.ok(tools[1].durationMs! >= 0);
      collector.read(JSON.stringify(lines[lines.length - 1]));
      assert.equal(activity.filter(event => event.kind === 'tool').length, 2);
    }
  });
}

test('private thinking, raw commands, unknown names, IDs and Squabble tool duplicates never enter activity', () => {
  const activity: ResearchActivity[] = [];
  const collector = new NativeEventCollector('codex', () => undefined, event => activity.push(event));
  for (const item of [
    { id: 'secret-id', type: 'reasoning', text: 'PRIVATE_REASONING' },
    { id: 'Bearer secret', type: 'command_execution', command: 'PRIVATE_COMMAND' },
    { id: 'squabble-call', type: 'mcp_tool_call', server: 'squabble_123', tool: 'quote', arguments: 'PRIVATE_INPUT' },
  ]) collector.read(JSON.stringify({ type: 'item.started', item }));
  assert.equal(activity.length, 1); assert.equal(activity[0].toolName, 'shell');
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_|secret|Bearer|squabble/iu);
  for (const provider of ['claude', 'gemini', 'opencode', 'kimi'] as const) {
    const events = new NativeEventCollector(provider, () => undefined, event => activity.push(event));
    events.read(JSON.stringify({ type: 'reasoning', role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }] }));
  }
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_/u);
});

test('Kimi does not invent tool completion from a tool message with no documented outcome', () => {
  const events: ResearchActivity[] = [];
  const collector = new NativeEventCollector('kimi', () => undefined, event => events.push(event));
  collector.read(JSON.stringify(fixtures.kimi![0]));
  collector.read(JSON.stringify({ role: 'tool', tool_call_id: 'call1', content: 'opaque result' }));
  assert.deepEqual(events.map(event => event.status), ['running']);
});
