import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  createDomainClientHash,
} from '../../services/domain-secret.service.js';
import {
  consumeClaim,
  peekClaim,
  type ClaimConsumeResult,
  type ClaimPeekResult,
} from '../../services/integration-claim.service.js';
import {
  renderClaimConfirmHtml,
  renderClaimInvalidHtml,
  renderClaimRevealHtml,
  type ClaimErrorKind,
} from '../../services/integration-claim-page.service.js';
import { getIntegrationRequestById } from '../../services/integration-request.service.js';

const TokenParamsSchema = z.object({ token: z.string().trim().min(1).max(512) });

const TOKEN_PATH = '/integrations/claim/:token';
const CONFIRM_PATH = '/integrations/claim/:token/confirm';

function sendHtml(reply: FastifyReply, status: number, html: string): void {
  reply.status(status);
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  reply.send(html);
}

function invalid(reply: FastifyReply, kind: ClaimErrorKind): void {
  sendHtml(reply, 404, renderClaimInvalidHtml(kind));
}

function readToken(params: unknown): string | null {
  const parsed = TokenParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  return parsed.data.token;
}

export function registerIntegrationClaimRoutes(app: FastifyInstance): void {
  /**
   * Pre-consume confirm page. Designed so that link scanners / email previewers
   * (which only issue GETs) cannot accidentally burn the one-time token.
   */
  app.get(TOKEN_PATH, async (request, reply) => {
    const token = readToken(request.params);
    if (!token) return invalid(reply, 'missing');

    const peek: ClaimPeekResult = await peekClaim(token);
    if (peek.state !== 'valid') return invalid(reply, peek.state);

    const confirmUrl = `/integrations/claim/${encodeURIComponent(token)}/confirm`;
    sendHtml(reply, 200, renderClaimConfirmHtml({ confirmUrl }));
  });

  /**
   * Consume the token: decrypt the stored secret, mark the row used, and render
   * the reveal page. This is the single moment the raw `client_secret` is shown.
   */
  app.post(CONFIRM_PATH, async (request, reply) => {
    const token = readToken(request.params);
    if (!token) return invalid(reply, 'missing');

    const result: ClaimConsumeResult = await consumeClaim(token);
    if (result.state !== 'consumed') return invalid(reply, result.state);

    const integration = await getIntegrationRequestById(result.integrationId);
    if (!integration) return invalid(reply, 'missing');

    const domain = integration.domain;
    const clientSecret = result.clientSecret;
    const clientHash = createDomainClientHash(domain, clientSecret);
    const hashPrefix = clientHash.slice(0, 12);

    sendHtml(
      reply,
      200,
      renderClaimRevealHtml({
        domain,
        clientHash,
        clientSecret,
        hashPrefix,
        llmUrl: '/llm',
      }),
    );
  });
}
