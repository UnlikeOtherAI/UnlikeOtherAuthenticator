import { z } from 'zod';
import { normalizeBoolean } from './env-values.js';
import { privateRs256JwkKeyId, publicRs256JwkKeyIds } from '../utils/rs256-jwk.js';

export const oauthEnvironmentFields = {
  // Shared RS256 resource signer; key presence alone never enables public OAuth.
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: z.string().min(1).optional(),
  MCP_OAUTH_PUBLIC_PROFILE_ENABLED: z.preprocess(normalizeBoolean, z.boolean().default(false)),
  MCP_OAUTH_DOMAIN: z.string().min(1).optional(),
  MCP_OAUTH_ENABLED_AUTH_METHODS: z.string().min(1).optional(),
  MCP_OAUTH_SCOPES_SUPPORTED: z.string().min(1).optional(),
  // Generic RFC 8707 resources remain separate from the Kelpie-only ticket grant.
  MCP_OAUTH_RESOURCES_SUPPORTED: z.string().min(1).optional(),
  // One exact operator-approved Nessie gateway. Absent means no Kelpie tickets.
  KELPIE_CONNECT_RESOURCE: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/api/kelpie/connect'
      );
    }, 'KELPIE_CONNECT_RESOURCE must be an exact credential-free HTTPS Kelpie gateway URL')
    .optional(),
  // Optional asymmetric user-token issuance; both keys and overlap are checked by env.ts.
  USER_ACCESS_TOKEN_PRIVATE_JWK: z
    .string()
    .min(1)
    .refine((value) => privateRs256JwkKeyId(value) !== undefined, {
      message: 'USER_ACCESS_TOKEN_PRIVATE_JWK must be a private RS256 RSA JWK with a kid',
    })
    .optional(),
  USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON: z
    .string()
    .min(1)
    .refine((value) => publicRs256JwkKeyIds(value) !== undefined, {
      message: 'USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON must contain public-only RS256 RSA keys',
    })
    .optional(),
};

export function addOAuthEnvironmentIssues(
  env: z.infer<z.ZodObject<typeof oauthEnvironmentFields>>,
  ctx: z.RefinementCtx,
): void {
  if (env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED && !env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK'],
      message: 'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK is required for the public OAuth profile',
    });
  }
  if (env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED && !env.MCP_OAUTH_DOMAIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MCP_OAUTH_DOMAIN'],
      message: 'MCP_OAUTH_DOMAIN is required for the public OAuth profile',
    });
  }
  if (
    Boolean(env.USER_ACCESS_TOKEN_PRIVATE_JWK) !== Boolean(env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'],
      message:
        'USER_ACCESS_TOKEN_PRIVATE_JWK and USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON must be set together',
    });
  }
  if (env.USER_ACCESS_TOKEN_PRIVATE_JWK && env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON) {
    const privateKid = privateRs256JwkKeyId(env.USER_ACCESS_TOKEN_PRIVATE_JWK);
    const publicKids = publicRs256JwkKeyIds(env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON);
    if (privateKid && publicKids && !publicKids.includes(privateKid)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'],
        message: 'user access-token public JWKS must include the current private key kid',
      });
    }
  }
}
