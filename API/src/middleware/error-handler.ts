import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  enrichAuthDebugForAppError,
  renderAuthDebugHtml,
  type AuthDebugInfo,
} from '../services/auth-debug-page.service.js';
import { renderClaimInvalidHtml } from '../services/integration-claim-page.service.js';
import { renderIntegrationStatusHtml } from '../services/integration-status-page.service.js';
import { getEnv } from '../config/env.js';
import { isAppError, type AppError } from '../utils/errors.js';
import {
  buildPublicErrorBody,
  PRODUCTION_PUBLIC_ERROR_CODES,
} from '../utils/error-response.js';

function wantsHtml(request: { method: string; headers: { accept?: string } }): boolean {
  const accept = request.headers.accept ?? '';
  return request.method === 'GET' && accept.toLowerCase().includes('text/html');
}

function isIntegrationClaimRequest(request: { raw: { url?: string } }): boolean {
  return (request.raw.url ?? '').startsWith('/integrations/claim/');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderGenericErrorHtml(code?: string): string {
  const codeHtml = code ? `<p><code>${escapeHtml(code)}</code></p>` : '';
  // Keep this intentionally plain; detailed UI comes from the Auth app.
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Auth</title></head><body><main><h1>Request failed</h1><p>Please close this window and try again.</p>${codeHtml}</main></body></html>`;
}

function shouldRenderAuthDebug(request: {
  method: string;
  headers: { accept?: string };
  raw: { url?: string };
  authDebug?: AuthDebugInfo;
}): boolean {
  if (!wantsHtml(request)) return false;
  if (!getEnv().DEBUG_ENABLED) return false;
  // request.authDebug is not an operator opt-in: config-verifier seeds it on
  // every /auth* request before verification runs, so the presence check below
  // would still show every anonymous HTML caller the full diagnostic page
  // (redirect allowlist, Zod issues, config example). DEBUG_ENABLED is the
  // actual gate — the same flag that unlocks the debug JSON body.
  if (request.authDebug) return true;
  const requestUrl = request.raw.url ?? '';
  return requestUrl.startsWith('/auth');
}

function genericErrorCode(request: { authDebug?: AuthDebugInfo }, error: unknown): string | undefined {
  let code: string | undefined;
  if (error instanceof ZodError) {
    code = 'AUTH_REQUEST_INVALID';
  } else if (isAppError(error)) {
    code = request.authDebug?.code ?? error.message;
  }
  if (!code) return undefined;
  // AppError messages are not always code-shaped; never render a sentence as
  // if it were an error code (the JSON path applies the same guard).
  if (!/^[A-Z0-9_]+$/.test(code)) return undefined;
  // Mirror buildPublicErrorBody: with DEBUG_ENABLED off, the JSON body only
  // exposes codes in PRODUCTION_PUBLIC_ERROR_CODES and squashes the rest to a
  // fully generic body — the HTML page must not leak what JSON withholds.
  if (!getEnv().DEBUG_ENABLED && !PRODUCTION_PUBLIC_ERROR_CODES.has(code)) {
    return undefined;
  }
  return code;
}

function maybeRenderIntegrationStatusPage(request: FastifyRequest, error: AppError): string | null {
  const outcome = request.integrationOutcome;
  if (!outcome) return null;
  const code = error.message || error.code;
  if (code !== 'INTEGRATION_PENDING_REVIEW' && code !== 'INTEGRATION_DECLINED') return null;
  return renderIntegrationStatusHtml({
    kind: outcome.kind,
    domain: outcome.domain,
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Internal logs can contain specifics; user-facing responses must remain generic.
    request.log.error({ err: error }, 'request failed');

    // Claim flow is always a browser context. Any failure (bad content-type,
    // AppError, unexpected crash) must produce the friendly invalid-link page
    // rather than the JSON generic, including on POST /confirm.
    if (isIntegrationClaimRequest(request)) {
      const status = isAppError(error) ? error.statusCode : 404;
      reply.type('text/html; charset=utf-8').status(status).send(renderClaimInvalidHtml('missing'));
      return;
    }

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
        reply
          .type('text/html; charset=utf-8')
          .status(400)
          .send(renderGenericErrorHtml(genericErrorCode(request, error)));
        return;
      }
      reply.status(400).send(buildPublicErrorBody({ request, error, statusCode: 400 }));
      return;
    }

    if (isAppError(error)) {
      if (wantsHtml(request)) {
        const integrationHtml = maybeRenderIntegrationStatusPage(request, error);
        if (integrationHtml) {
          reply.type('text/html; charset=utf-8').status(error.statusCode).send(integrationHtml);
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
          .send(renderGenericErrorHtml(genericErrorCode(request, error)));
        return;
      }
      reply.status(error.statusCode).send(
        buildPublicErrorBody({
          request,
          error,
          statusCode: error.statusCode,
          exposeInvalidRefreshToken:
            request.authenticatedTokenGrantErrorProfile === 'workspace-switch',
        }),
      );
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
      reply
        .type('text/html; charset=utf-8')
        .status(500)
        .send(renderGenericErrorHtml(genericErrorCode(request, error)));
      return;
    }
    reply.status(500).send(buildPublicErrorBody({ request, error, statusCode: 500 }));
  });
}
