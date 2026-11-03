import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastCompletedTradingDate, tradingMarketSchedule } from './trading-market.calendar';

test('US official holidays and early closes override weekday hours', () => {
  const holiday = tradingMarketSchedule('US', new Date('2026-11-26T15:00:00Z'));
  assert.equal(holiday.calendarVerified, true);
  assert.equal(holiday.isTradingDay, false);
  assert.equal(holiday.nextOpenAt, '2026-11-27T14:30:00.000Z');
  const early = tradingMarketSchedule('US', new Date('2026-11-27T17:59:00Z'));
  assert.equal(early.isOpen, true);
  assert.equal(early.earlyClose, true);
  assert.equal(early.closesAt, '2026-11-27T18:00:00.000Z');
  assert.equal(tradingMarketSchedule('US', new Date('2026-11-27T18:00:00Z')).isOpen, false);
  assert.equal(tradingMarketSchedule('US', new Date('2026-07-02T18:00:00Z')).isOpen, true);
  assert.equal(tradingMarketSchedule('US', new Date('2026-07-03T15:00:00Z')).isOpen, false);
});

test('IANA timezone handles US DST and local dates independently of host timezone', () => {
  assert.equal(tradingMarketSchedule('US', new Date('2026-03-06T15:00:00Z')).opensAt, '2026-03-06T14:30:00.000Z');
  assert.equal(tradingMarketSchedule('US', new Date('2026-03-09T14:00:00Z')).opensAt, '2026-03-09T13:30:00.000Z');
  assert.equal(tradingMarketSchedule('US', new Date('2026-11-03T01:00:00Z')).tradingDate, '2026-11-02');
  assert.equal(tradingMarketSchedule('HK', new Date('2026-11-03T01:00:00Z')).tradingDate, '2026-11-03');
});

test('HK calendar observes lunar new year, half days and lunch', () => {
  assert.equal(tradingMarketSchedule('HK', new Date('2026-02-17T02:00:00Z')).isTradingDay, false);
  const half = tradingMarketSchedule('HK', new Date('2026-02-16T03:00:00Z'));
  assert.equal(half.earlyClose, true);
  assert.equal(half.closesAt, '2026-02-16T04:00:00.000Z');
  assert.equal(tradingMarketSchedule('HK', new Date('2026-12-24T05:30:00Z')).isOpen, false);
  const lunch = tradingMarketSchedule('HK', new Date('2026-11-03T04:30:00Z'));
  assert.equal(lunch.isTradingDay, true);
  assert.equal(lunch.isOpen, false);
  assert.equal(lunch.nextOpenAt, '2026-11-03T05:00:00.000Z');
});

test('CN holidays include full festival closures and weekend makeup workdays stay closed', () => {
  const closed = tradingMarketSchedule('CN', new Date('2026-02-20T02:00:00Z'));
  assert.equal(closed.isTradingDay, false);
  assert.equal(closed.nextOpenAt, '2026-02-24T01:30:00.000Z');
  assert.equal(tradingMarketSchedule('CN', new Date('2026-02-28T02:00:00Z')).isTradingDay, false);
  assert.equal(tradingMarketSchedule('CN', new Date('2026-10-06T02:00:00Z')).isOpen, false);
  assert.equal(tradingMarketSchedule('CN', new Date('2026-11-03T04:00:00Z')).nextOpenAt, '2026-11-03T05:00:00.000Z');
});

test('unknown calendar years fail closed and never invent next opening dates', () => {
  const unknown = tradingMarketSchedule('US', new Date('2029-11-02T15:00:00Z'));
  assert.equal(unknown.calendarVerified, false);
  assert.equal(unknown.isOpen, false);
  assert.equal(unknown.nextOpenAt, null);
  assert.equal(unknown.reason, 'calendar_unavailable');
  assert.equal(tradingMarketSchedule('HK', new Date('2026-12-31T08:00:00Z')).nextOpenAt, null);
});

test('CN closing auction is excluded from continuous fills while official close remains 15:00', () => {
  assert.equal(tradingMarketSchedule('CN', new Date('2026-11-03T06:56:59Z')).isOpen, true);
  for (const time of ['06:57:00', '06:58:00', '07:00:00']) {
    const schedule = tradingMarketSchedule('CN', new Date(`2026-11-03T${time}Z`));
    assert.equal(schedule.isOpen, false, time);
    assert.equal(schedule.sessions.at(-1)?.closesAt, '2026-11-03T06:57:00.000Z');
    assert.equal(schedule.closesAt, '2026-11-03T07:00:00.000Z');
  }
  assert.equal(lastCompletedTradingDate('CN', new Date('2026-11-03T07:29:59Z')), '2026-11-02');
  assert.equal(lastCompletedTradingDate('CN', new Date('2026-11-03T07:30:00Z')), '2026-11-03');
});
