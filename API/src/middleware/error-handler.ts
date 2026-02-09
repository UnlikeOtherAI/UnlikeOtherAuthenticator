import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { PUBLIC_ERROR_MESSAGE } from '../config/constants.js';
import { isAppError } from '../utils/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Internal logs can contain specifics; user-facing responses must remain generic.
    request.log.error({ err: error }, 'request failed');

    if (error instanceof ZodError) {
      reply.status(400).send({ error: PUBLIC_ERROR_MESSAGE });
      return;
    }

    if (isAppError(error)) {
      reply.status(error.statusCode).send({ error: PUBLIC_ERROR_MESSAGE });
      return;
    }

    reply.status(500).send({ error: PUBLIC_ERROR_MESSAGE });
  });
}

