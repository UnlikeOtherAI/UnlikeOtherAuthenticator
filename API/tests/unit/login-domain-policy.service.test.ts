import { describe, expect, it } from 'vitest';

import { assertEmailDomainAllowedForLogin } from '../../src/services/login-domain-policy.service.js';
import { isAppError } from '../../src/utils/errors.js';

type UserShape = {
  email: string;
  domainRoles: { role: string }[];
  orgMembers: { org: { allowedEmailDomains: string[] } }[];
  teamMembers: { team: { allowedEmailDomains: string[] } }[];
};

function makePrisma(user: UserShape | null, clientDomainAllowed: string[]) {
  return {
    user: {
      findUnique: async () => user,
    },
    clientDomain: {
      findUnique: async () => ({ allowedEmailDomains: clientDomainAllowed }),
    },
  } as never;
}

function baseUser(overrides: Partial<UserShape> = {}): UserShape {
  return {
    email: 'bob@acme.com',
    domainRoles: [],
    orgMembers: [],
    teamMembers: [],
    ...overrides,
  };
}

async function run(user: UserShape | null, clientDomainAllowed: string[]): Promise<void> {
  await assertEmailDomainAllowedForLogin(
    { userId: 'u1', domain: 'auth.acme.com' },
    { prisma: makePrisma(user, clientDomainAllowed) },
  );
}

async function expectBlocked(user: UserShape | null, clientDomainAllowed: string[]): Promise<void> {
  await expect(run(user, clientDomainAllowed)).rejects.toSatisfy(
    (err: unknown) => isAppError(err) && err.statusCode === 403,
  );
}

describe('assertEmailDomainAllowedForLogin', () => {
  it('allows when no level restricts', async () => {
    await expect(run(baseUser(), [])).resolves.toBeUndefined();
  });

  it('allows when the client-domain restriction matches the email domain', async () => {
    await expect(run(baseUser(), ['acme.com'])).resolves.toBeUndefined();
  });

  it('blocks when the client-domain restriction excludes the email domain', async () => {
    await expectBlocked(baseUser({ email: 'bob@evil.com' }), ['acme.com']);
  });

  it('blocks on an org-level restriction even when the client domain is open', async () => {
    await expectBlocked(
      baseUser({ email: 'bob@evil.com', orgMembers: [{ org: { allowedEmailDomains: ['acme.com'] } }] }),
      [],
    );
  });

  it('blocks on a team-level restriction even when the client domain is open', async () => {
    await expectBlocked(
      baseUser({ email: 'bob@evil.com', teamMembers: [{ team: { allowedEmailDomains: ['acme.com'] } }] }),
      [],
    );
  });

  it('requires every non-empty level to match (AND semantics)', async () => {
    // email matches the client domain but not the team — must still be blocked.
    await expectBlocked(
      baseUser({ email: 'bob@acme.com', teamMembers: [{ team: { allowedEmailDomains: ['other.com'] } }] }),
      ['acme.com'],
    );
  });

  it('lets a SUPERUSER bypass every restriction', async () => {
    await expect(
      run(
        baseUser({
          email: 'root@evil.com',
          domainRoles: [{ role: 'SUPERUSER' }],
          orgMembers: [{ org: { allowedEmailDomains: ['acme.com'] } }],
        }),
        ['acme.com'],
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks when a restriction exists but the email has no parseable domain', async () => {
    await expectBlocked(baseUser({ email: 'not-an-email' }), ['acme.com']);
  });

  it('is a no-op when the user record is missing', async () => {
    await expect(run(null, ['acme.com'])).resolves.toBeUndefined();
  });
});
