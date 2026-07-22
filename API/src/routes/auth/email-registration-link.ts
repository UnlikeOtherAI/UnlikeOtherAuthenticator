import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { runWithRequestAdminTransaction } from '../../plugins/tenant-context.plugin.js';
import { validateRegistrationEmailLandingToken } from '../../services/auth-registration-email-link.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import {
  renderAuthEntrypointHtml,
  sendAuthHtml,
  sendDeepLinkHandoff,
} from '../../services/auth-ui.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { isCustomSchemeUrl } from '../../utils/http-url.js';
import { verifyEmailToken } from '../../services/auth-verify-email.service.js';
import {
  buildWorkspaceChoices,
  resolveAutoSelectedWorkspace,
  shouldPresentWorkspaceChooser,
  type AutoSelectedWorkspace,
} from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { AppError, isAppError } from '../../utils/errors.js';
import { parsePkceChallenge, type PkceChallenge } from '../../utils/pkce.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { lockProductWorkspacePolicyShared } from '../../services/product-workspace-policy-lock.service.js';
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

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
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
          config,
          configUrl,
          requestUrl: buildLoginAuthUrl(
            configUrl,
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
            config,
            configUrl,
          },
          { prisma: request.adminDb },
        );
      } catch (err) {
        if (!isEmailLinkTokenError(err)) {
          throw err;
        }

        request.log.info({ err }, 'email link token could not be used; rendering login');
        const html = await renderAuthEntrypointHtml({
          config,
          configUrl,
          requestUrl: buildLoginAuthUrl(
            configUrl,
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
          config,
          configUrl,
          requestUrl: buildLoginAuthUrl(
            configUrl,
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
          const { userId, credentialEpoch, twoFaEnabled, acceptedInvite } = await verifyEmailToken(
            {
              token,
              config,
              configUrl,
            },
            { prisma: request.adminDb },
          );

          const redirectUrl = selectRedirectUrl({
            allowedRedirectUrls: config.redirect_urls,
            requestedRedirectUrl: redirect_url,
          });
          const rememberMe = config.session?.remember_me_default ?? true;
          const requestAccess = parseRequestAccessFlag(request_access);

          // An accepted invite is already an explicit workspace choice. Non-invite auto flows select
          // one team only when unambiguous; a create-workspace action still requires the chooser.
          let selectedWorkspace: AutoSelectedWorkspace | null = acceptedInvite
            ? { orgId: acceptedInvite.orgId, teamId: acceptedInvite.teamId }
            : null;
          if (!acceptedInvite && config.login_flow?.workspace_selection === 'auto') {
            const chooser = await runWithRequestAdminTransaction(request, async (prisma) => {
              await lockProductWorkspacePolicyShared(prisma);
              await lockAndAssertAuthenticationEpoch(
                { userId, domain: config.domain, credentialEpoch },
                { prisma, fallbackTwoFaEnabled: twoFaEnabled },
              );
              const choices = await buildWorkspaceChoices({ userId, config }, { prisma });
              const selected = resolveAutoSelectedWorkspace(choices);
              if (!shouldPresentWorkspaceChooser(choices, selected)) {
                return { selected, loginToken: null };
              }
              const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
              const loginToken = await signLoginSession({
                userId,
                credentialEpoch,
                config,
                configUrl,
                redirectUrl,
                rememberMe,
                requestAccess,
                codeChallenge: pkce.codeChallenge,
                codeChallengeMethod: pkce.codeChallengeMethod,
                sharedSecret: SHARED_SECRET,
                audience: LOGIN_SESSION_AUDIENCE,
              });
              return { selected, loginToken };
            });
            selectedWorkspace = chooser.selected;
            if (chooser.loginToken) {
              redirectNoStore(
                reply,
                buildWorkspaceChooserAuthUrl(
                  configUrl,
                  redirectUrl,
                  chooser.loginToken,
                  requestAccess,
                  pkce,
                ),
              );
              return;
            }
          }

          const authMethod = type === 'VERIFY_EMAIL' ? 'verify_email' : 'login_link';
          const outcome = await finalizeWithTwoFaPolicy(
            {
              userId,
              credentialEpoch,
              twoFaEnabled,
              config,
              configUrl,
              redirectUrl,
              rememberMe,
              requestAccess,
              authMethod,
              codeChallenge: pkce.codeChallenge,
              codeChallengeMethod: pkce.codeChallengeMethod,
              ip: request.ip ?? null,
              ...(selectedWorkspace ?? {}),
            },
            { prisma: request.adminDb },
          );

          if (outcome.kind === 'twofa') {
            redirectNoStore(
              reply,
              buildTwoFaAuthUrl(configUrl, redirectUrl, {
                requestAccess,
                kind: 'challenge',
                token: outcome.twofa_token,
              }),
            );
            return;
          }

          if (outcome.kind === 'twofa_enroll_required') {
            redirectNoStore(
              reply,
              buildTwoFaAuthUrl(configUrl, redirectUrl, {
                requestAccess,
                kind: 'enrollment',
                token: outcome.setup.setup_token,
              }),
            );
            return;
          }

          try {
            await recordLoginLog(
              {
                userId,
                domain: config.domain,
                authMethod,
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

          const finalUrl = outcome.finalResult.redirectTo;
          if (finalUrl) {
            if (isCustomSchemeUrl(finalUrl)) {
              await sendDeepLinkHandoff(reply, {
                config,
                configUrl,
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
        config,
        configUrl,
        requestUrl: buildAuthUrl(
          configUrl,
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

function buildTwoFaAuthUrl(
  configUrl: string,
  redirectUrl: string,
  continuation:
    | { requestAccess: boolean; kind: 'challenge'; token: string }
    | { requestAccess: boolean; kind: 'enrollment'; token: string },
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  params.set('redirect_url', redirectUrl);
  if (continuation.kind === 'challenge') {
    params.set('twofa_token', continuation.token);
  } else {
    params.set('twofa_enroll_required', 'true');
    params.set('twofa_setup_token', continuation.token);
  }
  if (continuation.requestAccess) params.set('request_access', 'true');
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
