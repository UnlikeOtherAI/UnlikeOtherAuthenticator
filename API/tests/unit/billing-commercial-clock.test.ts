import { describe, expect, it } from 'vitest';
import { defaultTrialEnd, weekdayGraceDeadline } from '../../src/services/billing-commercial-clock.service.js';

describe('weekday commercial grace', () => {
  it('pauses Friday evening through Monday evening in the company timezone', () => {
    expect(weekdayGraceDeadline(new Date('2026-10-16T18:00:00Z'), 'Europe/London').toISOString())
      .toBe('2026-10-19T18:00:00.000Z');
  });
  it('skips the spring and autumn DST weekends using local boundaries', () => {
    expect(weekdayGraceDeadline(new Date('2026-03-27T18:00:00Z'), 'Europe/London').toISOString())
      .toBe('2026-03-30T17:00:00.000Z');
    expect(weekdayGraceDeadline(new Date('2026-10-23T17:00:00Z'), 'Europe/London').toISOString())
      .toBe('2026-10-26T18:00:00.000Z');
  });
  it('starts counting a Saturday failure from Monday midnight', () => {
    expect(weekdayGraceDeadline(new Date('2026-10-17T12:00:00Z'), 'UTC').toISOString())
      .toBe('2026-10-20T00:00:00.000Z');
  });
  it('counts ordinary weekday time and refuses invented zones', () => {
    expect(weekdayGraceDeadline(new Date('2026-10-13T12:00:00Z'), 'UTC').toISOString())
      .toBe('2026-10-14T12:00:00.000Z');
    expect(() => weekdayGraceDeadline(new Date(), 'Not/AZone')).toThrow();
  });
  it('clamps default calendar-month trials without converting to30 days', () => {
    expect(defaultTrialEnd(new Date('2027-01-31T14:00:00Z')).toISOString())
      .toBe('2027-02-28T14:00:00.000Z');
  });
});
