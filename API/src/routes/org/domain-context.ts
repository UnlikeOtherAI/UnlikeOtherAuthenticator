import type { FastifyRequest } from 'fastify';

import { AppError } from '../../utils/errors.js';

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function assertVerifiedDomainMatchesQuery(
  request: FastifyRequest,
  queryDomain: string,
): void {
  const verifiedDomain = request.config?.domain;
  if (typeof verifiedDomain !== 'string') {
    throw new AppError('INTERNAL', 500, 'CONFIG_NOT_VERIFIED');
  }

  if (normalizeDomain(verifiedDomain) !== queryDomain) {
    throw new AppError('BAD_REQUEST', 400, 'DOMAIN_MISMATCH');
  }
}
