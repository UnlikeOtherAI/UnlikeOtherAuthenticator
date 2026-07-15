import { createHash } from 'node:crypto';

import {
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type KeyLike,
} from 'jose';
import { z } from 'zod';

import { getEnv, type Env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  buildSignatureReceiptPdf,
  hashPdf,
  type ReceiptCertificateData,
} from './signature-pdf.service.js';
import {
  validateSignatureStorageKey,
  type SignatureObjectStorage,
} from './signature-storage.service.js';

const EVIDENCE_ALGORITHM = 'RS256';
const EVIDENCE_TYPE = 'uoa-signature-evidence+jws';

const SignatureEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    signatureId: z.string().min(1).max(200),
    verificationReference: z.string().min(24).max(64),
    userId: z.string().min(1).max(200),
    userEmail: z.string().email().max(320),
    signerName: z.string().trim().min(1).max(200),
    domain: z.string().min(1).max(253),
    agreementId: z.string().min(1).max(200),
    agreementVersionId: z.string().min(1).max(200),
    agreementVersion: z.number().int().positive(),
    agreementTitle: z.string().trim().min(1).max(200),
    sourcePdfSha256: z.string().regex(/^[\da-f]{64}$/u),
    acceptanceStatement: z.string().trim().min(1).max(4000),
    signingMethod: z.enum(['CLICKWRAP', 'TYPED_NAME']),
    typedName: z.string().trim().min(1).max(200).nullable(),
    signedAt: z.string().datetime({ offset: true }),
    authMethod: z.string().min(1).max(32),
    twoFaCompleted: z.boolean(),
    ipAddress: z.string().min(1).max(64).nullable(),
    userAgent: z.string().max(1000).nullable(),
    signingContinuationId: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.signingMethod === 'TYPED_NAME' && !manifest.typedName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['typedName'],
        message: 'typedName is required for TYPED_NAME evidence',
      });
    }
    if (manifest.signingMethod === 'CLICKWRAP' && manifest.typedName !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['typedName'],
        message: 'typedName must be null for CLICKWRAP evidence',
      });
    }
  });

export interface SignatureEvidenceManifest {
  schemaVersion: 1;
  signatureId: string;
  verificationReference: string;
  userId: string;
  userEmail: string;
  signerName: string;
  domain: string;
  agreementId: string;
  agreementVersionId: string;
  agreementVersion: number;
  agreementTitle: string;
  sourcePdfSha256: string;
  acceptanceStatement: string;
  signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
  typedName: string | null;
  signedAt: string;
  authMethod: string;
  twoFaCompleted: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  signingContinuationId: string;
}

export interface SignedEvidenceManifest {
  canonicalManifest: string;
  manifestSha256: string;
  compactJws: string;
  keyId: string;
}

