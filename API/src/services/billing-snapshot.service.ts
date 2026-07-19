import { type JWK, type KeyLike, SignJWT, importJWK } from 'jose';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { parsePrivateRs256Jwk, toPublicRs256Jwk } from '../utils/rs256-jwk.js';
import type { EffectiveTariffPayload } from './billing-entitlement.service.js';

const ALGORITHM = 'RS256';
const TOKEN_TYPE = 'uoa-tariff+jwt';

type LoadedKey = {
  privateKey: KeyLike;
  kid: string;
  publicJwk: JWK;
};

let cachedKey: LoadedKey | undefined;

async function loadKey(): Promise<LoadedKey> {
  if (cachedKey) return cachedKey;
  const raw = getEnv().TARIFF_SNAPSHOT_PRIVATE_JWK;
  const parsed = raw ? parsePrivateRs256Jwk(raw) : null;
  if (!parsed) {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_SIGNING_DISABLED');
  }
  try {
    cachedKey = {
      privateKey: (await importJWK(parsed.jwk, ALGORITHM)) as KeyLike,
      kid: parsed.kid,
      publicJwk: toPublicRs256Jwk(parsed.jwk),
    };
    return cachedKey;
  } catch {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_KEY_INVALID');
  }
}

export function resetTariffSnapshotKeyCache(): void {
  cachedKey = undefined;
}

export async function getTariffSnapshotPublicJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await loadKey()).publicJwk] };
}

export async function signEffectiveTariffSnapshot(params: {
  payload: EffectiveTariffPayload;
  audience: string;
  issuedAtEpochSeconds: number;
  expiresAtEpochSeconds: number;
}): Promise<string> {
  const { privateKey, kid } = await loadKey();
  try {
    return await new SignJWT(params.payload)
      .setProtectedHeader({ alg: ALGORITHM, kid, typ: TOKEN_TYPE })
      .setIssuer(getPublicBaseUrl())
      .setAudience(params.audience)
      .setSubject(params.payload.subject.user_id)
      .setJti(params.payload.snapshot_id)
      .setIssuedAt(params.issuedAtEpochSeconds)
      .setExpirationTime(params.expiresAtEpochSeconds)
      .sign(privateKey);
  } catch {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_SIGN_FAILED');
  }
}
