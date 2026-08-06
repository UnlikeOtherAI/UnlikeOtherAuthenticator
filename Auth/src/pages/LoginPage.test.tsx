import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LoginPage } from './LoginPage.js';
import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

// Regression guard for the mobile keyboard bug: arriving at the login screen must not
// focus the email field. A focused field opens the soft keyboard immediately, which
// shrinks the visual viewport and hides the social sign-in buttons below it.
// `useNoUnrequestedFocus` drops focus the user did not ask for at runtime; this test
// covers the other half — no view in the login screen may ship an autofocus attribute.
const TEST_CONFIG = {
  enabled_auth_methods: ['email_password', 'google', 'apple'],
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

function renderLogin(): string {
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <PopupProvider
          configUrl=""
          config={TEST_CONFIG}
          initialSearch="?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config"
          initialView="login"
        >
          <LoginPage />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('LoginPage SSR', () => {
  it('renders the email/password form and the social buttons', () => {
    const html = renderLogin();

    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('/auth/social/google');
  });

  it('does not autofocus any field, so the soft keyboard stays closed on arrival', () => {
    expect(renderLogin()).not.toMatch(/autofocus/i);
  });
});