export interface CreatedSignatureEvidence extends SignedEvidenceManifest {
  receiptPdf: Buffer;
  receiptPdfSha256: string;
  receiptStorageKey: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalizeValue(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalizeValue(child)}`)
    .join(',')}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalizeValue(value);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJwk(raw: string, requirePrivate: boolean): JWK & { kid: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_KEY_INVALID');
  }
  const jwk = value as JWK | null;
  if (
    !jwk ||
    typeof jwk !== 'object' ||
    jwk.kty !== 'RSA' ||
    typeof jwk.kid !== 'string' ||
    jwk.kid.length < 1 ||
    (jwk.alg !== undefined && jwk.alg !== EVIDENCE_ALGORITHM) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (requirePrivate && typeof jwk.d !== 'string')
  ) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_KEY_INVALID');
  }
  return jwk as JWK & { kid: string };
}

async function importEvidenceKey(jwk: JWK): Promise<KeyLike> {
  try {
    return (await importJWK(jwk, EVIDENCE_ALGORITHM)) as KeyLike;
  } catch {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_KEY_INVALID');
  }
}

export async function signEvidenceManifest(
  manifest: SignatureEvidenceManifest,
  privateJwkJson: string,
): Promise<SignedEvidenceManifest> {
  const jwk = parseJwk(privateJwkJson, true);
  const key = await importEvidenceKey(jwk);
  const parsedManifest = SignatureEvidenceManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_MANIFEST_INVALID');
  }
  const canonicalManifest = canonicalJson(parsedManifest.data as unknown as JsonValue);
  const manifestSha256 = hashText(canonicalManifest);
  const compactJws = await new CompactSign(Buffer.from(canonicalManifest, 'utf8'))
    .setProtectedHeader({ alg: EVIDENCE_ALGORITHM, kid: jwk.kid, typ: EVIDENCE_TYPE })
    .sign(key);
  return { canonicalManifest, manifestSha256, compactJws, keyId: jwk.kid };
}

function parsePublicJwks(raw: string): JWK[] {
  try {
    const value = JSON.parse(raw) as { keys?: unknown };
    if (!value || !Array.isArray(value.keys)) throw new Error('invalid');
    const keys = value.keys as JWK[];
    if (
      keys.some(
        (key) =>
          !key ||
          key.kty !== 'RSA' ||
          typeof key.kid !== 'string' ||
          key.kid.length < 1 ||
          (key.alg !== undefined && key.alg !== EVIDENCE_ALGORITHM) ||
          (key.use !== undefined && key.use !== 'sig') ||
          key.d !== undefined,
      )
    ) {
      throw new Error('invalid');
    }
    return keys;
  } catch {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_JWKS_INVALID');
  }
}

export async function verifyEvidenceManifest(
  compactJws: string,
  publicJwksJson: string,
): Promise<SignatureEvidenceManifest> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(compactJws);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'SIGNATURE_EVIDENCE_INVALID');
  }
  if (
    header.alg !== EVIDENCE_ALGORITHM ||
    header.typ !== EVIDENCE_TYPE ||
    typeof header.kid !== 'string'
  ) {
    throw new AppError('BAD_REQUEST', 400, 'SIGNATURE_EVIDENCE_INVALID');
  }
  const jwk = parsePublicJwks(publicJwksJson).find(
    (candidate) => candidate.kid === header.kid && candidate.kty === 'RSA',
  );
  if (!jwk) throw new AppError('BAD_REQUEST', 400, 'SIGNATURE_EVIDENCE_INVALID');
  try {
    const key = await importEvidenceKey(jwk);
    const result = await compactVerify(compactJws, key, {
      algorithms: [EVIDENCE_ALGORITHM],
    });
    const payload = Buffer.from(result.payload).toString('utf8');
    const parsed = SignatureEvidenceManifestSchema.safeParse(JSON.parse(payload));
    if (!parsed.success || canonicalJson(parsed.data as unknown as JsonValue) !== payload) {
      throw new Error('invalid evidence payload');
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AppError && err.message === 'SIGNATURE_EVIDENCE_KEY_INVALID') throw err;
    throw new AppError('BAD_REQUEST', 400, 'SIGNATURE_EVIDENCE_INVALID');
  }
}

function receiptData(
  manifest: SignatureEvidenceManifest,
  manifestSha256: string,
  verificationUrl: string,
): ReceiptCertificateData {
  return {
    signatureId: manifest.signatureId,
    verificationReference: manifest.verificationReference,
    verificationUrl,
    domain: manifest.domain,
    agreementId: manifest.agreementId,
    agreementVersionId: manifest.agreementVersionId,
    version: manifest.agreementVersion,
    agreementTitle: manifest.agreementTitle,
    signerName: manifest.signerName,
    signerEmail: manifest.userEmail,
    signingMethod: manifest.signingMethod,
    typedName: manifest.typedName ?? undefined,
    acceptanceStatement: manifest.acceptanceStatement,
    signedAt: new Date(manifest.signedAt),
    authMethod: manifest.authMethod,
    twoFaCompleted: manifest.twoFaCompleted,
    sourcePdfSha256: manifest.sourcePdfSha256,
    evidenceManifestSha256: manifestSha256,
  };
}

export async function createSignatureEvidence(input: {
  manifest: SignatureEvidenceManifest;
  sourcePdf: Uint8Array;
  verificationUrl: string;
  storage: SignatureObjectStorage;
  env?: Env;
}): Promise<CreatedSignatureEvidence> {
  const env = input.env ?? getEnv();
  if (!env.SIGNATURE_EVIDENCE_PRIVATE_JWK) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_KEY_MISSING');
  }
  if (hashPdf(input.sourcePdf) !== input.manifest.sourcePdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_SOURCE_HASH_MISMATCH');
  }
  try {
    const verificationUrl = new URL(input.verificationUrl);
    const expectedSuffix = `/signatures/verify/${encodeURIComponent(input.manifest.verificationReference)}`;
    if (
      !verificationUrl.pathname.endsWith(expectedSuffix) ||
      (env.NODE_ENV === 'production' && verificationUrl.protocol !== 'https:')
    ) {
      throw new Error('invalid verification URL');
    }
  } catch {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_VERIFICATION_URL_INVALID');
  }
  const signed = await signEvidenceManifest(input.manifest, env.SIGNATURE_EVIDENCE_PRIVATE_JWK);
  const receiptPdf = await buildSignatureReceiptPdf(
    input.sourcePdf,
    receiptData(input.manifest, signed.manifestSha256, input.verificationUrl),
  );
  const receiptStorageKey = validateSignatureStorageKey(
    `receipts/${input.manifest.domain}/${input.manifest.signatureId}/receipt.pdf`,
  );
  await input.storage.putImmutable(receiptStorageKey, receiptPdf, 'application/pdf');
  return {
    ...signed,
    receiptPdf,
    receiptPdfSha256: hashPdf(receiptPdf),
    receiptStorageKey,
  };
}
