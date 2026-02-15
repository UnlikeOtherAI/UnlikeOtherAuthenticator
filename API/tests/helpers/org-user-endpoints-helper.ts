import { SignJWT } from 'jose';

import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from './test-config.js';

export const hasDatabase = Boolean(process.env.DATABASE_URL);

type PrismaDeleteMany = () => Promise<unknown>;
type PrismaCreateUser = (args: {
  data: { email: string; userKey: string; passwordHash: null };
  select: { id: true };
}) => Promise<{ id: string }>;

type OrgTestDbHandle = {
  prisma: {
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
  teamRole: string;
};

export type OrgMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  role: string;
};

export function clearOrgTestDatabase(handle: OrgTestDbHandle): Promise<unknown[]> {
  return Promise.all([
    handle.prisma.groupMember.deleteMany(),
    handle.prisma.teamMember.deleteMany(),
    handle.prisma.orgMember.deleteMany(),
    handle.prisma.team.deleteMany(),
    handle.prisma.group.deleteMany(),
    handle.prisma.organisation.deleteMany(),
    handle.prisma.user.deleteMany(),
  ]);
}

function secretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

export async function createSignedConfigJwt(
  sharedSecret: string,
  orgFeatures: Record<string, unknown>,
): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  const payload = baseClientConfigPayload({
    org_features: {
      enabled: true,
      ...orgFeatures,
    },
  });

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(secretKey(sharedSecret));
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
