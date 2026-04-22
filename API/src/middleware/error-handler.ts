import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  enrichAuthDebugForAppError,
  renderAuthDebugHtml,
} from '../services/auth-debug-page.service.js';
import { renderIntegrationStatusHtml } from '../services/integration-status-page.service.js';
import { isAppError, type AppError } from '../utils/errors.js';
import { buildPublicErrorBody } from '../utils/error-response.js';

function wantsHtml(request: { method: string; headers: { accept?: string } }): boolean {
  const accept = request.headers.accept ?? '';
  return request.method === 'GET' && accept.toLowerCase().includes('text/html');
}

function renderGenericErrorHtml(): string {
  // Keep this intentionally plain; detailed UI comes from the Auth app.
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Auth</title></head><body><main><h1>Request failed</h1><p>Please close this window and try again.</p></main></body></html>`;
}

function shouldRenderAuthDebug(request: {
  method: string;
  headers: { accept?: string };
  raw: { url?: string };
  authDebug?: unknown;
}): boolean {
  if (!wantsHtml(request)) return false;
  if (request.authDebug) return true;
  const requestUrl = request.raw.url ?? '';
  return requestUrl.startsWith('/auth');
}

function maybeRenderIntegrationStatusPage(
  request: FastifyRequest,
  error: AppError,
): string | null {
  const outcome = request.integrationOutcome;
  if (!outcome) return null;
  const code = error.message || error.code;
  if (code !== 'INTEGRATION_PENDING_REVIEW' && code !== 'INTEGRATION_DECLINED') return null;
  return renderIntegrationStatusHtml({
    kind: outcome.kind,
    domain: outcome.domain,
    contactEmail: outcome.kind === 'pending' ? outcome.contactEmail : null,
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Internal logs can contain specifics; user-facing responses must remain generic.
    request.log.error({ err: error }, 'request failed');

    if (error instanceof ZodError) {
      if (shouldRenderAuthDebug(request)) {
        reply
          .type('text/html; charset=utf-8')
          .status(400)
          .send(
            renderAuthDebugHtml({
              statusCode: 400,
              requestUrl: request.raw.url,
              error,
              debug: request.authDebug,
            }),
          );
        return;
      }
      if (wantsHtml(request)) {
        reply.type('text/html; charset=utf-8').status(400).send(renderGenericErrorHtml());
        return;
      }
      reply.status(400).send(buildPublicErrorBody({ request, error, statusCode: 400 }));
      return;
    }

    if (isAppError(error)) {
      if (wantsHtml(request)) {
        const integrationHtml = maybeRenderIntegrationStatusPage(request, error);
        if (integrationHtml) {
          reply
            .type('text/html; charset=utf-8')
            .status(error.statusCode)
            .send(integrationHtml);
          return;
        }
      }
      if (shouldRenderAuthDebug(request)) {
        enrichAuthDebugForAppError(request, error);
        reply
          .type('text/html; charset=utf-8')
          .status(error.statusCode)
          .send(
            renderAuthDebugHtml({
              statusCode: error.statusCode,
              requestUrl: request.raw.url,
              error,
              debug: request.authDebug,
            }),
          );
        return;
      }
      if (wantsHtml(request)) {
        reply
          .type('text/html; charset=utf-8')
          .status(error.statusCode)
          .send(renderGenericErrorHtml());
        return;
      }
      reply
        .status(error.statusCode)
        .send(buildPublicErrorBody({ request, error, statusCode: error.statusCode }));
      return;
    }

    if (shouldRenderAuthDebug(request)) {
      reply
        .type('text/html; charset=utf-8')
        .status(500)
        .send(
          renderAuthDebugHtml({
            statusCode: 500,
            requestUrl: request.raw.url,
            error,
            debug: request.authDebug,
          }),
        );
      return;
    }
    if (wantsHtml(request)) {
      reply.type('text/html; charset=utf-8').status(500).send(renderGenericErrorHtml());
      return;
    }
    reply.status(500).send(buildPublicErrorBody({ request, error, statusCode: 500 }));
  });
}
