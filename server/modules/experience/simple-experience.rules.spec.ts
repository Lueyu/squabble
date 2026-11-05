import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, generationIdentity, parseRefresh, preferencesSchema, shouldPublish } from './simple-experience.rules';

test('refresh rejects unknown fields, ambiguous topics and invalid dates', () => {
  for (const value of [{topicKey:'portfolio',requestKey:'a',owner:'other'}, {topicKey:'Apple',requestKey:'a'},
    {topicKey:'portfolio',date:'2026-02-30',requestKey:'a'}]) assert.throws(() => parseRefresh(value));
  assert.equal(parseRefresh({topicKey:'ticker:TSLA',requestKey:'a'}).topicKey,'ticker:TSLA');
});
test('generation identity ignores capture time but changes when facts change', () => {
  assert.equal(generationIdentity('portfolio','2026-11-06',{shares:2,capturedAt:'a'}),generationIdentity('portfolio','2026-11-06',{capturedAt:'b',shares:2}));
  assert.notEqual(generationIdentity('portfolio','2026-11-06',{shares:2}),generationIdentity('portfolio','2026-11-06',{shares:3}));
});
test('only latest complete generation replaces current material', () => {
  assert.equal(shouldPublish(3,2,'completed'),false);
  assert.equal(shouldPublish(3,3,'failed'),false);
  assert.equal(shouldPublish(3,3,'completed'),true);
});
test('business dates use chosen valid timezone and settings reject invalid choices', () => {
  assert.equal(businessDate(new Date('2026-11-05T20:00:00Z'),'Asia/Shanghai'),'2026-11-06');
  assert.equal(businessDate(new Date('2026-11-05T20:00:00Z'),'America/New_York'),'2026-11-05');
  assert.equal(preferencesSchema.safeParse({timezone:'made/up',requestKey:'a'}).success,false);
});
