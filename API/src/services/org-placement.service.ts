import { Prisma, type PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';
import { getAppLogger } from '../utils/app-logger.js';
import { extractEmailDomain } from '../utils/email-domain.js';
import {
  deriveSlugWithValidation,
  ensureOrgName,
} from './organisation.service.base.js';
import { deriveUniqueTeamSlug } from './team.service.base.js';

type OrgPlacementPrisma = Pick<PrismaClient, '$transaction'> & {
  organisation: Pick<PrismaClient['organisation'], 'findUnique' | 'create' | 'findFirst'>;
  team: Pick<PrismaClient['team'], 'findFirst' | 'create'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findFirst' | 'create'>;
  teamMember: Pick<PrismaClient['teamMember'], 'create'>;
  teamInvite: Pick<PrismaClient['teamInvite'], 'findFirst'>;
  user: Pick<PrismaClient['user'], 'findUnique'>;
};

type OrgPlacementTx = Prisma.TransactionClient & {
  organisation: Pick<Prisma.TransactionClient['organisation'], 'create' | 'findFirst'>;
  team: Pick<Prisma.TransactionClient['team'], 'create' | 'findFirst'>;
  orgMember: Pick<Prisma.TransactionClient['orgMember'], 'findFirst' | 'create'>;
  teamMember: Pick<Prisma.TransactionClient['teamMember'], 'create'>;
};

type OrgPlacementLogger = (message: string, details: Record<string, unknown>) => void;

type OrgPlacementDeps = {
  prisma?: OrgPlacementPrisma;
  logError?: OrgPlacementLogger;
};

export type RegistrationOrgPlacementSkipReason =
  | 'org_features_disabled'
  | 'mapping_not_found'
  | 'no_placement_configured'
  | 'pending_invite_blocks_auto_create'
  | 'invalid_email'
  | 'member_role_not_allowed'
  | 'org_not_found'
  | 'org_domain_mismatch'
  | 'team_not_found'
  | 'default_team_missing'
  | 'already_member_for_domain'
  | 'auto_create_failed'
  | 'transaction_failed';

export type RegistrationOrgPlacementResult =
  | { status: 'placed'; orgId: string; teamId: string }
  | { status: 'auto_created'; orgId: string; teamId: string }
  | { status: 'skipped'; reason: RegistrationOrgPlacementSkipReason };

const DEFAULT_MEMBER_ROLE = 'member';
const DEFAULT_TEAM_ROLE = 'member';
const OWNER_ROLE = 'owner';
const DEFAULT_TEAM_NAME = 'General';
const MAX_ORG_NAME_LENGTH = 100;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function findMappingForEmailDomain(params: {
  config: ClientConfig;
  emailDomain: string;
}): { email_domain: string; org_id: string; team_id?: string } | null {
  const mappings = params.config.registration_domain_mapping;
  if (!mappings?.length) {
    return null;
  }

  return mappings.find((entry) => entry.email_domain === params.emailDomain) ?? null;
}

function isConstraintViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2002' || err.code === 'P2003')
  );
}

function defaultLogError(message: string, details: Record<string, unknown>): void {
  getAppLogger().error(details, message);
}

function deriveOrgNameFromUser(params: { name?: string | null; email: string }): string {
  const base = params.name?.trim() || params.email.split('@')[0]?.trim() || 'My';
  const candidate = `${base}'s organisation`;
  return candidate.slice(0, MAX_ORG_NAME_LENGTH);
}

async function hasPendingInviteForEmail(params: {
  prisma: OrgPlacementPrisma;
  email: string;
}): Promise<boolean> {
  const invite = await params.prisma.teamInvite.findFirst({
    where: {
      email: params.email,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
    },
    select: { id: true },
  });
  return Boolean(invite);
}

