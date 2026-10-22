import { describe, expect, it, vi } from 'vitest';
import { buildRegistrationVerificationTemplate } from '../../src/services/email.templates.registration.js';
import { safeEmailLog } from '../../src/services/email.providers.js';
import { getEnv } from '../../src/config/env.js';

describe('registration verification email', () => {
  it('shows one neutral subject, a prominent link and the same spaced code in HTML and text', () => {
    const template = buildRegistrationVerificationTemplate({ code: 'AB3K7M', link: 'https://auth.example/registration#secret' });
    expect(template.subject).toBe('Verify your email address');
    expect(template.html).toContain('Confirm your email');
    expect(template.html).toContain('Verify email address</a>');
    expect(template.html).toContain('font-size:32px;font-weight:700;letter-spacing:8px');
    expect(template.text).toContain('AB3K7M'); expect(template.html).toContain('AB3K7M');
    expect(template.text).toContain('15 minutes'); expect(template.html).toContain('15 minutes');
    expect(template.text).toContain('another device does not sign');
  });
  it('never logs registration email content, including in development', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    safeEmailLog({ ...getEnv(), NODE_ENV: 'development' }, {
      to: 'person@example.com', subject: 'Verify your email address', text: 'SECRET-CODE', html: 'SECRET-TOKEN', suppressContentLog: true,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });
});
