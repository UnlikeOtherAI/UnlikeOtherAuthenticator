import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientConfig } from '../config.service.js';
import type { SocialProviderKey } from './provider.base.js';

export const SOCIAL_PREFERENCE_COOKIE = 'uoa_social_preference';
export const TEAM_HINT_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const providers: readonly SocialProviderKey[] = ['google', 'apple', 'facebook', 'github', 'linkedin', 'x'];
const cookieOptions = { path: '/auth', httpOnly: true, secure: true, sameSite: 'lax' as const, signed: true };
const launchParameters = new Set([
  'config_url', 'redirect_url', 'redirect_uri', 'code_challenge', 'code_challenge_method',
  'state', 'team_hint',
]);

/** A provider name is a convenience preference, never proof of a person or a session. */
export function rememberCompletedSocialProvider(reply: FastifyReply, method: string | undefined): void {
  if (!method || !providers.includes(method as SocialProviderKey)) return;
  reply.setCookie(SOCIAL_PREFERENCE_COOKIE, method, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 });
}

/** Only a new, exact-team browser request may skip the provider-choice screen. */
export function preferredSocialRedirect(input: {
  config: ClientConfig; configUrl: string; requestUrl: string; request: FastifyRequest;
}): string | null {
  if (input.request.method !== 'GET') return null;
  const query = new URL(input.requestUrl, 'https://uoa.invalid').searchParams;
  // An allowlist also excludes add-account prompts, native clients, enterprise,
  // invitations, management, failures and every mid-authentication continuation.
  if ([...query.keys()].some(key => !launchParameters.has(key) || query.getAll(key).length !== 1)) return null;
  const hint = query.get('team_hint');
  if (!hint || !TEAM_HINT_PATTERN.test(hint)
    || !/^[A-Za-z0-9_-]{43}$/.test(query.get('code_challenge') ?? '')
    || query.get('code_challenge_method') !== 'S256') return null;
  const raw = input.request.cookies?.[SOCIAL_PREFERENCE_COOKIE];
  if (!raw) return null;
  const cookie = input.request.unsignCookie(raw);
  const provider = cookie.valid ? cookie.value as SocialProviderKey : null;
  if (!provider || !providers.includes(provider) || !input.config.enabled_auth_methods.includes(provider)) return null;
  query.set('config_url', input.configUrl);
  return `/auth/social/${provider}?${query}`;
}

/** One automatic attempt; a cancelled or failed provider flow must return to choices. */
export function consumeSocialPreference(reply: FastifyReply): void {
  reply.clearCookie(SOCIAL_PREFERENCE_COOKIE, cookieOptions);
}
