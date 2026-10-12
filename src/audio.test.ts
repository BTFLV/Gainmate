import { describe, expect, it } from 'vitest';
import { db, distribution, duration, median, prediction } from './audio';
import { defaultSettings } from './types';
import type { Analysis } from './types';
const a = { integrated: -20, truePeak: -3 } as Analysis;
describe('review calculations', () => {
  it('explains peak constraints rather than claiming an unreachable target', () => {
    expect(prediction(a, { ...defaultSettings, mode: 'safe' })).toEqual({
      gain: 1.95,
      output: -18.05,
      limiting: 0,
      blocked: false,
    });
  });
  it('predicts limiting and blocks excessive peak reduction', () => {
    expect(prediction(a, defaultSettings)).toEqual({
      gain: 8,
      output: -12,
      limiting: 6,
      blocked: false,
    });
    expect(prediction(a, { ...defaultSettings, target: -10 })?.blocked).toBe(
      true,
    );
  });
  it('does not normalize silence', () => {
    expect(prediction({ ...a, integrated: null }, defaultSettings)).toBeNull();
  });
  it('keeps extreme values in distribution endpoints', () => {
    const b = distribution([-60, -36, -20, -5, 1]);
    expect(b.reduce((a, b) => a + b, 0)).toBe(5);
    expect(b[0]).toBe(2);
    expect(b[31]).toBe(2);
  });
  it('uses a true median and formats edge cases', () => {
    expect(median([])).toBeNull();
    expect(median([-10, -20, -30, -40])).toBe(-25);
    expect(median([-8, -23, -12])).toBe(-12);
    expect(duration(185)).toBe('3:05');
    expect(db(null)).toBe('−∞');
  });
});
