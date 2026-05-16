import type { FastifyRequest } from 'fastify';

import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

export { normalizeDomain };

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
