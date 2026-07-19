import { type JWK, type KeyLike, SignJWT, importJWK } from 'jose';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  parsePrivateRs256Jwk,
  parsePublicRs256Jwks,
  privateRs256JwkMatchesPublicJwks,
} from '../utils/rs256-jwk.js';
import type { EffectiveTariffPayload } from './billing-entitlement.service.js';

const ALGORITHM = 'RS256';
const TOKEN_TYPE = 'uoa-tariff+jwt';

type LoadedKey = {
  privateKey: KeyLike;
  kid: string;
  publicJwks: { keys: JWK[] };
};

let cachedKey: LoadedKey | undefined;

export type ExpectedEffectiveTariffBinding = {
  productId: string;
  productIdentifier: string;
  appKeyId: string;
  userId: string;
  organisationId: string;
  teamId: string;
};

export function assertEffectiveTariffPayloadBinding(
  payload: EffectiveTariffPayload,
  expected: ExpectedEffectiveTariffBinding,
): void {
  if (
    payload.product.id !== expected.productId ||
    payload.product.identifier !== expected.productIdentifier ||
    payload.authorized_party.app_key_id !== expected.appKeyId ||
    payload.subject.user_id !== expected.userId ||
    payload.subject.organisation_id !== expected.organisationId ||
    payload.subject.team_id !== expected.teamId
  ) {
    throw new AppError('FORBIDDEN', 403, 'TARIFF_SNAPSHOT_BINDING_MISMATCH');
  }
}

async function loadKey(): Promise<LoadedKey> {
  if (cachedKey) return cachedKey;
  const env = getEnv();
  const privateRaw = env.TARIFF_SNAPSHOT_PRIVATE_JWK;
  const publicRaw = env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON;
  if (!privateRaw || !publicRaw) {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_SIGNING_DISABLED');
  }
  const parsedPrivate = parsePrivateRs256Jwk(privateRaw);
  const parsedPublic = parsePublicRs256Jwks(publicRaw);
  if (!parsedPrivate || !parsedPublic || !privateRs256JwkMatchesPublicJwks(privateRaw, publicRaw)) {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_KEY_INVALID');
  }
  try {
    const privateKey = (await importJWK(parsedPrivate.jwk, ALGORITHM)) as KeyLike;
    await Promise.all(parsedPublic.keys.map((key) => importJWK(key, ALGORITHM)));
    cachedKey = {
      privateKey,
      kid: parsedPrivate.kid,
      publicJwks: { keys: parsedPublic.keys },
    };
    return cachedKey;
  } catch {
    throw new AppError('INTERNAL', 500, 'TARIFF_SNAPSHOT_KEY_INVALID');
  }
}

export function resetTariffSnapshotKeyCache(): void {
  cachedKey = undefined;
}

export async function preloadTariffSnapshotSigningKey(): Promise<void> {
  await loadKey();
}

export async function getTariffSnapshotPublicJwks(): Promise<{ keys: JWK[] }> {
  const { keys } = (await loadKey()).publicJwks;
  return { keys: keys.map((key) => ({ ...key })) };
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
