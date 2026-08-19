import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env.js';
import { safeEmailLog, type EmailMessage } from '../email.providers.js';

const RECIPIENT = 'person@example.com';

const TEST_SECRET = 'test-shared-secret-with-enough-length';

function testEnv(nodeEnv: string, sharedSecret: string = TEST_SECRET): Env {
  return { NODE_ENV: nodeEnv, SHARED_SECRET: sharedSecret } as Env;
}

function testMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: RECIPIENT,
    subject: 'Your sign-in link',
    text: 'https://auth.example.com/auth/verify?token=secret',
    html: '<a href="https://auth.example.com/auth/verify?token=secret">Sign in</a>',
    ...overrides,
  };
}

describe('safeEmailLog production masking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function productionToHint(env: Env, message: EmailMessage): string {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    safeEmailLog(env, message);
    const calls = info.mock.calls;
    info.mockRestore();
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(payload)).not.toContain(message.to);
    expect(payload).toEqual({ to: expect.stringMatching(/^hmac-sha256:[0-9a-f]{12}\.\.\.$/), subject: message.subject });
    return (payload as { to: string }).to;
  }

  it('withholds the recipient address in production, logging a secret-keyed hint', () => {
    const hint = productionToHint(testEnv('production'), testMessage());
    const expected = createHmac('sha256', TEST_SECRET)
      .update(RECIPIENT, 'utf8')
      .digest('hex')
      .slice(0, 12);
    expect(hint).toBe(`hmac-sha256:${expected}...`);
  });

  it('is stable for the same recipient but differs for different recipients', () => {
    const env = testEnv('production');
    const first = productionToHint(env, testMessage());
    const second = productionToHint(env, testMessage());
    const other = productionToHint(env, testMessage({ to: 'other@example.com' }));
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it('produces a different hint under a different SHARED_SECRET', () => {
    const first = productionToHint(testEnv('production'), testMessage());
    const other = productionToHint(
      testEnv('production', 'a-different-shared-secret-with-enough-length'),
      testMessage(),
    );
    expect(other).not.toBe(first);
  });

  it('still logs the full message outside production (and nothing under test)', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    safeEmailLog(testEnv('development'), testMessage());
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls[0])).toContain(RECIPIENT);

    info.mockClear();
    safeEmailLog(testEnv('test'), testMessage());
    expect(info).not.toHaveBeenCalled();
  });
});
