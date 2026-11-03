import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CouncilService } from './council.service';
import type { CouncilMember } from '../../../shared/council.interface';
import type { ResearchEvent } from '../../../shared/research-events.interface';

test('model-backed members publish lifecycle activity and correlate their final reply without private reasoning', async () => {
  const events: ResearchEvent[] = [];
  const member: CouncilMember = { id: 'analyst', name: 'Analyst', role: 'researcher', instructions: '', model: 'fast' };
  const service = new CouncilService({ select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }) } as never,
    { chatFastJSON: async () => {
      assert.ok(events.some(e => e.kind === 'task' && e.status === 'running'), 'activity must be visible while waiting for a model');
      return { data: { content: 'Public answer', reasoningSummary: ['Public rationale'], questions: [], evidenceIds: [] }, tokens: 3 };
    } } as never, {} as never, {} as never, {} as never);
  Reflect.set(service, 'recordActivity', async (_owner: string, _row: unknown, event: ResearchEvent) => { events.push(event); });
  const row = { id: 'session', ticker: 'AAPL', revision: 1, language: 'en', taskId: 'budget', candidate: null,
    profileSnapshot: { name: 'Fixture', customPrompt: '', council: { enabled: true, members: [member] } }, evidenceSnapshot: [],
    checkpoint: { cycleId: 'cycle', nextTurn: 0, turns: [{ memberId: member.id, phase: 'opening' }] } };
  const output = await Reflect.get(service, 'runMember').call(service, 'owner', row, member, { memberId: member.id, phase: 'opening' });
  assert.deepEqual(events.map(e => e.status), ['queued', 'running', 'succeeded']);
  assert.equal(output.taskId, events[0].taskId);
  assert.equal(new Set(events.map(e => e.id)).size, 3);
});
