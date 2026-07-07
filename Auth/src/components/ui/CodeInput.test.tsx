import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CodeInput } from './CodeInput.js';

describe('CodeInput SSR rendering', () => {
  it('renders a numeric, length-capped, one-time-code input', () => {
    const html = renderToString(<CodeInput value="123" onChange={() => {}} length={6} />);

    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="6"');
    expect(html).toContain('value="123"');
  });

  it('respects a custom length (8-digit placeholder)', () => {
    const html = renderToString(<CodeInput value="" onChange={() => {}} length={8} />);
    expect(html).toContain('maxLength="8"');
    expect(html).toContain('placeholder="12345678"');
  });

  it('renders disabled when asked', () => {
    const html = renderToString(<CodeInput value="" onChange={() => {}} disabled />);
    expect(html).toMatch(/<input[^>]*\bdisabled\b/);
  });

  it('renders the label when provided', () => {
    const html = renderToString(<CodeInput value="" onChange={() => {}} label="Verification code" />);
    expect(html).toContain('Verification code');
  });
});
