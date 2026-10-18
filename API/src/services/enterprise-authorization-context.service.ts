import { z } from 'zod';
import { requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { normalizeDomain } from '../utils/domain.js';
import { readConfigJwtFromTrustedSource } from './config-jwt-source.service.js';
import { validateConfigFields, verifyConfigJwtSignatureWithKeyDomain, assertConfigDomainMatchesConfigUrl,
  type ClientConfig } from './config.service.js';
import { applyDomainRedirectAllowlist } from './domain-redirect-allowlist.service.js';
import { containsSecretValue } from './config-secret-scan.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import { parseRequiredPkceChallenge } from '../utils/pkce.js';

export const EnterpriseAuthorization = z.object({ config_url: z.string().url().max(2048),
  config_fingerprint: z.string().length(64), client_domain: z.string().min(1), redirect_url: z.string().url().max(2048),
  state: z.string().min(1).max(2048), code_challenge: z.string().length(43), code_challenge_method: z.literal('S256'),
  team_hint: z.string().min(1).max(256).optional(), policy_generation: z.number().int().positive() }).strict();
export type EnterpriseAuthorizationContext = z.infer<typeof EnterpriseAuthorization>;

export function enterpriseAuthorizationContext(config: ClientConfig, configUrl: string, raw: unknown, generation: number) {
  const query = z.object({ redirect_url: z.string().url().optional(), state: z.string().min(1).max(2048),
    code_challenge: z.string().length(43), code_challenge_method: z.literal('S256'),
    team_hint: z.string().min(1).max(256).optional() }).passthrough().parse(raw);
  const pkce = parseRequiredPkceChallenge({ codeChallenge: query.code_challenge, codeChallengeMethod: query.code_challenge_method });
  return EnterpriseAuthorization.parse({ config_url: configUrl, config_fingerprint: fingerprintClientConfig(config),
    client_domain: config.domain, redirect_url: selectRedirectUrl({ allowedRedirectUrls: config.redirect_urls,
      requestedRedirectUrl: query.redirect_url }), state: query.state, code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod, team_hint: query.team_hint, policy_generation: generation });
}

/** Callback re-reads signature, registered key/domain, redirect policy and config semantics. */
export async function reloadEnterpriseAuthorization(context: EnterpriseAuthorizationContext): Promise<ClientConfig> {
  const token = await readConfigJwtFromTrustedSource(context.config_url);
  const { payload, keyDomain } = await verifyConfigJwtSignatureWithKeyDomain(token, requireEnv('CONFIG_JWKS_URL').CONFIG_JWKS_URL);
  if (containsSecretValue(payload, requireEnv('SHARED_SECRET').SHARED_SECRET)) throw new AppError('BAD_REQUEST', 400, 'CONFIG_PAYLOAD_SECRET_REJECTED');
  const parsed = validateConfigFields(payload);
  assertConfigDomainMatchesConfigUrl(parsed.domain, context.config_url);
  if (parsed.domain !== context.client_domain || (keyDomain && normalizeDomain(keyDomain) !== normalizeDomain(parsed.domain))) {
    throw new AppError('UNAUTHORIZED', 401, 'CONFIG_KEY_DOMAIN_MISMATCH');
  }
  const config = await applyDomainRedirectAllowlist(parsed);
  if (fingerprintClientConfig(config) !== context.config_fingerprint) throw new AppError('BAD_REQUEST', 409, 'SSO_CONFIG_CHANGED');
  selectRedirectUrl({ allowedRedirectUrls: config.redirect_urls, requestedRedirectUrl: context.redirect_url });
  return config;
}
