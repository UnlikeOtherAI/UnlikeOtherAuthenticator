import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTeamByIdMock = vi.fn();

vi.mock('../../src/services/team-hostname.service.js', () => ({
  resolveTeamById: (...args: unknown[]) => resolveTeamByIdMock(...args),
}));

const redirectUrl = 'https://product.example/login?arrive=team';
const config = {
  domain: 'api.product.example',
  login_flow: {
    team_redirect: {
      redirect_url: redirectUrl,
      template: 'https://{org}.product.example/{team}/login',
    },
  },
};
const team = { teamId: 'team-1', teamSlug: 'design', orgId: 'org-1', orgSlug: 'acme' };
const scope = { orgId: 'org-1', teamId: 'team-1' };

describe('resolveTeamRedirectUrl', () => {
  beforeEach(() => {
    resolveTeamByIdMock.mockReset().mockResolvedValue(team);
  });

  it('delivers a team sign-in to the team address', async () => {
    const { resolveTeamRedirectUrl } = await import('../../src/services/team-redirect.service.js');
    const deps = { prisma: {} as never };

    await expect(resolveTeamRedirectUrl({ config, redirectUrl, ...scope }, deps)).resolves.toBe(
      'https://acme.product.example/design/login',
    );
    expect(resolveTeamByIdMock).toHaveBeenCalledWith(
      { domain: 'api.product.example', teamId: 'team-1' },
      deps,
    );
  });

  it('keeps the requested URL without reading anything when the template does not apply', async () => {
    const { resolveTeamRedirectUrl } = await import('../../src/services/team-redirect.service.js');

    // No template declared.
    await expect(
      resolveTeamRedirectUrl({ config: { domain: config.domain }, redirectUrl, ...scope }),
    ).resolves.toBe(redirectUrl);
    // Another registered redirect URL: the shared page, or a native deep link.
    await expect(
      resolveTeamRedirectUrl({ config, redirectUrl: 'https://product.example/login', ...scope }),
    ).resolves.toBe('https://product.example/login');
    await expect(
      resolveTeamRedirectUrl({ config, redirectUrl: 'product://auth/callback', ...scope }),
    ).resolves.toBe('product://auth/callback');
    // A sign-in that resolved no team.
    await expect(resolveTeamRedirectUrl({ config, redirectUrl })).resolves.toBe(redirectUrl);
    expect(resolveTeamByIdMock).not.toHaveBeenCalled();
  });

  it('keeps the requested URL when the team has no address of its own', async () => {
    const { resolveTeamRedirectUrl } = await import('../../src/services/team-redirect.service.js');

    resolveTeamByIdMock.mockResolvedValueOnce(null);
    await expect(resolveTeamRedirectUrl({ config, redirectUrl, ...scope })).resolves.toBe(redirectUrl);
    // The team is addressable, but not inside the organisation this sign-in resolved.
    resolveTeamByIdMock.mockResolvedValueOnce({ ...team, orgId: 'org-2' });
    await expect(resolveTeamRedirectUrl({ config, redirectUrl, ...scope })).resolves.toBe(redirectUrl);
    // A stored label that is not a valid slug never reaches a hostname.
    resolveTeamByIdMock.mockResolvedValueOnce({ ...team, orgSlug: 'acme.evil.example' });
    await expect(resolveTeamRedirectUrl({ config, redirectUrl, ...scope })).resolves.toBe(redirectUrl);
  });
});
