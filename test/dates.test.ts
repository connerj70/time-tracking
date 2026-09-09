import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveRange, resolveTiming, todayIn, weekBounds } from '../src/lib/dates.js';

describe('dates', () => {
  it('workspace today differs across zones', () => {
    // At 2024-01-01T23:30Z, Sydney is already Jan 2 and LA is still Jan 1.
    const inst = DateTime.fromISO('2024-01-01T23:30:00Z');
    expect(inst.setZone('Australia/Sydney').toISODate()).toBe('2024-01-02');
    expect(inst.setZone('America/Los_Angeles').toISODate()).toBe('2024-01-01');
    expect(todayIn('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('weekBounds is Monday..Sunday', () => {
    expect(weekBounds('2024-01-03')).toEqual({ start: '2024-01-01', end: '2024-01-07' });
  });
  it('resolveTiming derives duration from start/end in workspace zone', () => {
    const r = resolveTiming({ tz: 'America/New_York', start: '2024-03-05T09:00', end: '2024-03-05T11:30' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.durationMin).toBe(150);
    expect(r.date).toBe('2024-03-05');
    expect(r.startedAt?.toISOString()).toBe('2024-03-05T14:00:00.000Z');
  });
  it('resolveTiming pins HH:MM times to the given date', () => {
    const r = resolveTiming({ tz: 'UTC', date: '2024-05-05', start: '13:00', end: '14:15' });
    if ('error' in r) throw new Error(r.error);
    expect(r.date).toBe('2024-05-05');
    expect(r.durationMin).toBe(75);
  });
  it('resolveTiming handles overnight', () => {
    const r = resolveTiming({ tz: 'UTC', date: '2024-05-05', start: '22:00', end: '01:00' });
    if ('error' in r) throw new Error(r.error);
    expect(r.durationMin).toBe(180);
  });
  it('resolveTiming: date only uses duration', () => {
    const r = resolveTiming({ tz: 'Asia/Tokyo', date: '2024-05-05', durationMin: 60 });
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ date: '2024-05-05', durationMin: 60, startedAt: null });
  });
  it('resolveTiming rejects conflicting duration', () => {
    const r = resolveTiming({ tz: 'UTC', start: '2024-05-05T09:00', end: '2024-05-05T10:00', durationMin: 90 });
    expect('error' in r).toBe(true);
  });
  it('resolveRange defaults and validates', () => {
    expect(resolveRange('UTC', '2024-01-01', '2024-01-31')).toEqual({ start: '2024-01-01', end: '2024-01-31' });
    expect('error' in resolveRange('UTC', '2024-02-01', '2024-01-01')).toBe(true);
    expect('error' in resolveRange('UTC', 'yesterday')).toBe(true);
    const def = resolveRange('UTC');
    expect('start' in def && def.start <= def.end).toBe(true);
  });
});
