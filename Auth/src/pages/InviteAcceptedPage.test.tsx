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

function render(redirectUrl?: string, config: unknown = TEST_CONFIG, target?: { orgId: string; teamId: string }): string {
  const search = new URLSearchParams({ config_url: 'https://api.nessie.works/auth-config' });
  search.set('flow', 'invite_accepted');
  if (target) {
    search.set('uoa_invite_org', target.orgId);
    search.set('uoa_invite_team', target.teamId);
  }
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
  it('offers the accepted team after a social invitation instead of a bare login link', () => {
    const html = render(ALLOWED, { ...TEST_CONFIG, login_flow: { invitation_return_target: true } },
      { orgId: 'new-org', teamId: 'invited-team' });
    expect(html).toContain(`href="${ALLOWED}?uoa_invite_org=new-org&amp;uoa_invite_team=invited-team"`);
    expect(html).toContain('Continue to Nessie');
  });

  it('is a close-the-window confirmation when no redirect URL was carried', () => {
    const html = render();
    expect(html).toContain('You’re in');
    expect(html).toContain('You can close this tab.');
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('<a href');
  });

  it('offers a named way into the product for an allow-listed redirect URL', () => {
    const html = render(ALLOWED);
    expect(html).toContain('Continue to Nessie');
    expect(html).toContain(`href="${ALLOWED}"`);
    // The dead-end sentence is replaced, not kept alongside a working link.
    expect(html).not.toContain('You can close this tab.');
  });

  it('drops a redirect URL the config does not list', () => {
    const html = render('https://evil.example.com/phish');
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('evil.example.com');
    expect(html).toContain('You can close this tab.');
  });

  it('drops a dangerous scheme even if it were somehow listed', () => {
    const html = render('javascript:alert(1)', {
      ...TEST_CONFIG,
      redirect_urls: ['javascript:alert(1)'],
    });
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('offers the link for an allow-listed native deep link, as the server page does', () => {
    const native = 'nessie://auth/callback';
    const html = render(native, { ...TEST_CONFIG, redirect_urls: [native] });
    expect(html).toContain('Continue to Nessie');
    expect(html).toContain(`href="${native}"`);
  });

  it('drops plain http on a real host even when the config lists it', () => {
    const insecure = 'http://evil.example/callback';
    const html = render(insecure, { ...TEST_CONFIG, redirect_urls: [insecure] });
    expect(html).not.toContain('Continue to');
    expect(html).not.toContain('evil.example');
  });

});
