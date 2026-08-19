import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env.js';
import { safeEmailLog, type EmailMessage } from '../email.providers.js';

const RECIPIENT = 'person@example.com';

function testEnv(nodeEnv: string): Env {
  return { NODE_ENV: nodeEnv } as Env;
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

  it('withholds the recipient address in production, logging a non-reversible hint', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    safeEmailLog(testEnv('production'), testMessage());

    expect(info).toHaveBeenCalledTimes(1);
    const [, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    const hint = createHash('sha256').update(RECIPIENT, 'utf8').digest('hex').slice(0, 12);
    expect(payload).toEqual({ to: `sha256:${hint}...`, subject: 'Your sign-in link' });
    expect(JSON.stringify(payload)).not.toContain(RECIPIENT);
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
