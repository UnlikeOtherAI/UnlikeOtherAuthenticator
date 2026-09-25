// OAuth public-client registry for the MCP profile (brief §22.14). RFC 7591 dynamic
// registration of PUBLIC clients — no secrets are issued or stored. The registry is
// touched only via the BYPASSRLS admin path (registration + pre-context lookups).
import { randomBytes } from 'node:crypto';

import type { OAuthClient, NativeApp, Prisma } from '@prisma/client';

import { getAdminPrisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { tryParseRedirectUrl } from '../../utils/http-url.js';
import { nativeRedirectMatches } from './native-app-policy.js';

/** Validate a redirect URI per RFC 8252 native-app guidance: https anywhere, http
 *  only for loopback, and custom (non-http) schemes for native deep links. Shares the
 *  single redirect-URL policy used by the config-JWT and admin-allowlist paths. */
export function isAllowedRedirectUri(value: string): boolean {
  return Boolean(tryParseRedirectUrl(value));
}

function generateClientId(): string {
  return `mcp_${randomBytes(24).toString('base64url')}`;
}

export interface RegisterOAuthClientInput {
  appId?: string;
  redirectUris: string[];
  clientName?: string;
  scopes?: string[];
}

export async function registerOAuthClient(input: RegisterOAuthClientInput): Promise<OAuthClient> {
  const redirectUris = [...new Set(input.redirectUris.map((u) => u.trim()).filter(Boolean))];
  if (redirectUris.length === 0) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URI');
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URI');
  }

  const prisma = getAdminPrisma();
  const nativeApp = input.appId ? await prisma.nativeApp.findUnique({ where: { identifier: input.appId } }) : null;
  if (input.appId && (!nativeApp?.enabled ||
      redirectUris.some((uri) => !nativeApp.redirectUris.some((allowed) => nativeRedirectMatches(allowed, uri))) ||
      (input.scopes ?? []).some((scope) => !nativeApp.scopes.includes(scope)))) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_NATIVE_APP');
  }
  // Retry on the (astronomically unlikely) client_id collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.oAuthClient.create({
        data: {
          clientId: generateClientId(),
          clientName: nativeApp?.name ?? input.clientName?.slice(0, 200) ?? null,
          redirectUris,
          scopes: input.scopes ?? [],
          nativeAppId: nativeApp?.id,
          nativeAppRevision: nativeApp?.revision,
        },
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new AppError('INTERNAL', 500, 'CLIENT_ID_COLLISION');
}

export async function getOAuthClient(clientId: string, db: Pick<Prisma.TransactionClient, 'oAuthClient'> = getAdminPrisma()): Promise<(OAuthClient & { nativeApp?: NativeApp | null }) | null> {
  if (!clientId) return null;
  const client = await db.oAuthClient.findUnique({ where: { clientId }, include: { nativeApp: true } });
  if (client?.nativeAppId && (!client.nativeApp?.enabled || client.nativeAppRevision !== client.nativeApp.revision)) return null;
  return client;
}
