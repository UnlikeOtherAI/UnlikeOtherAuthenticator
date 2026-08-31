import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { InviteRegistrationPage } from './InviteRegistrationPage.js';

const TEST_CONFIG = {
  enabled_auth_methods: ['email_password', 'google'],
  ui_theme: {
    colors: {
      bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb',
      primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff',
    },
    radii: { card: '16px', button: '12px', input: '12px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' }, button: { style: 'solid' },
    card: { style: 'bordered' }, logo: { url: '', alt: 'Logo' },
  },
  language_config: 'en',
};

describe('InviteRegistrationPage SSR', () => {
  it('renders the invited email as read-only and binds Google to the invite flow', () => {
    const html = renderToString(
      <ThemeProvider config={TEST_CONFIG} configUrl="">
        <I18nProvider config={TEST_CONFIG} configUrl="">
          <PopupProvider
            configUrl=""
            config={TEST_CONFIG}
            initialSearch="?invite_token=invite-capability&invite_email=invitee%40example.com"
            initialView="invite-registration"
          >
            <InviteRegistrationPage />
          </PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(html).toContain('value="invitee@example.com"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('/auth/social/google?config_url=&amp;invite_token=invite-capability');
  });
});
