import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';

type DomainMappingPrisma = {
  organisation: Pick<PrismaClient['organisation'], 'findUnique'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
};

type DomainMappingDeps = {
  prisma?: DomainMappingPrisma;
};

type DomainMappingEntry = {
  email_domain: string;
  org_id: string;
  team_id?: string;
};

export type DomainMappingLookupResult =
  | { mapped: false }
  | {
      mapped: true;
      org_id: string;
      org_name: string;
      team_id: string;
      team_name: string;
    };

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function findMapping(
  config: ClientConfig,
  emailDomain: string,
): DomainMappingEntry | null {
  const mappings = config.registration_domain_mapping;
  if (!mappings?.length) {
    return null;
  }

  return (
    mappings.find((entry) => entry.email_domain === emailDomain) ?? null
  );
}

export async function lookupRegistrationDomainMapping(params: {
  config: ClientConfig;
  emailDomain: string;
}, deps?: DomainMappingDeps): Promise<DomainMappingLookupResult> {
  const mapping = findMapping(params.config, params.emailDomain);
  if (!mapping) {
    return { mapped: false };
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as DomainMappingPrisma);
  const configDomain = normalizeDomain(params.config.domain);

  const org = await prisma.organisation.findUnique({
    where: { id: mapping.org_id },
    select: {
      id: true,
      name: true,
      domain: true,
    },
  });
  if (!org) {
    return { mapped: false };
  }

  if (normalizeDomain(org.domain) !== configDomain) {
    return { mapped: false };
  }

  const team = await prisma.team.findFirst({
    where: mapping.team_id
      ? {
          id: mapping.team_id,
          orgId: org.id,
        }
      : {
          orgId: org.id,
          isDefault: true,
        },
    select: {
      id: true,
      name: true,
    },
  });
  if (!team) {
    return { mapped: false };
  }

  return {
    mapped: true,
    org_id: org.id,
    org_name: org.name,
    team_id: team.id,
    team_name: team.name,
  };
}
