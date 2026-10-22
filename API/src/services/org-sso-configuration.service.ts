import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { enterpriseFetch } from './enterprise-http.service.js';
import { validateEnterpriseSigningCertificate } from './enterprise-signing-certificate.service.js';

export const enterprisePresets = [
  { id: 'entra', protocols: ['oidc'] }, { id: 'okta', protocols: ['oidc', 'saml'] },
  { id: 'google_workspace', protocols: ['oidc', 'saml'] }, { id: 'keycloak', protocols: ['oidc', 'saml'] },
  { id: 'adfs', protocols: ['saml'] }, { id: 'other_oidc', protocols: ['oidc'] },
  { id: 'other_saml', protocols: ['saml'] },
] as const;
const https = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
});
export const OidcEnterpriseConfiguration = z.object({
  issuer: https, client_id: z.string().min(1).max(256), authorization_endpoint: https,
  token_endpoint: https, jwks_uri: https,
  trusted_origins: z.array(https).min(1).max(10),
  tenant: z.object({ claim: z.string().min(1).max(100), value: z.string().min(1).max(256) }).strict(),
  hosted_domains: z.array(z.string().min(1).max(253)).max(20).optional(),
  subject_claim: z.enum(['sub', 'oid']).default('sub'),
  groups_claim: z.string().min(1).max(256).optional(),
  authorization_response_iss_required: z.boolean().default(false),
  client_auth_method: z.enum(['client_secret_post', 'client_secret_basic']).default('client_secret_post'),
  max_age: z.number().int().nonnegative().max(86400).optional(),
}).strict();
export const SamlEnterpriseConfiguration = z.object({
  force_authn: z.boolean().optional(),
  entity_id: z.string().min(1).max(1000), sso_url: https,
  certificates: z.array(z.string().min(100).max(20000)).min(1).max(3),
  subject_attribute: z.string().min(1).max(256).optional(),
  email_attribute: z.string().min(1).max(256).optional(),
  groups_attribute: z.string().min(1).max(256).optional(),
  tenant: z.object({ attribute: z.string().min(1).max(256), value: z.string().min(1).max(256) }).strict(),
  trusted_origins: z.array(https).min(1).max(10), authn_context: z.string().min(1).max(1000).optional(),
}).strict();

export function validateEnterpriseConfiguration(preset: string, protocol: string, raw: unknown) {
  const definition = enterprisePresets.find((item) => item.id === preset);
  if (!definition || !(definition.protocols as readonly string[]).includes(protocol)) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_PRESET_INVALID');
  }
  if (protocol === 'saml') {
    const config = SamlEnterpriseConfiguration.parse(raw);
    config.certificates.forEach(validateEnterpriseSigningCertificate);
    return config;
  }
  const config = OidcEnterpriseConfiguration.parse(raw);
  const trusted = new Set(preset === 'google_workspace' ? ['https://accounts.google.com', 'https://oauth2.googleapis.com',
    'https://www.googleapis.com'] : [new URL(config.issuer).origin]);
  if ([config.issuer, config.authorization_endpoint, config.token_endpoint, config.jwks_uri]
    .some((value) => !trusted.has(new URL(value).origin))) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_ENDPOINT_NOT_TRUSTED');
  }
  if (preset === 'entra') {
    const tenant = config.tenant.value;
    if (config.tenant.claim !== 'tid' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenant) ||
      config.issuer !== `https://login.microsoftonline.com/${tenant}/v2.0` || config.subject_claim !== 'oid') {
      throw new AppError('BAD_REQUEST', 400, 'SSO_TENANT_PIN_REQUIRED');
    }
  }
  if (preset === 'google_workspace' && (config.issuer !== 'https://accounts.google.com' ||
    config.tenant.claim !== 'hd' || !config.hosted_domains?.includes(config.tenant.value))) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_TENANT_PIN_REQUIRED');
  }
  return { ...config, trusted_origins: [...trusted] };
}

/** Discovery can describe endpoints, but cannot authorize where a secret will be sent. */
export async function resolveEnterpriseConfiguration(preset: string, protocol: string, raw: Record<string, unknown>) {
  if (protocol === 'saml') return validateEnterpriseConfiguration(preset, protocol, { ...raw,
    trusted_origins: [new URL(https.parse(raw.sso_url)).origin] });
  const issuer = https.parse(raw.issuer);
  const origins = preset === 'google_workspace' ? ['https://accounts.google.com', 'https://oauth2.googleapis.com',
    'https://www.googleapis.com'] : [new URL(issuer).origin];
  let endpoints: Record<string, unknown> = {};
  if (!raw.authorization_endpoint || !raw.token_endpoint || !raw.jwks_uri) {
    const discovery = z.object({ issuer: z.literal(issuer), authorization_endpoint: https,
      token_endpoint: https, jwks_uri: https, authorization_response_iss_parameter_supported: z.boolean().optional(),
      token_endpoint_auth_methods_supported: z.array(z.string()).optional() }).passthrough().parse(JSON.parse(
      await enterpriseFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, origins)));
    if (discovery.token_endpoint_auth_methods_supported &&
      !discovery.token_endpoint_auth_methods_supported.some((method) => ['client_secret_post', 'client_secret_basic'].includes(method))) {
      throw new AppError('BAD_REQUEST', 400, 'SSO_CLIENT_AUTH_UNSUPPORTED');
    }
    endpoints = { authorization_endpoint: discovery.authorization_endpoint, token_endpoint: discovery.token_endpoint,
      jwks_uri: discovery.jwks_uri, authorization_response_iss_required: discovery.authorization_response_iss_parameter_supported === true,
      client_auth_method: discovery.token_endpoint_auth_methods_supported?.includes('client_secret_basic') ? 'client_secret_basic' : 'client_secret_post' };
  }
  const tenant = raw.tenant ?? (['okta', 'keycloak'].includes(preset) ? { claim: 'iss', value: issuer } : undefined);
  return validateEnterpriseConfiguration(preset, protocol, { ...endpoints, ...raw, tenant, trusted_origins: origins });
}
