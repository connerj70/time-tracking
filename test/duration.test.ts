import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/lib/duration.js';

const cases: [string | number, number | null][] = [
  ['2h30m', 150],
  ['2h 30m', 150],
  ['2.5', 150],
  ['2,5', 150],
  ['150', 150],
  ['1:45', 105],
  ['0:30', 30],
  ['90 min', 90],
  ['90m', 90],
  ['1 hour 15 minutes', 75],
  ['45 minutes', 45],
  ['half an hour', 30],
  ['an hour', 60],
  ['1.5 hrs', 90],
  ['8', 480],
  ['12', 720],
  ['13', 13],
  ['30', 30],
  ['2 hours and 15 mins', 135],
  [2.5, 150],
  [90, 90],
  ['', null],
  ['soon', null],
  ['0', null],
  ['2h potatoes', null],
  ['25h', null],
];

describe('parseDuration', () => {
  for (const [input, minutes] of cases) {
    it(`${JSON.stringify(input)} → ${minutes}`, () => {
      const r = parseDuration(input);
      if (minutes === null) expect(r).toBeNull();
      else expect(r?.minutes).toBe(minutes);
    });
  }
  it('echoes a normalized value and interpretation', () => {
    const r = parseDuration('2h30m')!;
    expect(r.normalized).toBe('2h 30m');
    expect(r.interpretation).toContain('2h 30m');
  });
});
