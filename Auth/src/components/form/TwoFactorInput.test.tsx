import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TwoFactorInput } from './TwoFactorInput.js';

// Regression guard for the Phase 3c refactor: TwoFactorInput now wraps the extracted
// `ui/CodeInput`, but 2FA verify/setup must render exactly as before.
describe('TwoFactorInput (wraps CodeInput)', () => {
  it('renders a 6-digit numeric one-time-code input by default', () => {
    const html = renderToString(<TwoFactorInput value="12" onChange={() => {}} />);
    expect(html).toContain('maxLength="6"');
    expect(html).toContain('placeholder="123456"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('value="12"');
  });

  it('supports the 8-digit variant used for backup-style codes', () => {
    const html = renderToString(<TwoFactorInput value="" onChange={() => {}} digits={8} />);
    expect(html).toContain('maxLength="8"');
    expect(html).toContain('placeholder="12345678"');
  });

  it('renders disabled when asked', () => {
    const html = renderToString(<TwoFactorInput value="" onChange={() => {}} disabled />);
    expect(html).toMatch(/<input[^>]*\bdisabled\b/);
  });
});
