import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CodeEntryPage } from './CodeEntryPage.js';
import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

const TEST_CONFIG = {
  ui_theme: {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: { card: '16px', button: '12px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
  language_config: 'en',
};

function renderCodeEntry(pendingEmail: string | null): string {
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <PopupProvider
          configUrl=""
          config={TEST_CONFIG}
          initialSearch="?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config"
          initialView="code-entry"
          initialPendingEmail={pendingEmail}
        >
          <CodeEntryPage />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('CodeEntryPage SSR rendering', () => {
  it('renders the instructions with the pending email interpolated', () => {
    const html = renderCodeEntry('jo@example.com');
    expect(html).toContain('We sent a code to jo@example.com');
  });

  it('renders a resend link and the 6-digit code input', () => {
    const html = renderCodeEntry('jo@example.com');
    expect(html).toContain('Resend code');
    expect(html).toContain('maxLength="6"');
    expect(html).toContain('autoComplete="one-time-code"');
  });

  it('renders nothing (bounces to login) when there is no pending email', () => {
    const html = renderCodeEntry(null);
    expect(html).not.toContain('We sent a code to');
    expect(html).not.toContain('Resend code');
  });
});
