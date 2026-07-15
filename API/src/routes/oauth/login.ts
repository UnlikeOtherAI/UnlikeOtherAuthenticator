import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { isMcpOAuthEnabled } from '../../config/env.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
import { buildMcpClientConfig } from '../../services/oauth/config.service.js';
import { getOAuthClient } from '../../services/oauth/client.service.js';
import { validateRequestedResource } from '../../services/oauth/resource-validation.service.js';
import { finalizePublicOAuthAuthorizationWithSignatures } from '../../services/signature-continuation.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { resolveTwoFaPolicy } from '../../services/twofactor-policy.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';

// Public, secret-less email/password login for the MCP profile (brief §22.14).
// Mirrors /auth/login but is keyed on a registered public client_id instead of a
// config_url + domain-hash. On success it issues an authorization code and returns
// the redirect target (redirect_uri?code=&state=).
const BodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(1024),
    remember_me: z.boolean().optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    client_id: z.string().min(1).max(256),
    redirect_uri: z.string().min(1).max(2048),
    code_challenge: z.string().min(1).max(256),
    code_challenge_method: z.string().min(1).max(32),
    state: z.string().max(2048).optional(),
    scope: z.string().max(512).optional(),
    resource: z.string().max(2048).optional(),
  })
  .strip();

export function registerOAuthLoginRoute(app: FastifyInstance): void {
  const limiter = createRateLimiter({
    limit: 10,
    windowMs: 5 * 60 * 1000,
    keyBuilder: (request) => `oauth-login:ip:${request.ip || 'unknown'}`,
  });

  app.post('/oauth/login', { preHandler: [limiter] }, async (request, reply) => {
    if (!isMcpOAuthEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const { email, password, remember_me } = BodySchema.parse(request.body);
    const q = QuerySchema.parse(request.query);
    // RFC 8707: bind the requested resource to the allowlist before issuing the code.
    const resource = validateRequestedResource(q.resource);
    const pkce = parseRequiredPkceChallenge({
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
    });

    const client = await getOAuthClient(q.client_id);
    if (!client || !client.redirectUris.includes(q.redirect_uri)) {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }

    const config = buildMcpClientConfig(client.redirectUris);
    request.tenantContext = { domain: config.domain, orgId: null, userId: null };

    const outcome = await request.withTenantTx(async (tx) => {
      const prisma = asPrismaClient(tx);
      const { userId, twoFaEnabled } = await loginWithEmailPassword(
        { email, password, config },
        { prisma },
      );

      // Fail-closed: public /oauth 2FA completion is still a follow-up, so policy
      // branches block completion instead of issuing a code.
      const twoFaPolicy = await resolveTwoFaPolicy({ config, userId });
      if (twoFaPolicy !== 'OFF' && twoFaEnabled) {
        return { kind: 'twofa' as const };
      }
      if (twoFaPolicy === 'REQUIRED') {
        return { kind: 'twofa_enroll_required' as const };
      }

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: client.redirectUris,
        requestedRedirectUrl: q.redirect_uri,
      });
      const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;
      const gate = await finalizePublicOAuthAuthorizationWithSignatures(
        {
          userId,
          domain: config.domain,
          oauthClientId: client.clientId,
          redirectUrl,
          resource,
          state: q.state,
          scope: q.scope,
          codeChallenge: pkce.codeChallenge,
          rememberMe,
          authMethod: 'email_password',
          twoFaCompleted: false,
        },
      );
      return { kind: 'granted' as const, redirectTo: gate.redirectTo };
    });

    if (outcome.kind === 'twofa') {
      reply.status(200).send({ ok: true, twofa_required: true });
      return;
    }
    if (outcome.kind === 'twofa_enroll_required') {
      reply.status(200).send({ ok: true, kind: 'twofa_enroll_required', twofa_enroll_required: true });
      return;
    }
    reply.status(200).send({ ok: true, redirect_to: outcome.redirectTo });
  });
}
