import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';

export async function requireGroupsEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const config = request.config;
  if (!config?.org_features?.groups_enabled) {
    throw new AppError('NOT_FOUND', 404);
  }
}
