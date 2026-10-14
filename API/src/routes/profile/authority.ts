import type { FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { parseBearerOrRawToken, resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { createKeyedRateLimiter } from '../../middleware/rate-limiter.js';
import type { ProfileAuthority } from '../../services/profile.service.js';
import { AppError } from '../../utils/errors.js';

export const ProfileQuery = z.object({ domain: z.string().min(1), config_url: z.string().min(1).max(2048) }).strict();
const consume = createKeyedRateLimiter({ limit: 600, windowMs: 60_000 });
export async function authorityFor(request: FastifyRequest): Promise<ProfileAuthority> {
  ProfileQuery.parse(request.query);
  if (!request.config || !request.domainAuthClientDomainId || !request.domainAuthCredential) {
    throw new AppError('UNAUTHORIZED', 401);
  }
  const claims = await resolveOrgUserClaims(request);
  const credential = request.headers['x-uoa-subject-assertion'] ?? request.headers['x-uoa-access-token'];
  if (typeof credential !== 'string') throw new AppError('UNAUTHORIZED', 401);
  const raw = parseBearerOrRawToken(credential);
  if (!raw) throw new AppError('UNAUTHORIZED', 401);
  // Decode only the exact credential whose signature was just verified. Expiry is
  // checked afresh under the service locks before any read or mutation.
  const expiresAt = z.number().finite().parse(decodeJwt(raw).exp);
  consume(`${request.domainAuthClientDomainId}:${claims.userId}`);
  return { claims, expiresAt, config: request.config, clientDomainId: request.domainAuthClientDomainId,
    domainCredential: request.domainAuthCredential };
}
