import { SignJWT } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload, signTestConfigJwt } from './test-config.js';

export const hasDatabase = Boolean(process.env.DATABASE_URL);

type PrismaDeleteMany = () => Promise<unknown>;
type PrismaCreateUser = (args: {
  data: { email: string; userKey: string; passwordHash: null };
  select: { id: true };
}) => Promise<{ id: string }>;

type OrgTestDbHandle = {
  prisma: {
    clientDomainSecret: { deleteMany: PrismaDeleteMany };
    clientDomain: { deleteMany: PrismaDeleteMany };
    verificationToken: { deleteMany: PrismaDeleteMany };
    teamInvite: { deleteMany: PrismaDeleteMany };
    groupMember: { deleteMany: PrismaDeleteMany };
    teamMember: { deleteMany: PrismaDeleteMany };
    orgMember: { deleteMany: PrismaDeleteMany };
    team: { deleteMany: PrismaDeleteMany };
    group: { deleteMany: PrismaDeleteMany };
    organisation: { deleteMany: PrismaDeleteMany };
    user: {
      create: PrismaCreateUser;
      deleteMany: PrismaDeleteMany;
    };
  };
};

export type CursorList<T> = {
  data: T[];
  next_cursor: string | null;
};

export type OrgRecord = {
  id: string;
  domain: string;
  name: string;
  slug: string;
};

export type OrgListRecord = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  ownerId: string;
};

export type TeamRecord = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  groupId: string | null;
};

export type TeamWithMembersRecord = TeamRecord & {
  members: {
    id: string;
    teamId: string;
    userId: string;
    teamRole: string;
  }[];
};

export type TeamMemberRecord = {
  id: string;
  teamId: string;
  userId: string;
  avatarImageUrl: string;
  teamRole: string;
};

/** Docs/Auth/avatars.md §9: the URL a domain-hash caller can fetch this member's avatar with. */
export function expectedMemberAvatarImageUrl(userId: string, domain: string): string {
  return `/domain/users/${userId}/avatar?domain=${encodeURIComponent(domain)}`;
}

export type TeamInviteRecord = {
  id: string;
  orgId: string;
  teamId: string;
  email: string;
  inviteName: string | null;
  teamRole: string;
  status?: string;
  redirectUrl: string | null;
  invitedByUserId: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  declinedAt?: string | Date | null;
  openedAt?: string | Date | null;
  openCount?: number;
  lastSentAt: string | Date;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type OrgMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  avatarImageUrl: string;
  role: string;
};

export type OrgMeRecord = {
  org_id: string;
  org_role: string;
  /** Legacy claim field: team IDs, and the keys of `team_roles`. */
  teams: string[];
  team_roles: Record<string, string>;
  groups?: string[];
  group_admin?: string[];
  /** The additive renderable directory — a separate field, never a richer `teams`. */
  team_directory: { teamId: string; orgId: string; name: string; role: string }[];
};

export async function clearOrgTestDatabase(handle: OrgTestDbHandle): Promise<void> {
  // Sequential, children before parents: concurrent deletes race the
  // Restrict FK from organisations.owner_id to users and the client_domains
  // FK from client_domain_secrets.
  await handle.prisma.verificationToken.deleteMany();
  await handle.prisma.teamInvite.deleteMany();
  await handle.prisma.groupMember.deleteMany();
  await handle.prisma.teamMember.deleteMany();
  await handle.prisma.orgMember.deleteMany();
  await handle.prisma.team.deleteMany();
  await handle.prisma.group.deleteMany();
  await handle.prisma.organisation.deleteMany();
  await handle.prisma.user.deleteMany();
  await handle.prisma.clientDomainSecret.deleteMany();
  await handle.prisma.clientDomain.deleteMany();
}

function secretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

export async function createSignedConfigJwt(
  sharedSecret: string,
  orgFeatures: Record<string, unknown>,
  domain?: string,
  // `access_requests` is signed by the domain itself, so a test that exercises
  // the access-request routes must be able to choose its contents — including,
  // for tenant-isolation tests, ids that belong to a different tenant.
  accessRequests?: Record<string, unknown>,
): Promise<string> {
  void sharedSecret;
  // The config verifier requires the JWT's `domain` claim to match both the
  // config_url host and the ?domain= query, so tests using their own domain
  // must bake it into the signed config.
  const payload = baseClientConfigPayload({
    ...(domain
      ? { domain, redirect_urls: [`https://${domain}/oauth/callback`] }
      : {}),
    org_features: {
      enabled: true,
      ...orgFeatures,
    },
    ...(accessRequests ? { access_requests: accessRequests } : {}),
  });

  return await signTestConfigJwt(payload);
}

export async function signAccessToken(params: {
  subject: string;
  domain: string;
  secret: string;
  issuer: string;
  org?: {
    orgId: string;
    orgRole: string;
    teams?: string[];
    team_roles?: Record<string, string>;
  };
  email?: string;
  role?: 'user' | 'superuser';
}): Promise<string> {
  const claims: Record<string, unknown> = {
    email: params.email ?? 'owner@example.com',
    domain: params.domain,
    client_id: createClientId(params.domain, params.secret),
    role: params.role ?? 'user',
    ...(params.org
      ? {
          org: {
            org_id: params.org.orgId,
            org_role: params.org.orgRole,
            teams: params.org.teams ?? [],
            team_roles: params.org.team_roles ?? {},
          },
        }
      : {}),
  };

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(params.issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(params.subject)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(secretKey(params.secret));
}

export async function createTestUser(
  handle: OrgTestDbHandle,
  email: string,
): Promise<{ id: string }> {
  return await handle.prisma.user.create({
    data: {
      email,
      userKey: email,
      passwordHash: null,
    },
    select: { id: true },
  });
}
