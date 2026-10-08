import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { ConfidentialActorChain } from './oauth/access-token.service.js';

export const SECRET = /^uoa_job_[A-Za-z0-9_-]{43}$/u;
export const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WATER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export type JobComputePurpose = 'research_compute' | 'scope_turn_compute';
export type JobComputeIdentity = {
  originInvocationId: string;
  ledgerJobId: string;
  waterJobId: string;
  scopeTurnId: string | null;
  purpose: JobComputePurpose;
};
export type IssueJobComputeRenewalInput = JobComputeIdentity & {
  issueKey: string;
  secret: string;
};
export type JobComputeDispatchIdentity = JobComputeIdentity & { grantId: string };
export type Grant = NonNullable<
  Awaited<ReturnType<PrismaClient['billingJobComputeRenewal']['findUnique']>>
>;

export function deny(code = 'JOB_COMPUTE_RENEWAL_DENIED'): never {
  throw new AppError('FORBIDDEN', 403, code);
}

export function validIdentity(input: JobComputeIdentity): void {
  if (
    !ID.test(input.originInvocationId) ||
    !ID.test(input.ledgerJobId) ||
    !WATER_UUID.test(input.waterJobId) ||
    (input.purpose === 'scope_turn_compute') !== (input.scopeTurnId !== null) ||
    (input.scopeTurnId !== null && !ID.test(input.scopeTurnId))
  ) {
    throw new AppError('BAD_REQUEST', 400, 'JOB_COMPUTE_IDENTITY_INVALID');
  }
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function immutableKey(input: JobComputeIdentity): string {
  return hash(
    JSON.stringify([
      input.originInvocationId,
      input.ledgerJobId,
      input.waterJobId,
      input.scopeTurnId,
      input.purpose,
    ]),
  );
}

export function identityMatches(row: Grant, input: JobComputeIdentity): boolean {
  return (
    row.originInvocationId === input.originInvocationId &&
    row.ledgerJobId === input.ledgerJobId &&
    row.waterJobId === input.waterJobId &&
    row.scopeTurnId === input.scopeTurnId &&
    row.purpose === input.purpose
  );
}

export function originalIdentityDomain(
  sourceDomain: string,
  actor: ConfidentialActorChain | undefined,
): string {
  let domain = sourceDomain;
  for (let current = actor; current; current = current.act) domain = current.sub;
  return domain;
}
