import { describe, expect, it } from 'vitest';

import {
  assertEmailDomainAllowedForLogin,
  isEmailAdminAllowedForRegistration,
} from '../../src/services/login-domain-policy.service.js';
import { isAppError } from '../../src/utils/errors.js';

type ScopeShape = {
  allowedEmailDomains: string[];
  allowedEmails: string[];
};

type UserShape = {
  email: string;
  domainRoles: { role: string }[];
  orgMembers: { org: ScopeShape }[];
  teamMembers: { team: ScopeShape }[];
};

function scope(allowedEmailDomains: string[] = [], allowedEmails: string[] = []): ScopeShape {
  return { allowedEmailDomains, allowedEmails };
}

function makePrisma(
  user: UserShape | null,
  clientDomainAllowed: string[],
  clientDomainAllowedEmails: string[],
) {
  return {
    user: {
      findUnique: async () => user,
    },
    clientDomain: {
      findUnique: async () => scope(clientDomainAllowed, clientDomainAllowedEmails),
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

async function run(
  user: UserShape | null,
  clientDomainAllowed: string[],
  clientDomainAllowedEmails: string[] = [],
): Promise<void> {
  await assertEmailDomainAllowedForLogin(
    { userId: 'u1', domain: 'auth.acme.com' },
    { prisma: makePrisma(user, clientDomainAllowed, clientDomainAllowedEmails) },
  );
}

async function expectBlocked(
  user: UserShape | null,
  clientDomainAllowed: string[],
  clientDomainAllowedEmails: string[] = [],
): Promise<void> {
  await expect(run(user, clientDomainAllowed, clientDomainAllowedEmails)).rejects.toSatisfy(
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

  it('allows when the client-domain restriction matches the exact email', async () => {
    await expect(run(baseUser({ email: 'Bob@Evil.com' }), [], ['bob@evil.com'])).resolves.toBeUndefined();
  });

  it('blocks when the client-domain restriction excludes the email domain', async () => {
    await expectBlocked(baseUser({ email: 'bob@evil.com' }), ['acme.com']);
  });

  it('blocks when neither the domain nor exact email matches', async () => {
    await expectBlocked(baseUser({ email: 'bob@evil.com' }), ['acme.com'], ['alice@evil.com']);
  });

  it('blocks on an org-level restriction even when the client domain is open', async () => {
    await expectBlocked(
      baseUser({ email: 'bob@evil.com', orgMembers: [{ org: scope(['acme.com']) }] }),
      [],
    );
  });

  it('allows an email-only org-level restriction when the exact email matches', async () => {
    await expect(
      run(baseUser({ email: 'bob@evil.com', orgMembers: [{ org: scope([], ['bob@evil.com']) }] }), []),
    ).resolves.toBeUndefined();
  });

  it('blocks on a team-level restriction even when the client domain is open', async () => {
    await expectBlocked(
      baseUser({ email: 'bob@evil.com', teamMembers: [{ team: scope(['acme.com']) }] }),
      [],
    );
  });

  it('requires every non-empty level to match (AND semantics)', async () => {
    // email matches the client domain but not the team — must still be blocked.
    await expectBlocked(
      baseUser({ email: 'bob@acme.com', teamMembers: [{ team: scope(['other.com']) }] }),
      ['acme.com'],
    );
  });

  it('lets a SUPERUSER bypass every restriction', async () => {
    await expect(
      run(
        baseUser({
          email: 'root@evil.com',
          domainRoles: [{ role: 'SUPERUSER' }],
          orgMembers: [{ org: scope(['acme.com'], ['someone@acme.com']) }],
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

function makeRegistrationPrisma(clientDomain: ScopeShape | null) {
  return {
    clientDomain: {
      findUnique: async () => clientDomain,
    },
  } as never;
}

describe('isEmailAdminAllowedForRegistration', () => {
  it('grants when the exact email is allow-listed (case-insensitive)', async () => {
    await expect(
      isEmailAdminAllowedForRegistration(
        { domain: 'auth.acme.com', email: 'Invitee@Partner.com' },
        { prisma: makeRegistrationPrisma(scope([], ['invitee@partner.com'])) },
      ),
    ).resolves.toBe(true);
  });

  it('grants when the email domain is allow-listed', async () => {
    await expect(
      isEmailAdminAllowedForRegistration(
        { domain: 'auth.acme.com', email: 'someone@partner.com' },
        { prisma: makeRegistrationPrisma(scope(['partner.com'], [])) },
      ),
    ).resolves.toBe(true);
  });

  it('denies when neither the email nor its domain is listed', async () => {
    await expect(
      isEmailAdminAllowedForRegistration(
        { domain: 'auth.acme.com', email: 'stranger@elsewhere.com' },
        { prisma: makeRegistrationPrisma(scope(['partner.com'], ['invitee@partner.com'])) },
      ),
    ).resolves.toBe(false);
  });

  it('denies when both allow-lists are empty', async () => {
    await expect(
      isEmailAdminAllowedForRegistration(
        { domain: 'auth.acme.com', email: 'invitee@partner.com' },
        { prisma: makeRegistrationPrisma(scope([], [])) },
      ),
    ).resolves.toBe(false);
  });

  it('denies when the client domain is not registered', async () => {
    await expect(
      isEmailAdminAllowedForRegistration(
        { domain: 'auth.acme.com', email: 'invitee@partner.com' },
        { prisma: makeRegistrationPrisma(null) },
      ),
    ).resolves.toBe(false);
  });
});
