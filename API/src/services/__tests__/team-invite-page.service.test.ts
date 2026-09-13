import { describe, expect, it } from 'vitest';

import type { ClientConfig } from '../config.service.js';
import {
  renderInviteHtml,
  resolveInviteContinueUrl,
  resolveInviteProductName,
} from '../team-invite-page.service.js';

const ALLOWED = 'https://app.nessie.works/login';

function config(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'api.nessie.works',
    redirect_urls: [ALLOWED, 'https://app.nessie.works/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: { logo: { url: '', alt: 'Nessie' } },
    language_config: 'en',
    ...overrides,
  } as unknown as ClientConfig;
}

describe('resolveInviteContinueUrl', () => {
  it('returns an allow-listed redirect URL unchanged', () => {
    expect(resolveInviteContinueUrl(config(), ALLOWED)).toBe(ALLOWED);
  });

  it('drops a redirect URL that is not in config.redirect_urls', () => {
    expect(resolveInviteContinueUrl(config(), 'https://evil.example.com/steal')).toBeUndefined();
  });

  it('drops a path-suffixed near miss on an allowed URL', () => {
    expect(resolveInviteContinueUrl(config(), `${ALLOWED}/../../evil`)).toBeUndefined();
  });

  it('never falls back to the first configured redirect URL when none was requested', () => {
    expect(resolveInviteContinueUrl(config(), undefined)).toBeUndefined();
    expect(resolveInviteContinueUrl(config(), '   ')).toBeUndefined();
  });
});

describe('resolveInviteProductName', () => {
  it('prefers the config logo alt text', () => {
    expect(resolveInviteProductName(config())).toBe('Nessie');
  });

  it('falls back to the config domain when the logo has no usable alt text', () => {
    const withoutAlt = config({
      ui_theme: { logo: { url: '', alt: '   ' } },
    } as unknown as Partial<ClientConfig>);
    expect(resolveInviteProductName(withoutAlt)).toBe('api.nessie.works');
  });
});

describe('renderInviteHtml continue control', () => {
  it('renders a named continue link when a continue URL is known', () => {
    const html = renderInviteHtml({
      title: 'Invitation accepted',
      body: 'You have joined General on Alpha Team.',
      continueUrl: ALLOWED,
      productName: 'Nessie',
    });

    expect(html).toContain('Continue to Nessie');
    expect(html).toContain(`href="${ALLOWED}"`);
  });

  it('renders exactly as before when no continue URL is known', () => {
    const html = renderInviteHtml({
      title: 'Invitation accepted',
      body: 'You have joined General on Alpha Team. You can close this window and sign in.',
      productName: 'Nessie',
    });

    expect(html).not.toContain('Continue to');
    expect(html).toContain('You can close this window and sign in.');
  });

  it('escapes a product name so it cannot break out of the anchor', () => {
    const html = renderInviteHtml({
      title: 'Invitation accepted',
      body: 'joined',
      continueUrl: ALLOWED,
      productName: '</a><script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/a&gt;&lt;script&gt;');
  });
});
