// OAuth public-client registry for the MCP profile (brief §22.14). RFC 7591 dynamic
// registration of PUBLIC clients — no secrets are issued or stored. The registry is
// touched only via the BYPASSRLS admin path (registration + pre-context lookups).
import { randomBytes } from 'node:crypto';

import type { OAuthClient } from '@prisma/client';

import { getAdminPrisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';

/** Validate a redirect URI per RFC 8252 native-app guidance: https anywhere, http
 *  only for loopback, and custom (non-http) schemes for native deep links. */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }
  // Custom scheme (e.g. cursor://, vscode://) for native clients: require a scheme
  // and some authority/path so it isn't an empty or malformed value.
  return url.protocol.length > 1 && value.includes('://') && value.length > url.protocol.length + 3;
}

function generateClientId(): string {
  return `mcp_${randomBytes(24).toString('base64url')}`;
}

export interface RegisterOAuthClientInput {
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
  // Retry on the (astronomically unlikely) client_id collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.oAuthClient.create({
        data: {
          clientId: generateClientId(),
          clientName: input.clientName?.slice(0, 200) ?? null,
          redirectUris,
          scopes: input.scopes ?? [],
        },
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new AppError('INTERNAL', 500, 'CLIENT_ID_COLLISION');
}

export async function getOAuthClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  return getAdminPrisma().oAuthClient.findUnique({ where: { clientId } });
}
