import {
  BillingAssignmentScope,
  type BillingCustomerActionIntent,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { BillingActor } from './billing-actor.service.js';

export const BILLING_CUSTOMER_ACTION = {
  STRIPE_CHECKOUT: 'stripe_checkout',
  STRIPE_PORTAL: 'stripe_portal',
  SUBSCRIPTION_CANCEL: 'subscription_cancel',
  CREDIT_TOP_UP: 'credit_top_up',
  CREDIT_AUTO_TOP_UP_SETUP: 'credit_auto_top_up_setup',
  CREDIT_AUTO_TOP_UP_UPDATE: 'credit_auto_top_up_update',
  CREDIT_AUTO_TOP_UP_DISABLE: 'credit_auto_top_up_disable',
  CREDIT_AUTO_TOP_UP_RECOVER: 'credit_auto_top_up_recover',
  RECURRING_ADDON_CHECKOUT: 'recurring_addon_checkout',
  RECURRING_ADDON_CANCEL: 'recurring_addon_cancel',
} as const;

export type BillingCustomerAction =
  (typeof BILLING_CUSTOMER_ACTION)[keyof typeof BILLING_CUSTOMER_ACTION];

type JsonScalar = null | boolean | number | string;
export type BillingCustomerActionRequest =
  | JsonScalar
  | BillingCustomerActionRequest[]
  | { [key: string]: BillingCustomerActionRequest };

type ActionIntentClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  'billingCustomerActionIntent'
>;

function canonicalJson(value: BillingCustomerActionRequest): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function billingCustomerActionDigest(value: BillingCustomerActionRequest): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertBinding(
  intent: BillingCustomerActionIntent,
  expected: {
    credential: VerifiedBillingAppKey;
    organisationId: string;
    teamId: string;
    userId: string;
    authorityScope: BillingAssignmentScope;
    operation: BillingCustomerAction;
    actor: Pick<BillingActor, 'jti' | 'tv' | 'exp'>;
    requestDigest: string;
  },
): void {
  if (
    intent.appKeyId !== expected.credential.id ||
    intent.serviceId !== expected.credential.service.id ||
    intent.orgId !== expected.organisationId ||
    intent.teamId !== expected.teamId ||
    intent.requestedByUserId !== expected.userId ||
    intent.authorityScope !== expected.authorityScope ||
    intent.operation !== expected.operation ||
    intent.actorJti !== expected.actor.jti ||
    intent.actorTokenVersion !== expected.actor.tv ||
    intent.actorExpiresAt.getTime() !== expected.actor.exp * 1000 ||
    intent.requestDigest !== expected.requestDigest
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CUSTOMER_ACTION_REPLAY_CONFLICT');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

export async function authorizeBillingCustomerAction(
  params: {
    credential: VerifiedBillingAppKey;
    organisationId: string;
    teamId: string;
    userId: string;
    authorityScope: BillingAssignmentScope;
    operation: BillingCustomerAction;
    actor: Pick<BillingActor, 'jti' | 'tv' | 'exp'>;
    request: BillingCustomerActionRequest;
  },
  deps?: { prisma?: ActionIntentClient },
): Promise<BillingCustomerActionIntent> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const requestDigest = billingCustomerActionDigest(params.request);
  const key = {
    appKeyId: params.credential.id,
    actorJti: params.actor.jti,
    operation: params.operation,
  };
  const expected = { ...params, requestDigest };
  const replay = await prisma.billingCustomerActionIntent.findUnique({
    where: { appKeyId_actorJti_operation: key },
  });
  if (replay) {
    assertBinding(replay, expected);
    return replay;
  }

  try {
    return await prisma.billingCustomerActionIntent.create({
      data: {
        appKeyId: params.credential.id,
        serviceId: params.credential.service.id,
        orgId: params.organisationId,
        teamId: params.teamId,
        requestedByUserId: params.userId,
        authorityScope: params.authorityScope,
        operation: params.operation,
        actorJti: params.actor.jti,
        actorTokenVersion: params.actor.tv,
        actorExpiresAt: new Date(params.actor.exp * 1000),
        requestDigest,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await prisma.billingCustomerActionIntent.findUnique({
      where: { appKeyId_actorJti_operation: key },
    });
    if (!winner) throw error;
    assertBinding(winner, expected);
    return winner;
  }
}
