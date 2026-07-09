import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { validateRegistrationEmailLandingToken } from '../../services/auth-registration-email-link.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import {
  renderAuthEntrypointHtml,
  sendAuthHtml,
  sendDeepLinkHandoff,
} from '../../services/auth-ui.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { isCustomSchemeUrl } from '../../utils/http-url.js';
import { verifyEmailToken } from '../../services/auth-verify-email.service.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { AppError, isAppError } from '../../utils/errors.js';
import { parsePkceChallenge, type PkceChallenge } from '../../utils/pkce.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

function redirectNoStore(reply: FastifyReply, url: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.redirect(url, 302);
}

function isEmailLinkTokenError(err: unknown): boolean {
  if (!isAppError(err)) return false;
  return [
    'INVALID_TOKEN',
    'INVALID_TOKEN_CONFIG_URL',
    'INVALID_TOKEN_TYPE',
    'TOKEN_ALREADY_USED',
    'TOKEN_EXPIRED',
  ].includes(err.message);
}

export function registerAuthEmailRegistrationLinkRoute(app: FastifyInstance): void {
  app.get(
    '/auth/email/link',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      let pkce: PkceChallenge | undefined;
      try {
        pkce = parsePkceChallenge({
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
        });
      } catch (err) {
        if (!isAppError(err) || err.message !== 'INVALID_PKCE_CHALLENGE') {
          throw err;
        }
        request.log.info({ err }, 'email link had an invalid PKCE challenge; rendering login');
        const html = await renderAuthEntrypointHtml({
          config: request.config,
          configUrl: request.configUrl,
          requestUrl: buildLoginAuthUrl(
            request.configUrl,
            redirect_url,
            parseRequestAccessFlag(request_access),
            undefined,
          ),
        });
        sendAuthHtml(reply, html);
        return;
      }

      let type: 'LOGIN_LINK' | 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL';
      try {
        type = await validateRegistrationEmailLandingToken(
          {
            token,
            config: request.config,
            configUrl: request.configUrl,
          },
          { prisma: request.adminDb },
        );
      } catch (err) {
        if (!isEmailLinkTokenError(err)) {
          throw err;
        }

        request.log.info({ err }, 'email link token could not be used; rendering login');
        const html = await renderAuthEntrypointHtml({
          config: request.config,
          configUrl: request.configUrl,
          requestUrl: buildLoginAuthUrl(
            request.configUrl,
            redirect_url,
            parseRequestAccessFlag(request_access),
            pkce,
          ),
        });
        sendAuthHtml(reply, html);
        return;
      }

      if (!pkce) {
        request.log.info('email link omitted PKCE challenge; rendering login restart');
        const html = await renderAuthEntrypointHtml({
          config: request.config,
          configUrl: request.configUrl,
          requestUrl: buildLoginAuthUrl(
            request.configUrl,
            redirect_url,
            parseRequestAccessFlag(request_access),
            undefined,
          ),
        });
        sendAuthHtml(reply, html);
        return;
      }

      // LOGIN_LINK and VERIFY_EMAIL: auto-consume the token and redirect immediately.
      // No password needed — the user is signed in by clicking the link.
      if (type === 'LOGIN_LINK' || type === 'VERIFY_EMAIL') {
        try {
          const { userId, teamInviteId } = await verifyEmailToken(
            {
              token,
              config: request.config,
              configUrl: request.configUrl,
            },
            { prisma: request.adminDb },
          );

          const redirectUrl = selectRedirectUrl({
            allowedRedirectUrls: request.config.redirect_urls,
            requestedRedirectUrl: redirect_url,
          });

          // Gap-fix B Task 1 (design §4.3 "Magic links join the same flow"): a consumed magic link
          // now joins the same post-verification workspace chooser gate as password/social/code
          // logins — UNLESS this link was invite-bound (teamInviteId set), in which case
          // verifyEmailToken already ran acceptTeamInviteWithinTransaction above: the accepted invite
          // IS the workspace selection, so the chooser must NOT be interposed on top of it.
          if (!teamInviteId && request.config.login_flow?.workspace_selection === 'auto') {
            const choices = await buildWorkspaceChoices(
              { userId, config: request.config },
              { prisma: request.adminDb },
            );
            if (choices.teams.length >= 2 || choices.pending_invites.length > 0) {
              const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
              const loginToken = await signLoginSession({
                userId,
                domain: request.config.domain,
                sharedSecret: SHARED_SECRET,
                audience: LOGIN_SESSION_AUDIENCE,
              });
              redirectNoStore(
                reply,
                buildWorkspaceChooserAuthUrl(
                  request.configUrl,
                  redirectUrl,
                  loginToken,
                  parseRequestAccessFlag(request_access),
                  pkce,
                ),
              );
              return;
            }
          }

          const finalResult = await finalizeAuthenticatedUser(
            {
              userId,
              config: request.config,
              configUrl: request.configUrl,
              redirectUrl,
              rememberMe: request.config.session?.remember_me_default ?? true,
              requestAccess: parseRequestAccessFlag(request_access),
              codeChallenge: pkce.codeChallenge,
              codeChallengeMethod: pkce.codeChallengeMethod,
            },
            { prisma: request.adminDb },
          );

          try {
            await recordLoginLog(
              {
                userId,
                domain: request.config.domain,
                authMethod: type === 'VERIFY_EMAIL' ? 'verify_email' : 'login_link',
                ip: request.ip ?? null,
                userAgent:
                  typeof request.headers['user-agent'] === 'string'
                    ? request.headers['user-agent']
                    : null,
              },
              { prisma: request.adminDb },
            );
          } catch (err) {
            request.log.error({ err }, 'failed to record login log');
          }

          const finalUrl = finalResult.redirectTo;
          if (finalUrl) {
            if (isCustomSchemeUrl(finalUrl)) {
              await sendDeepLinkHandoff(reply, {
                config: request.config,
                configUrl: request.configUrl,
                target: finalUrl,
              });
              return;
            }
            redirectNoStore(reply, finalUrl);
            return;
          }
        } catch (err) {
          request.log.error({ err }, 'email link auto-consume failed');
          throw err;
        }

        throw new AppError('INTERNAL', 500, 'AUTH_REDIRECT_MISSING');
      }

      // VERIFY_EMAIL_SET_PASSWORD: render the Auth UI with the set-password view.
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: buildAuthUrl(
          request.configUrl,
          redirect_url,
          token,
          type,
          parseRequestAccessFlag(request_access),
          pkce,
        ),
      });
      sendAuthHtml(reply, html);
    },
  );
}

