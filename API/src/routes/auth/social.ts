import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, getEnv, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { generateXCodeVerifier } from '../../services/social/x.service.js';
import { buildSocialAuthorizationUrl } from '../../services/social/provider-authorization.service.js';
import { assertSocialProviderAllowed } from '../../services/social/index.js';
import { signSocialState } from '../../services/social/social-state.service.js';
import {
  generateSocialStateNonce,
  setSocialInviteCookie,
  setSocialStateCookie,
  setXSocialContextCookie,
} from '../../services/social/social-state-cookie.js';
import { getTeamInviteLandingData } from '../../services/team-invite.service.js';
import { recordAuthFunnelStep } from '../../services/auth-funnel.service.js';
import type { SocialProviderKey } from '../../services/social/provider.base.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { AppError } from '../../utils/errors.js';
import { parsePkceChallenge } from '../../utils/pkce.js';
import { configFetchRateLimiter } from './rate-limit-keys.js';
import { TEAM_HINT_PATTERN } from '../../services/social/social-browser-preference.service.js';

const ParamsSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github', 'linkedin', 'x']),
});

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    management_org_id: z.string().min(1).max(100).optional(),
    redirect_url: z.string().min(1).max(2048).optional(),
    redirect_uri: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
    invite_token: z.string().min(1).max(4096).optional(),
    // Opaque relying-party CSRF value. UOA does not interpret it; it is bound to
    // this login and echoed verbatim on the final redirect.
    state: z.string().min(1).max(2048).optional(),
    // The relying party's `/auth?prompt=select_account`, forwarded by the Auth UI: the
    // person is adding another account, so the provider must show its account chooser
    // instead of silently reusing the browser's provider session. Only this one value
    // exists; it selects a provider screen and grants nothing. Honoured by Google.
    prompt: z.literal('select_account').optional(),
    team_hint: z.string().regex(TEAM_HINT_PATTERN).optional(),
  })
  .strict();

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function resolvePublicBaseUrl(): string {
  const env = getEnv();
  return env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;
}

function redirectNoStore(reply: FastifyReply, url: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.redirect(url, 302);
}

export function registerAuthSocialRoute(app: FastifyInstance): void {
  app.get(
    '/auth/social/:provider',
    {
      preHandler: [configFetchRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { provider } = ParamsSchema.parse(request.params);
      const {
        redirect_url,
        redirect_uri,
        management_org_id,
        code_challenge,
        code_challenge_method,
        request_access,
        invite_token,
        state: relyingPartyState,
        prompt,
        team_hint,
      } = QuerySchema.parse(request.query);

      const config = request.config;
      if (!config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      assertSocialProviderAllowed({ config, provider });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url ?? redirect_uri,
      });
      const pkce = parsePkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });
      const invite = invite_token
        ? await getTeamInviteLandingData(
            { token: invite_token, configUrl: request.configUrl, config },
            { prisma: request.adminDb },
          )
        : null;
      if (!pkce && !invite) {
        throw new AppError('BAD_REQUEST', 400, 'INVALID_PKCE_CHALLENGE');
      }
      await recordAuthFunnelStep(
        { domain: config.domain, step: 'social_started', outcome: provider },
        { prisma: request.adminDb },
      );

      const env = getEnv();

      // Bind the OAuth `state` to this browser: a CSPRNG nonce is embedded in the
      // signed state JWT and mirrored in an HttpOnly cookie. The callback rejects
      // unless both match, preventing login-CSRF / forced-login attacks. Generated
      // once and reused across provider branches; the cookie is set on `reply` here
      // and verified in the callback route.
      const nonce = generateSocialStateNonce();
      const baseUrl = resolvePublicBaseUrl();
      const authServiceIdentifier = getAuthServiceIdentifier(env);
      const requestConfigUrl = request.configUrl;

      const signStateForProvider = async (providerKey: SocialProviderKey): Promise<string> => {
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
        const state = await signSocialState({
          managementOrgId: management_org_id,
          provider: providerKey,
          configUrl: requestConfigUrl,
          redirectUrl,
          requestAccess: parseRequestAccessFlag(request_access),
          state: relyingPartyState,
          codeChallenge: pkce?.codeChallenge,
          codeChallengeMethod: pkce?.codeChallengeMethod,
          teamInvite: Boolean(invite),
          nonce,
          teamHint: team_hint,
          sharedSecret: SHARED_SECRET,
          audience: authServiceIdentifier,
          baseUrlForIssuer: baseUrl,
        });
        setSocialStateCookie(reply, nonce, providerKey);
        if (invite_token) {
          setSocialInviteCookie(reply, invite_token, providerKey);
        }
        return state;
      };

      const stateJwt = await signStateForProvider(provider);
      const codeVerifier = provider === 'x' ? generateXCodeVerifier() : undefined;
      if (codeVerifier) setXSocialContextCookie(reply, { state: nonce, stateJwt, codeVerifier });
      redirectNoStore(reply, buildSocialAuthorizationUrl({ provider, baseUrl,
        state: provider === 'x' ? nonce : stateJwt, codeVerifier, selectAccount: prompt === 'select_account' }));
    },
  );
}
