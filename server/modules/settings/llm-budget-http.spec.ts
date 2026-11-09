import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import { LlmService } from '../research-core/llm.service';
import { BudgetExceededException, estimateInputTokens, settleTokenUsage } from '../llm-budget/llm-budget.rules';
import type { BudgetReservation, LlmBudgetService, ReserveBudgetRequest } from '../llm-budget/llm-budget.service';
import type { SettingsService } from './settings.service';

const settings = (model = 'test', baseUrl = 'https://provider.invalid/v1') => ({ getLlmConfig: async () => ({
  source: 'server', baseUrl, fastModel: model, slowModel: model, apiKey: 'private',
}) }) as SettingsService;

test('pausing a council stops retry reservations after an in-flight provider failure', async () => {
  const harness = budgetHarness();
  const original = axios.defaults.adapter;
  let calls = 0;
  let running = true;
  axios.defaults.adapter = async (config) => {
    calls += 1; running = false;
    return { status: 503, statusText: '', headers: {}, config, data: {} };
  };
  try {
    await assert.rejects(new LlmService(settings(), harness.service).chatFast([{ role: 'user', content: 'fact' }], 'alice', {
      taskId: 'paused-council', shouldContinue: async () => running,
    }), /cancelled/);
    assert.equal(calls, 1);
    assert.equal(harness.reservations.length, 1);
    assert.equal(harness.settlements[0].failed, true);
  } finally { axios.defaults.adapter = original; }
});

test('all bounded DeepSeek calls disable thinking without raising output limits or switching models', async () => {
  const original = axios.defaults.adapter;
  const cases = [
    { url: 'https://api.deepseek.com', model: 'deepseek-flash', purpose: 'council:manager', disabled: true },
    { url: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', purpose: 'connection-test', disabled: true },
    { url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', purpose: 'council:researcher', disabled: true },
    { url: 'https://api.deepseek.com', model: 'deepseek-flash', purpose: 'daily-analysis:debate', disabled: true },
    { url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', purpose: undefined, disabled: true },
    { url: 'https://provider.invalid/v1', model: 'deepseek-flash', purpose: 'council:manager', disabled: false },
    { url: 'https://api.deepseek.com.other.invalid/v1', model: 'deepseek-flash', purpose: 'council:manager', disabled: false },
    { url: 'https://api.deepseek.com', model: 'deepseek-flash', purpose: 'analysis-rating', disabled: true },
    { url: 'https://api.deepseek.com', model: 'deepseek-flash', purpose: 'builder-review', disabled: true },
    { url: 'https://api.deepseek.com', model: 'deepseek-reasoner', purpose: 'builder-review', disabled: false },
  ];
  try {
    for (const item of cases) {
      const harness = budgetHarness();
      let calls = 0;
      axios.defaults.adapter = async config => {
        calls++;
        const body = JSON.parse(String(config.data));
        assert.equal(body.model, item.model);
        assert.equal(body.max_tokens, 16);
        assert.deepEqual(body.thinking, item.disabled ? { type: 'disabled' } : undefined);
        return { status: 200, statusText: '', headers: {}, config,
          data: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } };
      };
      const response = await new LlmService(settings(item.model, item.url), harness.service)
        .chatFast([{ role: 'user', content: 'OK only' }], 'alice', { purpose: item.purpose, maxOutputTokens: 16 });
      assert.equal(response.content, 'OK');
      assert.equal(calls, 1);
      assert.equal(harness.reservations.length, 1);
    }
  } finally { axios.defaults.adapter = original; }
});

test('DeepSeek bounded mode covers fast and slow text and JSON entry points', async () => {
  const original = axios.defaults.adapter;
  try {
    for (const method of ['chatFast', 'chatSlow', 'chatFastJSON', 'chatSlowJSON'] as const) {
      const harness = budgetHarness();
      let calls = 0;
      axios.defaults.adapter = async config => {
        calls++;
        const body = JSON.parse(String(config.data));
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.max_tokens, 16);
        return { status: 200, statusText: '', headers: {}, config,
          data: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } };
      };
      const llm = new LlmService(settings('deepseek-flash', 'https://api.deepseek.com'), harness.service);
      const result = await llm[method]([{ role: 'user', content: 'Reply with JSON {"ok":true}' }], 'alice', { maxOutputTokens: 16 });
      if ('data' in result) assert.deepEqual(result.data, { ok: true });
      else assert.equal(result.content, '{"ok":true}');
      assert.equal(calls, 1);
      assert.equal(harness.reservations.length, 1);
    }
  } finally { axios.defaults.adapter = original; }
});

