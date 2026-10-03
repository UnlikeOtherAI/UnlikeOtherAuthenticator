import { z } from 'zod';

import { privateRs256JwkKeyId, publicRs256JwkKeyIds } from '../utils/rs256-jwk.js';

// Optional agreement-signature module. Disabled is the process default; a domain cannot be
// enabled until storage, retention, and the dedicated evidence key are configured.
export const signatureEnvShape = {
  SIGNATURE_STORAGE_PROVIDER: z.enum(['disabled', 'filesystem', 'gcs']).default('disabled'),
  SIGNATURE_FILESYSTEM_ROOT: z.string().min(1).optional(),
  SIGNATURE_GCS_BUCKET: z.string().min(1).optional(),
  SIGNATURE_GCS_PROJECT_ID: z.string().min(1).optional(),
  SIGNATURE_MALWARE_SCANNER: z.enum(['disabled', 'clamav']).default('disabled'),
  SIGNATURE_CLAMDSCAN_PATH: z.string().min(1).default('clamdscan'),
  SIGNATURE_MALWARE_SCAN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(30_000),
  SIGNATURE_EVIDENCE_PRIVATE_JWK: z
    .string()
    .min(1)
    .refine((value) => privateRs256JwkKeyId(value) !== undefined, {
      message: 'SIGNATURE_EVIDENCE_PRIVATE_JWK must be a private RS256 RSA JWK with a kid',
    })
    .optional(),
  SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: z
    .string()
    .min(1)
    .refine((value) => publicRs256JwkKeyIds(value) !== undefined, {
      message: 'SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON must contain public-only RS256 RSA keys',
    })
    .optional(),
  SIGNATURE_MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  SIGNATURE_MAX_PDF_PAGES: z.coerce.number().int().min(1).max(2000).default(200),
  SIGNATURE_CONTINUATION_TTL_MINUTES: z.coerce.number().int().min(2).max(30).default(10),
  SIGNATURE_MAX_SIGN_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
};

type SignatureStorageEnvironment = {
  NODE_ENV: string;
  SIGNATURE_STORAGE_PROVIDER: 'disabled' | 'filesystem' | 'gcs';
  SIGNATURE_FILESYSTEM_ROOT?: string;
  SIGNATURE_GCS_BUCKET?: string;
};

export function addSignatureStorageIssues(
  env: SignatureStorageEnvironment,
  ctx: z.RefinementCtx,
): void {
  if (env.SIGNATURE_STORAGE_PROVIDER === 'filesystem' && !env.SIGNATURE_FILESYSTEM_ROOT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SIGNATURE_FILESYSTEM_ROOT'],
      message: 'SIGNATURE_FILESYSTEM_ROOT is required for filesystem signature storage',
    });
  }
  if (env.SIGNATURE_STORAGE_PROVIDER === 'filesystem' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SIGNATURE_STORAGE_PROVIDER'],
      message: 'filesystem signature storage is not allowed in production',
    });
  }
  if (env.SIGNATURE_STORAGE_PROVIDER === 'gcs' && !env.SIGNATURE_GCS_BUCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SIGNATURE_GCS_BUCKET'],
      message: 'SIGNATURE_GCS_BUCKET is required for GCS signature storage',
    });
  }
}

type SignatureEvidenceKeyEnvironment = {
  SIGNATURE_EVIDENCE_PRIVATE_JWK?: string;
  SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON?: string;
};

export function addSignatureEvidenceKeyIssues(
  env: SignatureEvidenceKeyEnvironment,
  ctx: z.RefinementCtx,
): void {
  if (env.SIGNATURE_EVIDENCE_PRIVATE_JWK && env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON) {
    const privateKid = privateRs256JwkKeyId(env.SIGNATURE_EVIDENCE_PRIVATE_JWK);
    const publicKids = publicRs256JwkKeyIds(env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON);
    if (privateKid && publicKids && !publicKids.includes(privateKid)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON'],
        message: 'evidence public JWKS must include the current private key kid',
      });
    }
  }
}
