import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export const KELPIE_APP_ID = 'com.unlikeotherai.kelpie';
export const KELPIE_CONNECT_SCOPE = 'kelpie.connect';
export const KELPIE_TICKET_TTL_SECONDS = 120;

export function assertKelpieScopeClient(scopes: string[], appId?: string): void {
  if (scopes.includes(KELPIE_CONNECT_SCOPE) && appId !== KELPIE_APP_ID) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SCOPE');
  }
}

export function kelpieConnectResource(): string {
  const resource = getEnv().KELPIE_CONNECT_RESOURCE;
  if (!resource) throw new AppError('NOT_FOUND', 404);
  return resource;
}

export function rejectKelpieConnection(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}
