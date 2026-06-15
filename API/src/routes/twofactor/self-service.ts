import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { parseBearerOrRawToken } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { finalizeAuthenticatedUser } from '../../services/access-request-flow.service.js';
import { verifyAccessToken, type AccessTokenClaims } from '../../services/access-token.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { revokeAllRefreshTokensForUser } from '../../services/refresh-token.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { disableTwoFactorForUser } from '../../services/twofactor-disable.service.js';
import { enrollTwoFactorForUser } from '../../services/twofactor-enroll.service.js';
import { resolveTwoFaPolicy } from '../../services/twofactor-policy.service.js';
import {
  renderTwoFactorSetupFromTokenSecret,
  startTwoFactorSetup,
} from '../../services/twofactor-setup.service.js';
import { verifyTwoFaSetupToken } from '../../services/twofactor-setup-token.service.js';
import { decryptTwoFaSecret } from '../../utils/twofa-secret.js';
import { AppError } from '../../utils/errors.js';
import {
  twoFactorDisableRateLimiter,
  twoFactorEnrollRateLimiter,
  twoFactorSetupRateLimiter,
} from '../auth/rate-limit-keys.js';

const SetupBodySchema = z
  .object({
    setup_token: z.string().min(1).max(8192).optional(),
  })
  .strict();

const EnrollBodySchema = z
  .object({
    setup_token: z.string().min(1).max(8192),
    code: z.string().min(1).max(64),
  })
  .strict();

const DisableBodySchema = z
  .object({
    code: z.string().min(1).max(64),
  })
  .strict();

function getAccessToken(request: FastifyRequest): string | null {
  return parseBearerOrRawToken(request.headers['x-uoa-access-token']);
}

async function requireAccessTokenClaims(request: FastifyRequest): Promise<AccessTokenClaims> {
  const token = getAccessToken(request);
  if (!token) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');

  const claims = await verifyAccessToken(token, { prisma: request.adminDb });
  if (claims.domain !== request.config?.domain) {
    throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
  }
  request.accessTokenClaims = claims;
  return claims;
}

async function assertPolicyAllowsSetup(params: {
  request: FastifyRequest;
  userId: string;
}): Promise<void> {
  const config = params.request.config;
  if (!config) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
  const policy = await resolveTwoFaPolicy({ config, userId: params.userId });
  if (policy === 'OFF') {
    throw new AppError('NOT_FOUND', 404, 'TWOFA_NOT_AVAILABLE');
  }
}

export function registerTwoFactorSelfServiceRoutes(app: FastifyInstance): void {
  app.post(
    '/2fa/setup',
    { preHandler: [twoFactorSetupRateLimiter, configVerifier] },
    async (request, reply) => {
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      const body = SetupBodySchema.parse(request.body ?? {});
      if (body.setup_token) {
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
        const setup = await verifyTwoFaSetupToken({
          token: body.setup_token,
          sharedSecret: SHARED_SECRET,
          audience: getAuthServiceIdentifier(),
        });
        if (setup.configUrl !== configUrl || setup.domain !== config.domain) {
          throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
        }
        await assertPolicyAllowsSetup({ request, userId: setup.userId });
        const totpSecret = decryptTwoFaSecret({
          encryptedSecret: setup.encryptedSecret,
          sharedSecret: SHARED_SECRET,
        });
        const rendered = await renderTwoFactorSetupFromTokenSecret(
          { userId: setup.userId, totpSecret, setupToken: body.setup_token, config },
          { prisma: request.adminDb },
        );
        reply.status(200).send(rendered);
        return;
      }

      const claims = await requireAccessTokenClaims(request);
      await assertPolicyAllowsSetup({ request, userId: claims.userId });

      const setup = await startTwoFactorSetup(
        { userId: claims.userId, config, configUrl },
        { prisma: request.adminDb },
      );
      reply.status(200).send(setup);
    },
  );

  app.post(
    '/2fa/enroll',
    { preHandler: [twoFactorEnrollRateLimiter, configVerifier] },
    async (request, reply) => {
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      const { setup_token, code } = EnrollBodySchema.parse(request.body);
      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      const setup = await verifyTwoFaSetupToken({
        token: setup_token,
        sharedSecret: SHARED_SECRET,
        audience: getAuthServiceIdentifier(),
      });

      if (setup.configUrl !== configUrl || setup.domain !== config.domain) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }

      const accessToken = getAccessToken(request);
      if (accessToken) {
        const claims = await verifyAccessToken(accessToken, { prisma: request.adminDb });
        if (claims.userId !== setup.userId || claims.domain !== config.domain) {
          throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
        }
        request.accessTokenClaims = claims;
      }

      await assertPolicyAllowsSetup({ request, userId: setup.userId });
      const totpSecret = decryptTwoFaSecret({
        encryptedSecret: setup.encryptedSecret,
        sharedSecret: SHARED_SECRET,
      });

      setTenantContextFromRequest(request, { orgId: null, userId: setup.userId });
      const finalResult = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);
        await enrollTwoFactorForUser({ userId: setup.userId, totpSecret, code }, { prisma });

        if (!setup.redirectUrl) {
          return null;
        }

        const redirectUrl = selectRedirectUrl({
          allowedRedirectUrls: config.redirect_urls,
          requestedRedirectUrl: setup.redirectUrl,
        });
        const result = await finalizeAuthenticatedUser(
          {
            userId: setup.userId,
            config,
            configUrl,
            redirectUrl,
            rememberMe: setup.rememberMe,
            requestAccess: setup.requestAccess,
            codeChallenge: setup.codeChallenge,
            codeChallengeMethod: setup.codeChallengeMethod,
            ip: request.ip ?? null,
          },
          { prisma },
        );

        try {
          await recordLoginLog(
            {
              userId: setup.userId,
              domain: config.domain,
              authMethod: setup.authMethod ?? 'email_password',
              ip: request.ip ?? null,
              userAgent:
                typeof request.headers['user-agent'] === 'string'
                  ? request.headers['user-agent']
                  : null,
            },
            { prisma },
          );
        } catch (err) {
          request.log.error({ err }, 'failed to record login log');
        }

        return result;
      });

      reply.status(200).send({
        ok: true,
        code: finalResult?.status === 'granted' ? finalResult.code : undefined,
        redirect_to: finalResult?.redirectTo,
        access_request_status: finalResult?.status === 'requested' ? 'pending' : undefined,
      });
    },
  );

  app.post(
    '/2fa/disable',
    { preHandler: [twoFactorDisableRateLimiter, configVerifier] },
    async (request, reply) => {
      const config = request.config;
      if (!config) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      const { code } = DisableBodySchema.parse(request.body);
      const claims = await requireAccessTokenClaims(request);
      const policy = await resolveTwoFaPolicy({ config, userId: claims.userId });
      if (policy === 'OFF') throw new AppError('NOT_FOUND', 404, 'TWOFA_NOT_AVAILABLE');
      if (policy === 'REQUIRED') throw new AppError('BAD_REQUEST', 400, 'TWOFA_REQUIRED');

      setTenantContextFromRequest(request, { orgId: null, userId: claims.userId });
      await request.withTenantTx(async (tx) => {
        await disableTwoFactorForUser(
          { userId: claims.userId, code },
          {
            prisma: asPrismaClient(tx),
            revokeAllRefreshTokensForUser,
          },
        );
      });

      reply.status(200).send({ ok: true });
    },
  );
}
