import { describe, expect, it, vi } from 'vitest';

import { isFlowStartQuery } from '../../src/routes/auth/entrypoint.js';
import {
  getAuthFunnelSummary,
  normalizeAuthFunnelOutcome,
  recordAuthFunnelStep,
  resolveAuthFunnelRange,
} from '../../src/services/auth-funnel.service.js';

const env = { DATABASE_URL: 'postgres://unused' } as never;
const now = () => new Date('2026-10-22T23:59:59.000Z');

describe('recordAuthFunnelStep', () => {
  it('increments the UTC-day counter for the client, step and outcome', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    await recordAuthFunnelStep(
      { domain: 'client.example.com', step: 'registration_email', outcome: 'verification_sent' },
      { env, now, prisma: { authFunnelDailyCount: { upsert } } },
    );

    const key = {
      day: new Date('2026-10-22T00:00:00.000Z'),
      domain: 'client.example.com',
      step: 'registration_email',
      outcome: 'verification_sent',
    };
    expect(upsert).toHaveBeenCalledWith({
      where: { day_domain_step_outcome: key },
      create: { ...key, count: 1 },
      update: { count: { increment: 1 } },
    });
  });

  it('never stores free text as an outcome', async () => {
    expect(normalizeAuthFunnelOutcome('google')).toBe('google');
    expect(normalizeAuthFunnelOutcome('person@example.com')).toBe('other');
    expect(normalizeAuthFunnelOutcome('Bearer abc')).toBe('other');
    expect(normalizeAuthFunnelOutcome('x'.repeat(65))).toBe('other');
  });

  it('retries once when two first events of the day race to create the row', async () => {
    const upsert = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({});
    await recordAuthFunnelStep(
      { domain: 'client.example.com', step: 'flow_started', outcome: 'shown' },
      { env, now, prisma: { authFunnelDailyCount: { upsert } } },
    );
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('swallows write failures so a metric can never change an auth outcome', async () => {
    const upsert = vi.fn().mockRejectedValue(new Error('database down'));
    await expect(
      recordAuthFunnelStep(
        { domain: 'client.example.com', step: 'login_submitted', outcome: 'failed' },
        { env, now, prisma: { authFunnelDailyCount: { upsert } } },
      ),
    ).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('never holds a sign-in step longer than its wait budget when the database stalls', async () => {
    const upsert = vi.fn(() => new Promise(() => undefined));
    const started = Date.now();
    await recordAuthFunnelStep(
      { domain: 'client.example.com', step: 'flow_started', outcome: 'shown' },
      { env, now, maxWaitMs: 20, prisma: { authFunnelDailyCount: { upsert } } },
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('records nothing without a database or with a client that lacks the model', async () => {
    const upsert = vi.fn();
    await recordAuthFunnelStep(
      { domain: 'client.example.com', step: 'flow_started', outcome: 'shown' },
      { env: {} as never, now, prisma: { authFunnelDailyCount: { upsert } } },
    );
    await recordAuthFunnelStep(
      { domain: 'client.example.com', step: 'flow_started', outcome: 'shown' },
      { env, now, prisma: {} },
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('resolveAuthFunnelRange', () => {
  it('defaults to the last 30 UTC days ending today', () => {
    const range = resolveAuthFunnelRange({}, { now });
    expect(range.from.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('rejects malformed, reversed and over-long ranges', () => {
    for (const params of [
      { from: '2026-13-01' },
      { from: '2026-02-30' },
      { from: '22.10.2026' },
      { from: '2026-10-22', to: '2026-10-21' },
      { from: '2025-01-01', to: '2026-10-22' },
    ]) {
      expect(() => resolveAuthFunnelRange(params, { now })).toThrow('INVALID_DATE_RANGE');
    }
  });
});

describe('getAuthFunnelSummary', () => {
  it('totals the range in funnel order and narrows to one client', async () => {
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
    const findMany = vi.fn().mockResolvedValue([
      { day: day('2026-10-21'), domain: 'hugo.example', step: 'code_exchange', outcome: 'succeeded', count: 2 },
      { day: day('2026-10-21'), domain: 'hugo.example', step: 'flow_started', outcome: 'shown', count: 4 },
      { day: day('2026-10-22'), domain: 'hugo.example', step: 'flow_started', outcome: 'shown', count: 6 },
      { day: day('2026-10-22'), domain: 'other.example', step: 'flow_started', outcome: 'shown', count: 50 },
    ]);

    const summary = await getAuthFunnelSummary(
      { from: '2026-10-21', to: '2026-10-22', domain: 'hugo.example' },
      { env, now, prisma: { authFunnelDailyCount: { findMany } } },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { day: { gte: day('2026-10-21'), lte: day('2026-10-22') } },
      select: { day: true, domain: true, step: true, outcome: true, count: true },
    });
    expect(summary).toEqual({
      from: '2026-10-21',
      to: '2026-10-22',
      domain: 'hugo.example',
      domains: ['hugo.example', 'other.example'],
      totals: [
        { step: 'flow_started', outcome: 'shown', count: 10 },
        { step: 'code_exchange', outcome: 'succeeded', count: 2 },
      ],
      days: [
        { day: '2026-10-21', step: 'flow_started', outcome: 'shown', count: 4 },
        { day: '2026-10-21', step: 'code_exchange', outcome: 'succeeded', count: 2 },
        { day: '2026-10-22', step: 'flow_started', outcome: 'shown', count: 6 },
      ],
    });
  });
});

describe('isFlowStartQuery', () => {
  it('counts a product opening the window but not UOA re-rendering it mid-flow', () => {
    expect(isFlowStartQuery({ config_url: 'https://client.example.com/c', redirect_url: 'x' })).toBe(true);
    for (const key of ['twofa_token', 'login_token', 'email_token', 'flow', 'invite_token']) {
      expect(isFlowStartQuery({ config_url: 'https://client.example.com/c', [key]: 'x' })).toBe(false);
    }
  });
});
