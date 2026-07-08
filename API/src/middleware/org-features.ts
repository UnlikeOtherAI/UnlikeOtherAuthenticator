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
    // 404 keeps the feature invisible to the public, but the code lets debug-mode
    // integrators see why every /org/* call 404s (issue #7).
    throw new AppError('NOT_FOUND', 404, 'ORG_FEATURES_DISABLED');
  }
}

export async function requireOrgFeaturesEnabled(request: RequestWithConfig): Promise<void> {
  return requireOrgFeatures(request);
}

export default requireOrgFeatures;
