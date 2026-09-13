import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InviteAcceptedPage } from './InviteAcceptedPage.js';
import { AuthLayout } from '../components/layout/AuthLayout.js';
import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

const ALLOWED = 'https://app.nessie.works/login';

const TEST_CONFIG = {
  domain: 'api.nessie.works',
  redirect_urls: [ALLOWED],
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
    logo: { url: '', alt: 'Nessie' },
  },
  language_config: 'en',
};

function render(redirectUrl?: string, config: unknown = TEST_CONFIG): string {
  const search = new URLSearchParams({ config_url: 'https://api.nessie.works/auth-config' });
  search.set('flow', 'invite_accepted');
  if (redirectUrl) search.set('redirect_url', redirectUrl);
  return renderToString(
    <ThemeProvider config={config} configUrl="">
      <I18nProvider config={config} configUrl="">
        <PopupProvider configUrl="" config={config} initialSearch={`?${search.toString()}`}>
          <AuthLayout>
            <InviteAcceptedPage />
          </AuthLayout>
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('InviteAcceptedPage', () => {
  it('is a close-the-window confirmation when no redirect URL was carried', () => {
    const html = render();
    expect(html).toContain('Invitation accepted');
    expect(html).toContain('You can close this window.');
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('<a href');
  });

  it('offers a named way into the product for an allow-listed redirect URL', () => {
    const html = render(ALLOWED);
    expect(html).toContain('Continue to Nessie');
    expect(html).toContain(`href="${ALLOWED}"`);
    // The dead-end sentence is replaced, not kept alongside a working link.
    expect(html).not.toContain('You can close this window.');
  });

  it('drops a redirect URL the config does not list', () => {
    const html = render('https://evil.example.com/phish');
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('evil.example.com');
    expect(html).toContain('You can close this window.');
  });

  it('drops a non-http scheme even if it were somehow listed', () => {
    const html = render('javascript:alert(1)', {
      ...TEST_CONFIG,
      redirect_urls: ['javascript:alert(1)'],
    });
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('javascript:alert(1)');
  });

});
