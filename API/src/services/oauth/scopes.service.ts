import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export function publicOAuthScopes(): string[] {
  return (getEnv().MCP_OAUTH_SCOPES_SUPPORTED ?? 'openid,profile,email,settings.read,settings.write')
    .split(',').map((scope) => scope.trim()).filter(Boolean);
}

export function validatePublicScopes(scope?: string, registered?: string[]): void {
  const requested = scope?.split(/\s+/).filter(Boolean) ?? [];
  const supported = publicOAuthScopes();
  if (requested.some((item) => !supported.includes(item) || (registered && !registered.includes(item)))) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SCOPE');
  }
}