async function autoCreatePersonalOrgForUser(params: {
  userId: string;
  email: string;
  domain: string;
  prisma: OrgPlacementPrisma;
  logError: OrgPlacementLogger;
}): Promise<RegistrationOrgPlacementResult> {
  const user = await params.prisma.user.findUnique({
    where: { id: params.userId },
    select: { name: true },
  });

  const orgName = ensureOrgName(deriveOrgNameFromUser({ name: user?.name, email: params.email }));

  try {
    const created = await params.prisma.$transaction(async (tx) => {
      const txClient = tx as OrgPlacementTx;

      const existing = await txClient.orgMember.findFirst({
        where: {
          userId: params.userId,
          org: { domain: params.domain },
        },
        select: { id: true },
      });
      if (existing) {
        return null;
      }

      const slug = await deriveSlugWithValidation(params.domain, txClient, orgName);

      const org = await txClient.organisation.create({
        data: {
          domain: params.domain,
          name: orgName,
          slug,
          ownerId: params.userId,
        },
        select: { id: true },
      });

      const team = await txClient.team.create({
        data: {
          orgId: org.id,
          name: DEFAULT_TEAM_NAME,
          slug: await deriveUniqueTeamSlug({
            orgId: org.id,
            prisma: txClient,
            name: DEFAULT_TEAM_NAME,
          }),
          isDefault: true,
        },
        select: { id: true },
      });

      await txClient.orgMember.create({
        data: {
          orgId: org.id,
          userId: params.userId,
          role: OWNER_ROLE,
        },
      });

      await txClient.teamMember.create({
        data: {
          teamId: team.id,
          userId: params.userId,
          teamRole: DEFAULT_TEAM_ROLE,
        },
      });

      return { orgId: org.id, teamId: team.id };
    });

    if (!created) {
      return { status: 'skipped', reason: 'already_member_for_domain' };
    }

    return { status: 'auto_created', orgId: created.orgId, teamId: created.teamId };
  } catch (err) {
    params.logError('failed to auto-create personal organisation on first login', {
      domain: params.domain,
      userId: params.userId,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return { status: 'skipped', reason: 'auto_create_failed' };
  }
}

async function placeFromDomainMapping(params: {
  userId: string;
  email: string;
  emailDomain: string;
  domain: string;
  mapping: { email_domain: string; org_id: string; team_id?: string };
  config: ClientConfig;
  prisma: OrgPlacementPrisma;
  logError: OrgPlacementLogger;
}): Promise<RegistrationOrgPlacementResult> {
  const allowedRoles = params.config.org_features?.org_roles ?? [];
  if (!allowedRoles.includes(DEFAULT_MEMBER_ROLE)) {
    params.logError('member role is not allowed by org_features.org_roles; skipping placement', {
      domain: params.domain,
      userId: params.userId,
      orgId: params.mapping.org_id,
      configuredRoles: allowedRoles,
    });
    return { status: 'skipped', reason: 'member_role_not_allowed' };
  }

  const org = await params.prisma.organisation.findUnique({
    where: { id: params.mapping.org_id },
    select: { id: true, domain: true },
  });
  if (!org) {
    params.logError('registration_domain_mapping references an unknown organisation', {
      domain: params.domain,
      userId: params.userId,
      orgId: params.mapping.org_id,
      emailDomain: params.emailDomain,
    });
    return { status: 'skipped', reason: 'org_not_found' };
  }

  if (normalizeDomain(org.domain) !== params.domain) {
    params.logError('registration_domain_mapping organisation domain mismatch', {
      domain: params.domain,
      userId: params.userId,
      orgId: org.id,
      orgDomain: org.domain,
      emailDomain: params.emailDomain,
    });
    return { status: 'skipped', reason: 'org_domain_mismatch' };
  }

  let teamId: string;
  if (params.mapping.team_id) {
    const team = await params.prisma.team.findFirst({
      where: {
        id: params.mapping.team_id,
        orgId: org.id,
      },
      select: { id: true },
    });
    if (!team) {
      params.logError(
        'registration_domain_mapping references a team outside the mapped organisation',
        {
          domain: params.domain,
          userId: params.userId,
          orgId: org.id,
          teamId: params.mapping.team_id,
          emailDomain: params.emailDomain,
        },
      );
      return { status: 'skipped', reason: 'team_not_found' };
    }
    teamId = team.id;
  } else {
    const defaultTeam = await params.prisma.team.findFirst({
      where: {
        orgId: org.id,
        isDefault: true,
      },
      select: { id: true },
    });
    if (!defaultTeam) {
      params.logError('registration_domain_mapping target organisation is missing a default team', {
        domain: params.domain,
        userId: params.userId,
        orgId: org.id,
        emailDomain: params.emailDomain,
      });
      return { status: 'skipped', reason: 'default_team_missing' };
    }
    teamId = defaultTeam.id;
  }

  const existingMembership = await params.prisma.orgMember.findFirst({
    where: {
      userId: params.userId,
      org: { domain: params.domain },
    },
    select: { id: true },
  });
  if (existingMembership) {
    return { status: 'skipped', reason: 'already_member_for_domain' };
  }

  try {
    const created = await params.prisma.$transaction(async (tx) => {
      const txClient = tx as OrgPlacementTx;

      const membershipInDomain = await txClient.orgMember.findFirst({
        where: {
          userId: params.userId,
          org: { domain: params.domain },
        },
        select: { id: true },
      });
      if (membershipInDomain) {
        return false;
      }

      await txClient.orgMember.create({
        data: {
          orgId: org.id,
          userId: params.userId,
          role: DEFAULT_MEMBER_ROLE,
        },
      });

      await txClient.teamMember.create({
        data: {
          teamId,
          userId: params.userId,
          teamRole: DEFAULT_TEAM_ROLE,
        },
      });

      return true;
    });

    if (!created) {
      return { status: 'skipped', reason: 'already_member_for_domain' };
    }

    return { status: 'placed', orgId: org.id, teamId };
  } catch (err) {
    if (isConstraintViolation(err)) {
      const concurrentMembership = await params.prisma.orgMember.findFirst({
        where: {
          userId: params.userId,
          org: { domain: params.domain },
        },
        select: { id: true },
      });
      if (concurrentMembership) {
        return { status: 'skipped', reason: 'already_member_for_domain' };
      }
    }

    params.logError('failed to auto-place user from registration_domain_mapping', {
      domain: params.domain,
      userId: params.userId,
      orgId: org.id,
      teamId,
      emailDomain: params.emailDomain,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return { status: 'skipped', reason: 'transaction_failed' };
  }
}

export async function placeUserInConfiguredOrganisation(
  params: {
    userId: string;
    email: string;
    config: ClientConfig;
  },
  deps?: OrgPlacementDeps,
): Promise<RegistrationOrgPlacementResult> {
  if (!params.config.org_features?.enabled) {
    return { status: 'skipped', reason: 'org_features_disabled' };
  }

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) {
    return { status: 'skipped', reason: 'invalid_email' };
  }

  const logError = deps?.logError ?? defaultLogError;
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgPlacementPrisma);
  const domain = normalizeDomain(params.config.domain);
  const mapping = findMappingForEmailDomain({ config: params.config, emailDomain });

  if (mapping) {
    return placeFromDomainMapping({
      userId: params.userId,
      email: params.email,
      emailDomain,
      domain,
      mapping,
      config: params.config,
      prisma,
      logError,
    });
  }

  const orgFeatures = params.config.org_features;
  if (!orgFeatures?.auto_create_personal_org_on_first_login) {
    return { status: 'skipped', reason: 'no_placement_configured' };
  }

  if (orgFeatures.pending_invites_block_auto_create) {
    const blocked = await hasPendingInviteForEmail({ prisma, email: params.email });
    if (blocked) {
      return { status: 'skipped', reason: 'pending_invite_blocks_auto_create' };
    }
  }

  return autoCreatePersonalOrgForUser({
    userId: params.userId,
    email: params.email,
    domain,
    prisma,
    logError,
  });
}
