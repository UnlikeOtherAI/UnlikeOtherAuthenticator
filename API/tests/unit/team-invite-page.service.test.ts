import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInviteUnavailableHtml } from '../../src/services/team-invite-page.service.js';
import { AppError } from '../../src/utils/errors.js';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  renderInviteHtml,
  resolveInviteContinueUrl,
  resolveInviteProductName,
} from '../../src/services/team-invite-page.service.js';

/**
 * `resolveInviteContinueUrl` must distinguish "this redirect URL is not allowed" (an answer)
 * from "the selector blew up" (a fault). The real selector is used everywhere below; this
 * switch lets one case make it throw something that is not an `AppError`.
 */
const selector = vi.hoisted(() => ({ fail: null as null | (() => never) }));

vi.mock('../../src/services/authorization-code.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/authorization-code.service.js')>();
  return {
    ...actual,
    selectRedirectUrl: (params: Parameters<typeof actual.selectRedirectUrl>[0]) =>
      selector.fail ? selector.fail() : actual.selectRedirectUrl(params),
  };
});

afterEach(() => {
  selector.fail = null;
});

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


describe('renderInviteUnavailableHtml', () => {
  it('names a genuine invitation expiry', () => {
    const html = renderInviteUnavailableHtml(new AppError('BAD_REQUEST', 400, 'INVITE_EXPIRED'));

    expect(html).toContain('Invitation expired');
    expect(html).not.toContain('Invitation invalid');
  });

  it.each([
    new AppError('BAD_REQUEST', 400, 'INVITE_INVALID'),
    new AppError('BAD_REQUEST', 400, 'INVITE_REVOKED'),
    new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED'),
    new Error('unexpected'),
  ])('uses one invalid result for every non-expiry failure', (error) => {
    const html = renderInviteUnavailableHtml(error);

    expect(html).toContain('Invitation invalid');
    expect(html).not.toContain('Invitation expired');
    expect(html).not.toContain('Invitation revoked');
  });
});

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

  // The SPA's `selectAllowedContinueUrl` mirrors this policy; these two cases are asserted on
  // both sides so the server page and the hosted page can never disagree about a product.
  it('accepts an allow-listed native deep link', () => {
    const native = 'nessie://auth/callback';
    expect(
      resolveInviteContinueUrl(config({ redirect_urls: [native] } as Partial<ClientConfig>), native),
    ).toBe(native);
  });

  it('refuses plain http on a real host even when the config lists it', () => {
    const insecure = 'http://evil.example/callback';
    expect(
      resolveInviteContinueUrl(
        config({ redirect_urls: [insecure] } as Partial<ClientConfig>),
        insecure,
      ),
    ).toBeUndefined();
  });

  it('propagates a fault from the selector instead of silently dropping the button', () => {
    selector.fail = () => {
      throw new TypeError('allow-list entry is not a string');
    };

    expect(() => resolveInviteContinueUrl(config(), ALLOWED)).toThrow(TypeError);
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
