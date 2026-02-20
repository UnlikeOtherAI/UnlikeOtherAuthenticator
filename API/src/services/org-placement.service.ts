import { Prisma, type PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';

type OrgPlacementPrisma = Pick<PrismaClient, '$transaction'> & {
  organisation: Pick<PrismaClient['organisation'], 'findUnique'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
  orgMember: Pick<PrismaClient['orgMember'], 'findFirst'>;
};

type OrgPlacementTx = Prisma.TransactionClient & {
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
  | 'invalid_email'
  | 'member_role_not_allowed'
  | 'org_not_found'
  | 'org_domain_mismatch'
  | 'team_not_found'
  | 'default_team_missing'
  | 'already_member_for_domain'
  | 'transaction_failed';

export type RegistrationOrgPlacementResult =
  | { status: 'placed'; orgId: string; teamId: string }
  | { status: 'skipped'; reason: RegistrationOrgPlacementSkipReason };

const DEFAULT_MEMBER_ROLE = 'member';
const DEFAULT_TEAM_ROLE = 'member';

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function extractEmailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) return null;
  return email.slice(atIndex + 1).toLowerCase();
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
  console.error('[org-placement]', message, details);
}

export async function placeUserInConfiguredOrganisation(params: {
  userId: string;
  email: string;
  config: ClientConfig;
}, deps?: OrgPlacementDeps): Promise<RegistrationOrgPlacementResult> {
  if (!params.config.org_features?.enabled) {
    return { status: 'skipped', reason: 'org_features_disabled' };
  }

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) {
    return { status: 'skipped', reason: 'invalid_email' };
  }

  const mapping = findMappingForEmailDomain({
    config: params.config,
    emailDomain,
  });
  if (!mapping) {
    return { status: 'skipped', reason: 'mapping_not_found' };
  }

  const logError = deps?.logError ?? defaultLogError;
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgPlacementPrisma);
  const domain = normalizeDomain(params.config.domain);

  const allowedRoles = params.config.org_features?.org_roles ?? [];
  if (!allowedRoles.includes(DEFAULT_MEMBER_ROLE)) {
    logError('member role is not allowed by org_features.org_roles; skipping placement', {
      domain,
      userId: params.userId,
      orgId: mapping.org_id,
      configuredRoles: allowedRoles,
    });
    return { status: 'skipped', reason: 'member_role_not_allowed' };
  }

  const org = await prisma.organisation.findUnique({
    where: { id: mapping.org_id },
    select: { id: true, domain: true },
  });
  if (!org) {
    logError('registration_domain_mapping references an unknown organisation', {
      domain,
      userId: params.userId,
      orgId: mapping.org_id,
      emailDomain,
    });
    return { status: 'skipped', reason: 'org_not_found' };
  }

  if (normalizeDomain(org.domain) !== domain) {
    logError('registration_domain_mapping organisation domain mismatch', {
      domain,
      userId: params.userId,
      orgId: org.id,
      orgDomain: org.domain,
      emailDomain,
    });
    return { status: 'skipped', reason: 'org_domain_mismatch' };
  }

  let teamId: string;
  if (mapping.team_id) {
    const team = await prisma.team.findFirst({
      where: {
        id: mapping.team_id,
        orgId: org.id,
      },
      select: { id: true },
    });
    if (!team) {
      logError('registration_domain_mapping references a team outside the mapped organisation', {
        domain,
        userId: params.userId,
        orgId: org.id,
        teamId: mapping.team_id,
        emailDomain,
      });
      return { status: 'skipped', reason: 'team_not_found' };
    }

    teamId = team.id;
  } else {
    const defaultTeam = await prisma.team.findFirst({
      where: {
        orgId: org.id,
        isDefault: true,
      },
      select: { id: true },
    });
    if (!defaultTeam) {
      logError('registration_domain_mapping target organisation is missing a default team', {
        domain,
        userId: params.userId,
        orgId: org.id,
        emailDomain,
      });
      return { status: 'skipped', reason: 'default_team_missing' };
    }

    teamId = defaultTeam.id;
  }

  const existingMembership = await prisma.orgMember.findFirst({
    where: {
      userId: params.userId,
      org: {
        domain,
      },
    },
    select: { id: true },
  });
  if (existingMembership) {
    return { status: 'skipped', reason: 'already_member_for_domain' };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const txClient = tx as OrgPlacementTx;

      const membershipInDomain = await txClient.orgMember.findFirst({
        where: {
          userId: params.userId,
          org: {
            domain,
          },
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
      const concurrentMembership = await prisma.orgMember.findFirst({
        where: {
          userId: params.userId,
          org: {
            domain,
          },
        },
        select: { id: true },
      });
      if (concurrentMembership) {
        return { status: 'skipped', reason: 'already_member_for_domain' };
      }
    }

    logError('failed to auto-place user from registration_domain_mapping', {
      domain,
      userId: params.userId,
      orgId: org.id,
      teamId,
      emailDomain,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return { status: 'skipped', reason: 'transaction_failed' };
  }
}
