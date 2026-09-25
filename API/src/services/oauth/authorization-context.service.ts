import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { getOAuthClient } from './client.service.js';
import { buildMcpClientConfig } from './config.service.js';
import { validatePublicScopes } from './scopes.service.js';
import { validateRequestedResource } from './resource-validation.service.js';

export const PublicAuthorizationContext = z.object({
  client_id: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2048).optional(),
  scope: z.string().max(512).optional(),
  resource: z.string().max(2048).optional(),
}).strict();
export type PublicContext = z.infer<typeof PublicAuthorizationContext>;

export async function resolvePublicContext(context: PublicContext, method?: string, db?: Pick<Prisma.TransactionClient, 'oAuthClient'>) {
  PublicAuthorizationContext.parse(context);
  parseRequiredPkceChallenge({ codeChallenge: context.code_challenge, codeChallengeMethod: context.code_challenge_method });
  const client = await getOAuthClient(context.client_id, db);
  if (!client || !client.redirectUris.includes(context.redirect_uri)) throw new AppError('BAD_REQUEST', 400, 'INVALID_CLIENT');
  validatePublicScopes(context.scope, client.scopes);
  validateRequestedResource(context.resource);
  const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
  if (method && (!client.nativeApp || !client.nativeApp.methods.includes(method))) throw new AppError('FORBIDDEN', 403);
  return { client, config };
}