function buildAuthUrl(
  configUrl: string,
  redirectUrl: string | undefined,
  token: string,
  type: string,
  requestAccess: boolean,
  pkce: PkceChallenge,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  params.set('code_challenge', pkce.codeChallenge);
  params.set('code_challenge_method', pkce.codeChallengeMethod);
  params.set('email_token', token);
  params.set('email_token_type', type);
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

// Gap-fix B Task 1 (design §4.3/§11.2): the same `/auth?...&login_token=...&flow=workspace_chooser`
// shape `callback.ts`'s social workspace-chooser branch redirects to, adapted to this route's own
// convention of always preserving the (already-verified) PKCE challenge across an `/auth` redirect —
// see `buildAuthUrl`/`buildLoginAuthUrl` above, which do the same for their own redirect targets.
function buildWorkspaceChooserAuthUrl(
  configUrl: string,
  redirectUrl: string,
  loginToken: string,
  requestAccess: boolean,
  pkce: PkceChallenge,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  params.set('redirect_url', redirectUrl);
  params.set('code_challenge', pkce.codeChallenge);
  params.set('code_challenge_method', pkce.codeChallengeMethod);
  params.set('login_token', loginToken);
  params.set('flow', 'workspace_chooser');
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

function buildLoginAuthUrl(
  configUrl: string,
  redirectUrl: string | undefined,
  requestAccess: boolean,
  pkce: PkceChallenge | undefined,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  if (pkce) {
    params.set('code_challenge', pkce.codeChallenge);
    params.set('code_challenge_method', pkce.codeChallengeMethod);
  }
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}
