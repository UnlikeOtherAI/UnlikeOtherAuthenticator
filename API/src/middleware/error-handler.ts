import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { PUBLIC_ERROR_MESSAGE } from '../config/constants.js';
import { isAppError } from '../utils/errors.js';

function wantsHtml(request: { method: string; headers: { accept?: string } }): boolean {
  const accept = request.headers.accept ?? '';
  return request.method === 'GET' && accept.toLowerCase().includes('text/html');
}

function renderGenericErrorHtml(): string {
  // Keep this intentionally plain; detailed UI comes from the Auth app.
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Auth</title></head><body><main><h1>Request failed</h1><p>Please close this window and try again.</p></main></body></html>`;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Internal logs can contain specifics; user-facing responses must remain generic.
    request.log.error({ err: error }, 'request failed');

    if (error instanceof ZodError) {
      if (wantsHtml(request)) {
        reply.type('text/html; charset=utf-8').status(400).send(renderGenericErrorHtml());
        return;
      }
      reply.status(400).send({ error: PUBLIC_ERROR_MESSAGE });
      return;
    }

    if (isAppError(error)) {
      if (wantsHtml(request)) {
        reply
          .type('text/html; charset=utf-8')
          .status(error.statusCode)
          .send(renderGenericErrorHtml());
        return;
      }
      reply.status(error.statusCode).send({ error: PUBLIC_ERROR_MESSAGE });
      return;
    }

    if (wantsHtml(request)) {
      reply.type('text/html; charset=utf-8').status(500).send(renderGenericErrorHtml());
      return;
    }
    reply.status(500).send({ error: PUBLIC_ERROR_MESSAGE });
  });
}
