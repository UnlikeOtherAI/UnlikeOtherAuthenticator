import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { sendAccessRequestNotificationEmail } from './email.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import {
  AccessRequestPrisma,
  buildAdminReviewUrl,
  getEnv,
  isAutoGrantDomain,
  normalizeRequestName,
  resolveAccessTarget,
  toAccessRequestRecord,
  type AccessRequestRecord,
  ensureUserAssignedToConfiguredAccessTarget,
  assertDatabaseEnabled,
} from './access-request.service.base.js';

type AccessRequestAuthDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: AccessRequestPrisma;
  now?: () => Date;
  sendAccessRequestNotificationEmail?: typeof sendAccessRequestNotificationEmail;
};

export type PostAuthenticationAccessDecision =
  | { status: 'continue' }
  | { status: 'requested'; request: AccessRequestRecord };

type AccessRequestRecipient = {
  email: string;
};

async function listNotificationRecipients(params: {
  prisma: AccessRequestPrisma;
  orgId: string;
  roles: string[];
}): Promise<AccessRequestRecipient[]> {
  const rows = await params.prisma.orgMember.findMany({
    where: {
      orgId: params.orgId,
      role: {
        in: params.roles,
      },
    },
    select: {
      user: {
        select: {
          email: true,
        },
      },
    },
  });

  const emails = new Set<string>();
  for (const row of rows) {
    const email = row.user.email.trim().toLowerCase();
    if (email) emails.add(email);
  }

  return [...emails].map((email) => ({ email }));
}

export async function handlePostAuthenticationAccessRequest(params: {
  userId: string;
  config: ClientConfig;
}, deps?: AccessRequestAuthDeps): Promise<PostAuthenticationAccessDecision> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  if (!params.config.access_requests?.enabled) {
    return { status: 'continue' };
  }

  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sendNotification = deps?.sendAccessRequestNotificationEmail ?? sendAccessRequestNotificationEmail;
  const { org, team } = await resolveAccessTarget({
    prisma,
    config: params.config,
  });

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });
  if (!user) {
    return { status: 'continue' };
  }

  const existingTeamMembership = await prisma.teamMember.findFirst({
    where: {
      teamId: team.id,
      userId: user.id,
    },
    select: { id: true },
  });
  if (existingTeamMembership) {
    return { status: 'continue' };
  }

  // NOTE (Phase 4): join-policy gating of the access-request mechanism is intentionally NOT enforced
  // here. Access requests are already gated by the signed `access_requests` config, and that config's
  // target team lives in the config JWT — the foundation migration cannot reliably backfill
  // REQUEST_TO_JOIN/APPROVED_DOMAIN onto those teams, so enforcing a policy gate would silently break
  // existing auto-grant and request-to-join setups. Join-policy values are still stored and ARE
  // enforced for the new self-join (OPEN_TO_ORG) and HIDDEN-listing paths; enforcing them on this
  // legacy mechanism is deferred to a migration that can map config targets to teams. (Deviation from
  // design §4.6, raised per the non-breaking requirement.)
  if (isAutoGrantDomain({ email: user.email, config: params.config })) {
    await ensureUserAssignedToConfiguredAccessTarget({
      prisma,
      config: params.config,
      userId: user.id,
      now,
    });
    return { status: 'continue' };
  }

  const existingPending = await prisma.accessRequest.findFirst({
    where: {
      teamId: team.id,
      email: user.email,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  const request = existingPending
    ? await prisma.accessRequest.update({
        where: { id: existingPending.id },
        data: {
          userId: user.id,
          requestName: normalizeRequestName(user.name),
          lastRequestedAt: now,
          notifiedAt: now,
        },
        select: {
          id: true,
          orgId: true,
          teamId: true,
          email: true,
          requestName: true,
          status: true,
          requestedAt: true,
          lastRequestedAt: true,
          reviewedAt: true,
          reviewReason: true,
          notifiedAt: true,
          createdAt: true,
          updatedAt: true,
          userId: true,
          reviewedByUserId: true,
        },
      })
    : await prisma.accessRequest.create({
        data: {
          orgId: org.id,
          teamId: team.id,
          email: user.email,
          userId: user.id,
          requestName: normalizeRequestName(user.name),
          lastRequestedAt: now,
          notifiedAt: now,
        },
        select: {
          id: true,
          orgId: true,
          teamId: true,
          email: true,
          requestName: true,
          status: true,
          requestedAt: true,
          lastRequestedAt: true,
          reviewedAt: true,
          reviewReason: true,
          notifiedAt: true,
          createdAt: true,
          updatedAt: true,
          userId: true,
          reviewedByUserId: true,
        },
      });

  const recipients = await listNotificationRecipients({
    prisma,
    orgId: org.id,
    roles: params.config.access_requests.notify_org_roles,
  });
  const theme = extractEmailTheme(params.config);
  const reviewUrl = buildAdminReviewUrl(params.config);

  await Promise.all(
    recipients.map(async (recipient) => {
      await sendNotification({
        to: recipient.email,
        reviewUrl,
        requesterEmail: user.email,
        requesterName: user.name,
        organisationName: org.name,
        teamName: team.name,
        theme,
      });
    }),
  );

  return {
    status: 'requested',
    request: toAccessRequestRecord(request),
  };
}
