import type { FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';

type RequestWithConfig = FastifyRequest & {
  config?: {
    org_features?: {
      enabled?: boolean;
    };
  };
};

export async function requireOrgFeatures(request: RequestWithConfig): Promise<void> {
  const enabled = request.config?.org_features?.enabled === true;
  if (!enabled) {
    throw new AppError('NOT_FOUND', 404);
  }
}

export async function requireOrgFeaturesEnabled(request: RequestWithConfig): Promise<void> {
  return requireOrgFeatures(request);
}

export default requireOrgFeatures;
