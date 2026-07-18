import type { FastifyReply, FastifyRequest } from 'fastify';

import { isMcpOAuthPublicProfileEnabled } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

/** Keep the optional public-client profile closed before route-specific parsing,
 * rate limiting, or persistence. Signing-key presence alone is not authorization. */
export async function requireMcpOAuthPublicProfile(
  _request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!isMcpOAuthPublicProfileEnabled()) {
    throw new AppError('NOT_FOUND', 404);
  }
}
