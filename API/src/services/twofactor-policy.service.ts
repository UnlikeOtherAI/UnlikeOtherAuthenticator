import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';

export type TwoFaPolicyValue = 'OFF' | 'OPTIONAL' | 'REQUIRED';
export type TwoFaPolicyInput = 'off' | 'optional' | 'required';
export type OrganisationTwoFaPolicyInput = 'inherit' | TwoFaPolicyInput;

const policyRank: Record<TwoFaPolicyValue, number> = {
  OFF: 0,
  OPTIONAL: 1,
  REQUIRED: 2,
};

type PolicyPrisma = {
  clientDomain: {
    findUnique(args: {
      where: { domain: string };
      select: { twoFaPolicy: true };
    }): Promise<{ twoFaPolicy: TwoFaPolicyValue } | null>;
  };
  organisation: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { twoFaPolicy: true };
    }): Promise<Array<{ twoFaPolicy: TwoFaPolicyValue | null }>>;
  };
};

function prismaClient(deps?: { prisma?: PolicyPrisma }): PolicyPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as PolicyPrisma);
}

export function strongestTwoFaPolicy(
  first: TwoFaPolicyValue,
  second: TwoFaPolicyValue,
): TwoFaPolicyValue {
  return policyRank[second] > policyRank[first] ? second : first;
}

export function isTwoFaAuthenticationSufficient(params: {
  policy: TwoFaPolicyValue;
  twoFaEnabled: boolean;
  twoFaCompleted: boolean;
}): boolean {
  if (params.policy === 'OFF') return true;
  if (params.twoFaEnabled) return params.twoFaCompleted;
  return params.policy !== 'REQUIRED';
}

export function toPublicTwoFaPolicy(policy: TwoFaPolicyValue): TwoFaPolicyInput {
  return policy.toLowerCase() as TwoFaPolicyInput;
}

export function parseTwoFaPolicyInput(value: unknown): TwoFaPolicyValue {
  if (value === 'off') return 'OFF';
  if (value === 'optional') return 'OPTIONAL';
  if (value === 'required') return 'REQUIRED';
  throw new AppError('BAD_REQUEST', 400, 'INVALID_TWOFA_POLICY');
}

export function parseOrganisationTwoFaPolicyInput(value: unknown): TwoFaPolicyValue | null {
  if (value === 'inherit') return null;
  return parseTwoFaPolicyInput(value);
}

export async function resolveTwoFaPolicy(
  params: {
    config: Pick<ClientConfig, '2fa_enabled' | 'domain'>;
    userId?: string | null;
    /** Exact selected or prospective access-target organisation. */
    orgId?: string | null;
  },
  deps?: { prisma?: PolicyPrisma },
): Promise<TwoFaPolicyValue> {
  if (params.config['2fa_enabled'] !== true) {
    return 'OFF';
  }

  const prisma = prismaClient(deps);
  const [domainPolicy, orgPolicies] = await Promise.all([
    prisma.clientDomain.findUnique({
      where: { domain: params.config.domain },
      select: { twoFaPolicy: true },
    }),
    params.userId || params.orgId
      ? prisma.organisation.findMany({
          where: {
            OR: [
              ...(params.userId
                ? [
                    {
                      domain: params.config.domain,
                      // Lifecycle tombstones must not keep enforcing an
                      // organisation's policy after the user has left it.
                      members: { some: { userId: params.userId, status: 'ACTIVE' as const } },
                    },
                  ]
                : []),
              ...(params.orgId ? [{ id: params.orgId }] : []),
            ],
          },
          select: { twoFaPolicy: true },
        })
      : Promise.resolve([]),
  ]);

  let effective: TwoFaPolicyValue = domainPolicy?.twoFaPolicy ?? 'OPTIONAL';
  for (const org of orgPolicies) {
    effective = strongestTwoFaPolicy(effective, org.twoFaPolicy ?? 'OFF');
  }

  return effective;
}