test('truncated, empty and malformed responses remain charged and fail distinctly without a paid fallback', async () => {
  const original = axios.defaults.adapter;
  const cases = [
    { content: '{"decision":"approve"}', finish_reason: 'length', code: 'LLM_OUTPUT_LIMIT' },
    { content: '', finish_reason: 'stop', code: 'LLM_EMPTY_RESPONSE' },
    { content: 'private reply and credential secret', finish_reason: 'stop', code: 'LLM_INVALID_JSON' },
  ];
  try {
    for (const item of cases) {
      const harness = budgetHarness();
      let calls = 0;
      axios.defaults.adapter = async config => {
        calls++;
        return { status: 200, statusText: '', headers: {}, config,
          data: { choices: [{ message: { content: item.content, reasoning_content: 'private hidden trace' }, finish_reason: item.finish_reason }],
            usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 } } };
      };
      await assert.rejects(new LlmService(settings(), harness.service).chatFastJSON(
        [{ role: 'user', content: 'Return JSON' }], 'alice', { maxOutputTokens: 900 }), error => {
        assert.equal((error as { code?: string }).code, item.code);
        assert.doesNotMatch(String(error), /private|credential|secret|trace/);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(harness.reservations.length, 1);
      assert.equal(harness.settlements[0].charged, 910);
    }
  } finally { axios.defaults.adapter = original; }
});

function budgetHarness() {
  const reservations: Array<BudgetReservation & { owner: string; request: ReserveBudgetRequest }> = [];
  const settlements: Array<{ owner: string; id: string; failed: boolean; charged: number }> = [];
  return { reservations, settlements, service: {
    async reserve(owner: string, request: ReserveBudgetRequest) {
      const inputTokens = estimateInputTokens(request.messages);
      if (inputTokens > 6000) throw new BudgetExceededException('input_tokens', request.taskId);
      const maxOutputTokens = Math.min(request.maxOutputTokens ?? 1000, 1000);
      const reservation = { id: String(reservations.length), taskId: request.taskId!, inputTokens,
        maxOutputTokens, reservedTokens: inputTokens + maxOutputTokens, owner, request };
      reservations.push(reservation);
      return reservation;
    },
    async settle(owner: string, id: string, usage?: unknown, failed = false) {
      const settled = settleTokenUsage(reservations[Number(id)], failed ? undefined : usage);
      settlements.push({ owner, id, failed, charged: settled.chargedTokens });
      return settled;
    },
  } as unknown as LlmBudgetService };
}

test('LLM retries each reserve and settle separately with one stable task and bounded output', async () => {
  const harness = budgetHarness();
  const service = new LlmService(settings(), harness.service);
  const original = axios.defaults.adapter;
  const bodies: Record<string, unknown>[] = [];
  axios.defaults.adapter = async config => {
    bodies.push(JSON.parse(String(config.data)));
    return { status: bodies.length === 1 ? 503 : 200, statusText: '', headers: {}, config,
      data: { choices: [{ message: { content: 'OK' } }] } };
  };
  try {
    const result = await service.chatFast([{ role: 'user', content: 'fact' }], 'alice', {
      taskId: 'run-1', purpose: 'council', maxOutputTokens: 5000,
    });
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every(body => body.max_tokens === 1000));
    assert.equal(harness.reservations.length, 2);
    assert.ok(harness.reservations.every(row => row.owner === 'alice' && row.taskId === 'run-1'));
    assert.deepEqual(harness.settlements.map(row => row.failed), [true, false]);
    assert.equal(result.totalTokens, harness.reservations[1].reservedTokens);
  } finally { axios.defaults.adapter = original; }
});

test('budget denial, oversized input, and unavailable accounting never send HTTP', async () => {
  const original = axios.defaults.adapter;
  let httpCalls = 0;
  axios.defaults.adapter = async () => { httpCalls += 1; throw new Error('must not send'); };
  try {
    const harness = budgetHarness();
    await assert.rejects(() => new LlmService(settings(), harness.service).chatFast(
      [{ role: 'user', content: 'x'.repeat(7000) }], 'alice'), BudgetExceededException);
    const denied = { reserve: async () => { throw new BudgetExceededException('daily_calls', 't'); } };
    await assert.rejects(() => new LlmService(settings(), denied as unknown as LlmBudgetService)
      .chatFast([{ role: 'user', content: 'fact' }], 'alice'), BudgetExceededException);
    const offline = { reserve: async () => { throw new Error('database offline'); } };
    await assert.rejects(() => new LlmService(settings(), offline as unknown as LlmBudgetService)
      .chatFast([{ role: 'user', content: 'fact' }], 'alice'), /database offline/);
    assert.equal(httpCalls, 0);
  } finally { axios.defaults.adapter = original; }
});

test('JSON calls budget injected instructions and use compatible reasoning-model output bounds', async () => {
  const harness = budgetHarness();
  const service = new LlmService(settings('gpt-5.1'), harness.service);
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async config => {
    const body = JSON.parse(String(config.data));
    assert.equal(body.max_completion_tokens, 200);
    assert.equal(body.max_tokens, undefined);
    return { status: 200, statusText: '', headers: {}, config, data: {
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    } };
  };
  try {
    assert.deepEqual(await service.chatSlowJSON([{ role: 'user', content: 'fact' }], 'alice', {
      taskId: 'json-task', maxOutputTokens: 200,
    }), { data: { ok: true }, tokens: 30 });
    assert.equal(harness.reservations[0].request.messages.length, 2);
    assert.equal(harness.reservations[0].taskId, 'json-task');
  } finally { axios.defaults.adapter = original; }
});
