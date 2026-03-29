import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertDatabaseEnabled } from './organisation.service.base.js';
import { buildUserIdentity } from './user-scope.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendTeamInviteEmail } from './email.service.js';
import { selectRedirectUrl } from './token.service.js';
import { normalizeTeamRole } from './team.service.base.js';
import {
  type InviteDeps,
  type TeamInviteRecord,
  type TeamInviteCreateResult,
  buildTeamInviteLink,
  buildTeamInviteTrackingPixelUrl,
  getEnv,
  hashEmailToken,
  issueInviteToken,
  normalizeEmail,
  normalizeInviteName,
  resolveBaseUrl,
  resolveInviteTarget,
  toInviteRecord,
  type InvitePrisma,
} from './team-invite.service.base.js';

export async function createTeamInvites(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    config: ClientConfig;
    configUrl: string;
    redirectUrl?: string;
    invitedBy?: {
      userId?: string;
      name?: string;
      email?: string;
    };
    invites: Array<{
      email: string;
      name?: string;
      teamRole?: string;
    }>;
  },
  deps?: InviteDeps & {
    sendTeamInviteEmail?: typeof sendTeamInviteEmail;
  },
): Promise<{ results: TeamInviteCreateResult[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
    domain: params.domain,
  });

  const redirectUrl = params.redirectUrl
    ? selectRedirectUrl({
        allowedRedirectUrls: params.config.redirect_urls,
        requestedRedirectUrl: params.redirectUrl,
      })
    : undefined;

  const theme = extractEmailTheme(params.config);
  const baseUrl = resolveBaseUrl(env);
  const invitedByName = normalizeInviteName(params.invitedBy?.name);
  const invitedByEmail = params.invitedBy?.email ? normalizeEmail(params.invitedBy.email) : null;
  const invitedByUserId = params.invitedBy?.userId?.trim() || null;
  const results: TeamInviteCreateResult[] = [];

  for (const input of params.invites) {
    const email = normalizeEmail(input.email);
    const inviteName = normalizeInviteName(input.name);
    const teamRole = normalizeTeamRole(input.teamRole);
    const existingInvite = await prisma.teamInvite.findFirst({
      where: {
        teamId: team.id,
        email,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orgId: true,
        teamId: true,
        email: true,
        inviteName: true,
        teamRole: true,
        redirectUrl: true,
        invitedByUserId: true,
        invitedByName: true,
        invitedByEmail: true,
        acceptedUserId: true,
        acceptedAt: true,
        declinedAt: true,
        revokedAt: true,
        openedAt: true,
        openCount: true,
        lastSentAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const identity = buildUserIdentity({
      userScope: params.config.user_scope,
      email,
      domain: params.config.domain,
    });

    const existingUser = await prisma.user.findUnique({
      where: { userKey: identity.userKey },
      select: { id: true },
    });

    if (existingUser) {
      const existingTeamMembership = await prisma.teamMember.findFirst({
        where: {
          teamId: team.id,
          userId: existingUser.id,
        },
        select: { id: true },
      });
      if (existingTeamMembership) {
        results.push({ email, status: 'already_member' });
        continue;
      }

      const existingDomainMembership = await prisma.orgMember.findFirst({
        where: {
          userId: existingUser.id,
          org: {
            domain: org.domain,
          },
        },
        select: { orgId: true },
      });
      if (existingDomainMembership && existingDomainMembership.orgId !== org.id) {
        results.push({ email, status: 'conflict' });
        continue;
      }
    }

    const hadExistingUnresolvedInvite = Boolean(
      existingInvite &&
        !existingInvite.acceptedAt &&
        !existingInvite.declinedAt &&
        !existingInvite.revokedAt,
    );
    if (hadExistingUnresolvedInvite) {
      await prisma.teamInvite.updateMany({
        where: {
          teamId: team.id,
          email,
          acceptedAt: null,
          declinedAt: null,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });
    }

    const invite = await prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email,
        inviteName,
        teamRole,
        redirectUrl: redirectUrl ?? null,
        invitedByUserId,
        invitedByName,
        invitedByEmail,
        lastSentAt: now,
      },
      select: {
        id: true,
        orgId: true,
        teamId: true,
        email: true,
        inviteName: true,
        teamRole: true,
        redirectUrl: true,
        invitedByUserId: true,
        invitedByName: true,
        invitedByEmail: true,
        acceptedUserId: true,
        acceptedAt: true,
        declinedAt: true,
        revokedAt: true,
        openedAt: true,
        openCount: true,
        lastSentAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const token = await issueInviteToken({
      prisma,
      inviteId: invite.id,
      existingUserId: existingUser?.id ?? null,
      email,
      userKey: identity.userKey,
      domain: identity.domain,
      config: params.config,
      configUrl: params.configUrl,
      now,
      sharedSecret: deps?.sharedSecret,
      generateEmailTokenFn: deps?.generateEmailToken,
      hashEmailTokenFn: deps?.hashEmailToken ?? hashEmailToken,
    });

    const link = buildTeamInviteLink({
      baseUrl,
      token,
      configUrl: params.configUrl,
      redirectUrl,
    });

    await sendInviteEmail({
      to: email,
      link,
      trackingPixelUrl: buildTeamInviteTrackingPixelUrl({
        baseUrl,
        inviteId: invite.id,
      }),
      organisationName: org.name,
      teamName: team.name,
      inviteeName: inviteName ?? undefined,
      theme,
    });

    results.push({
      email,
      status: hadExistingUnresolvedInvite ? 'resent_existing' : 'invited',
      invite: toInviteRecord(invite),
    });
  }

  return { results };
}

export async function listTeamInvites(params: {
  orgId: string;
  teamId: string;
  domain: string;
}, deps?: InviteDeps): Promise<{ data: TeamInviteRecord[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
    domain: params.domain,
  });

  const rows = await prisma.teamInvite.findMany({
    where: {
      orgId: org.id,
      teamId: team.id,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      inviteName: true,
      teamRole: true,
      redirectUrl: true,
      invitedByUserId: true,
      invitedByName: true,
      invitedByEmail: true,
      acceptedUserId: true,
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      openedAt: true,
      openCount: true,
      lastSentAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return { data: rows.map(toInviteRecord) };
}

export async function resendTeamInvite(params: {
  orgId: string;
  teamId: string;
  inviteId: string;
  domain: string;
  config: ClientConfig;
  configUrl: string;
}, deps?: InviteDeps & {
  sendTeamInviteEmail?: typeof sendTeamInviteEmail;
}): Promise<TeamInviteRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendInviteEmail = deps?.sendTeamInviteEmail ?? sendTeamInviteEmail;

  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
    domain: params.domain,
  });

  const invite = await prisma.teamInvite.findFirst({
    where: {
      id: params.inviteId,
      orgId: org.id,
      teamId: team.id,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      inviteName: true,
      teamRole: true,
      redirectUrl: true,
      invitedByUserId: true,
      invitedByName: true,
      invitedByEmail: true,
      acceptedUserId: true,
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      openedAt: true,
      openCount: true,
      lastSentAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!invite) {
    throw new AppError('NOT_FOUND', 404);
  }
  if (invite.acceptedAt) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const identity = buildUserIdentity({
    userScope: params.config.user_scope,
    email: invite.email,
    domain: params.config.domain,
  });
  const existingUser = await prisma.user.findUnique({
    where: { userKey: identity.userKey },
    select: { id: true },
  });

  await prisma.teamInvite.updateMany({
    where: {
      teamId: team.id,
      email: invite.email,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
    },
  });

  const resentInvite = await prisma.teamInvite.create({
    data: {
      orgId: invite.orgId,
      teamId: invite.teamId,
      email: invite.email,
      inviteName: invite.inviteName,
      teamRole: invite.teamRole,
      redirectUrl: invite.redirectUrl,
      invitedByUserId: invite.invitedByUserId,
      invitedByName: invite.invitedByName,
      invitedByEmail: invite.invitedByEmail,
      lastSentAt: now,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      inviteName: true,
      teamRole: true,
      redirectUrl: true,
      invitedByUserId: true,
      invitedByName: true,
      invitedByEmail: true,
      acceptedUserId: true,
      acceptedAt: true,
      declinedAt: true,
      revokedAt: true,
      openedAt: true,
      openCount: true,
      lastSentAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const token = await issueInviteToken({
    prisma,
    inviteId: resentInvite.id,
    existingUserId: existingUser?.id ?? null,
    email: resentInvite.email,
    userKey: identity.userKey,
    domain: identity.domain,
    config: params.config,
    configUrl: params.configUrl,
    now,
    sharedSecret: deps?.sharedSecret,
    generateEmailTokenFn: deps?.generateEmailToken,
    hashEmailTokenFn: deps?.hashEmailToken ?? hashEmailToken,
  });

  const link = buildTeamInviteLink({
    baseUrl: resolveBaseUrl(env),
    token,
    configUrl: params.configUrl,
    redirectUrl: resentInvite.redirectUrl ?? undefined,
  });

  await sendInviteEmail({
    to: resentInvite.email,
    link,
    trackingPixelUrl: buildTeamInviteTrackingPixelUrl({
      baseUrl: resolveBaseUrl(env),
      inviteId: resentInvite.id,
    }),
    organisationName: org.name,
    teamName: team.name,
    inviteeName: resentInvite.inviteName ?? undefined,
    theme: extractEmailTheme(params.config),
  });

  return toInviteRecord(resentInvite);
}

export async function trackTeamInviteOpen(params: { inviteId: string }, deps?: InviteDeps): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    return;
  }

  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();

  await prisma.teamInvite.updateMany({
    where: {
      id: params.inviteId,
      openedAt: null,
    },
    data: {
      openedAt: now,
    },
  });
  await prisma.teamInvite.updateMany({
    where: {
      id: params.inviteId,
    },
    data: {
      openCount: {
        increment: 1,
      },
    },
  });
}
