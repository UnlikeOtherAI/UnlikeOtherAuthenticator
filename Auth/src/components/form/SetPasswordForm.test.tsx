import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SetPasswordForm } from './SetPasswordForm.js';
import { PopupProvider } from '../../hooks/use-popup.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';

// Regression guard for the iOS keyboard-dismiss bug: the set-password view is
// server-rendered, so before hydration the password controls must NOT be focusable.
// Otherwise a user can type the first character into a pre-hydration input, which
// React then wipes on hydrate while dropping focus (dismissing the soft keyboard).
// We gate the controls behind a disabled <fieldset> until hydration; the server
// render must therefore emit a disabled fieldset.
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

function renderForm(tokenType: 'PASSWORD_RESET' | 'VERIFY_EMAIL_SET_PASSWORD'): string {
  const search =
    '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
    `&email_token=some-token&email_token_type=${tokenType}`;
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <PopupProvider configUrl="" config={TEST_CONFIG} initialSearch={search}>
          <SetPasswordForm />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

function renderResetForm(): string {
  return renderForm('PASSWORD_RESET');
}

describe('SetPasswordForm SSR (pre-hydration gating)', () => {
  it('server-renders the password controls inside a disabled fieldset', () => {
    const html = renderResetForm();

    // The form is rendered (password inputs exist)...
    expect(html).toContain('type="password"');
    // ...but wrapped in a disabled fieldset so it cannot be focused pre-hydration.
    expect(html).toMatch(/<fieldset[^>]*\bdisabled\b/);
  });

  it('marks the pre-hydration fieldset as busy for assistive tech', () => {
    const html = renderResetForm();

    expect(html).toMatch(/<fieldset[^>]*aria-busy="true"/);
  });
});

describe('SetPasswordForm optional name field', () => {
  it('offers an optional name on the registration branch', () => {
    // F6: without this field a person who signs up by e-mail has no name at all, and every
    // product roster falls back to "Unnamed member".
    const html = renderForm('VERIFY_EMAIL_SET_PASSWORD');

    expect(html).toContain('Your name');
    expect(html).toContain('name="name"');
    expect(html).toContain('maxLength="120"');
    // Optional: nothing on this field may block the submit.
    expect(html).not.toMatch(/name="name"[^>]*required/);
  });

  it('does not ask for a name on a password reset', () => {
    // A reset is an existing account; its profile name is not this form's business.
    const html = renderResetForm();

    expect(html).not.toContain('Your name');
    expect(html).not.toContain('name="name"');
  });
});
