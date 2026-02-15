import type { FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';

type RequestWithConfig = FastifyRequest & {
  config?: {
    org_features?: {
      enabled?: boolean;
    };
  };
};

export function requireOrgFeatures(request: RequestWithConfig): void {
  const enabled = request.config?.org_features?.enabled === true;
  if (!enabled) {
    throw new AppError('NOT_FOUND', 404);
  }
}

export function requireOrgFeaturesEnabled(request: RequestWithConfig): void {
  return requireOrgFeatures(request);
}

export default requireOrgFeatures;
