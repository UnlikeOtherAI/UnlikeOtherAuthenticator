import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { runWithRequestAdminTransaction } from '../../plugins/tenant-context.plugin.js';
import { parseBearerOrRawToken } from '../../middleware/org-role-guard.js';
import { finalizeAuthenticatedUser } from '../../services/access-request-flow.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { verifyAccessToken, type AccessTokenClaims } from '../../services/access-token.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { lockProductWorkspacePolicyShared } from '../../services/product-workspace-policy-lock.service.js';
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
  orgId?: string;
  prisma?: PrismaClient;
}): Promise<void> {
  const config = params.request.config;
  if (!config) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
  const policy = await resolveTwoFaPolicy(
    { config, userId: params.userId, orgId: params.orgId },
    params.prisma ? { prisma: params.prisma } : undefined,
  );
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
        const setupToken = body.setup_token;
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
        const setup = await verifyTwoFaSetupToken({
          token: setupToken,
          sharedSecret: SHARED_SECRET,
          audience: getAuthServiceIdentifier(),
        });
        if (setup.configUrl !== configUrl || setup.domain !== config.domain) {
          throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
        }
        const rendered = await runInTransaction(request.adminDb, async (tx) => {
          await lockProductWorkspacePolicyShared(tx);
          await lockAndAssertAuthenticationEpoch(
            {
              userId: setup.userId,
              domain: setup.domain,
              credentialEpoch: setup.credentialEpoch,
            },
            { prisma: tx },
          );
          const lockedSetup = await verifyTwoFaSetupToken({
            token: setupToken,
            sharedSecret: SHARED_SECRET,
            audience: getAuthServiceIdentifier(),
            now: new Date(),
          });
          if (lockedSetup.configUrl !== configUrl || lockedSetup.domain !== config.domain) {
            throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
          }
          const totpSecret = decryptTwoFaSecret({
            encryptedSecret: lockedSetup.encryptedSecret,
            sharedSecret: SHARED_SECRET,
          });
          await assertPolicyAllowsSetup({
            request,
            userId: lockedSetup.userId,
            orgId: lockedSetup.orgId,
            prisma: tx,
          });
          return renderTwoFactorSetupFromTokenSecret(
            { userId: lockedSetup.userId, totpSecret, setupToken, config },
            { prisma: tx },
          );
        });
        reply.status(200).send(rendered);
        return;
      }

      const claims = await requireAccessTokenClaims(request);
      const setup = await runInTransaction(request.adminDb, async (tx) => {
        await lockProductWorkspacePolicyShared(tx);
        await lockAndAssertAuthenticationEpoch(
          {
            userId: claims.userId,
            domain: claims.domain,
            credentialEpoch: claims.tokenVersion,
          },
          { prisma: tx },
        );
        await assertPolicyAllowsSetup({
          request,
          userId: claims.userId,
          orgId: claims.active?.orgId,
          prisma: tx,
        });
        return startTwoFactorSetup(
          {
            userId: claims.userId,
            credentialEpoch: claims.tokenVersion,
            config,
            configUrl,
          },
          { prisma: tx },
        );
      });
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

      const finalResult = await runWithRequestAdminTransaction(request, async (prisma) => {
        await lockProductWorkspacePolicyShared(prisma);
        await lockAndAssertAuthenticationEpoch(
          {
            userId: setup.userId,
            domain: setup.domain,
            credentialEpoch: setup.credentialEpoch,
          },
          { prisma },
        );
        const lockedSetup = await verifyTwoFaSetupToken({
          token: setup_token,
          sharedSecret: SHARED_SECRET,
          audience: getAuthServiceIdentifier(),
          now: new Date(),
        });
        if (lockedSetup.configUrl !== configUrl || lockedSetup.domain !== config.domain) {
          throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
        }
        const totpSecret = decryptTwoFaSecret({
          encryptedSecret: lockedSetup.encryptedSecret,
          sharedSecret: SHARED_SECRET,
        });
        await assertPolicyAllowsSetup({
          request,
          userId: lockedSetup.userId,
          orgId: lockedSetup.orgId,
          prisma,
        });
        await enrollTwoFactorForUser({ userId: lockedSetup.userId, totpSecret, code }, { prisma });

        if (!lockedSetup.redirectUrl) {
          return null;
        }

        const redirectUrl = selectRedirectUrl({
          allowedRedirectUrls: config.redirect_urls,
          requestedRedirectUrl: lockedSetup.redirectUrl,
        });
        const result = await finalizeAuthenticatedUser(
          {
            userId: lockedSetup.userId,
            credentialEpoch: lockedSetup.credentialEpoch,
            config,
            configUrl,
            redirectUrl,
            rememberMe: lockedSetup.rememberMe,
            requestAccess: lockedSetup.requestAccess,
            authMethod: lockedSetup.authMethod ?? 'email_password',
            twoFaCompleted: true,
            codeChallenge: lockedSetup.codeChallenge,
            codeChallengeMethod: lockedSetup.codeChallengeMethod,
            ip: request.ip ?? null,
            orgId: lockedSetup.orgId,
            teamId: lockedSetup.teamId,
          },
          { workspacePrisma: prisma, prisma },
        );

        try {
          await recordLoginLog(
            {
              userId: lockedSetup.userId,
              domain: config.domain,
              authMethod: lockedSetup.authMethod ?? 'email_password',
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
      await disableTwoFactorForUser(
        {
          userId: claims.userId,
          code,
          credentialEpoch: claims.tokenVersion,
          config,
          orgId: claims.active?.orgId,
        },
        { prisma: request.adminDb },
      );

      reply.status(200).send({ ok: true });
    },
  );
}
