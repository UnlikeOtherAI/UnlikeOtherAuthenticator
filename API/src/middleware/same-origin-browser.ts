import type { FastifyRequest } from 'fastify';

import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * Reject cross-site browser mutations while preserving server-to-server clients that do not
 * send browser fetch metadata. Capability tokens remain the primary authorization boundary.
 */
export async function requireSameOriginBrowserRequest(request: FastifyRequest): Promise<void> {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new AppError('FORBIDDEN', 403, 'CROSS_SITE_REQUEST_REJECTED');
  }
  const rawOrigin = request.headers.origin;
  if (typeof rawOrigin !== 'string') return;
  try {
    if (new URL(rawOrigin).origin !== new URL(getPublicBaseUrl()).origin) {
      throw new Error('origin mismatch');
    }
  } catch {
    throw new AppError('FORBIDDEN', 403, 'CROSS_SITE_REQUEST_REJECTED');
  }
}
