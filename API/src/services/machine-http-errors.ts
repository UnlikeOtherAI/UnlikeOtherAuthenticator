import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { PUBLIC_ERROR_MESSAGE } from '../config/constants.js';
import { isAppError } from '../utils/errors.js';
import { PRODUCTION_PUBLIC_ERROR_CODES } from '../utils/public-error-codes.js';

/** Machine wire errors never contain bound values, database diagnostics or debug profiles. */
export function registerMachineHttpErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const transportStatus = error && typeof error === 'object' && 'statusCode' in error &&
      typeof error.statusCode === 'number' ? error.statusCode : undefined;
    const status = error instanceof ZodError ? 400 : isAppError(error) ? error.statusCode :
      transportStatus !== undefined && transportStatus >= 400 && transportStatus < 500 ? transportStatus : 503;
    request.log.warn({ status }, 'machine authority request failed');
    if (status >= 500) {
      reply.status(503).send({ decision: 'unavailable', reason: 'authority_unavailable' });
      return;
    }
    const code = isAppError(error) && error.message.startsWith('MACHINE_') &&
      PRODUCTION_PUBLIC_ERROR_CODES.has(error.message) ? error.message : undefined;
    reply.status(status).send({ error: PUBLIC_ERROR_MESSAGE, ...(code ? { code } : {}) });
  });
}
