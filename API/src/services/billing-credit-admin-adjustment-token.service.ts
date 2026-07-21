import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { AppError } from '../utils/errors.js';

const TOKEN_ISSUER = 'uoa:billing-credit-admin-adjustment';
const TOKEN_TTL_SECONDS = 120;
const ALLOWED_ALGORITHMS = ['HS256'] as const;

export const creditAutoTopUpConsequenceValues = [
  'not_active',
  'configuration_incomplete',
  'remains_above_threshold',
  'crosses_below_threshold',
  'remains_below_threshold',
  'crosses_above_threshold',
] as const;

const TokenAutoTopUpSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    state: z.enum(['disabled', 'active', 'paused', 'requires_action', 'needs_review']),
    threshold_credits: z.string().nullable(),
    refill_credits: z.string().nullable(),
    consequence: z.enum(creditAutoTopUpConsequenceValues),
  })
  .strict();

const TokenSnapshotSchema = z.object({
  sub: z.string().min(1),
  actor_email: z.string().min(1).max(320),
  admin_domain: z.string().min(1),
  credit_account_id: z.string().min(1),
  organisation_id: z.string().min(1),
  team_id: z.string().min(1),
  mode: z.enum(['test', 'live']),
  current_credits: z.string(),
  resulting_credits: z.string(),
  signed_credits: z.string(),
  reason: z.string().min(1).max(1000),
  idempotency_key: z.string().min(1).max(200),
  automatic_top_up: TokenAutoTopUpSchema,
});

export type CreditAdjustmentTokenSnapshot = Omit<z.infer<typeof TokenSnapshotSchema>, 'sub'> & {
  actor_user_id: string;
};

export type VerifiedCreditAdjustmentToken = CreditAdjustmentTokenSnapshot & {
  expires_at: string;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function invalidToken(): AppError {
  return new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_INVALID');
}

export async function signCreditAdjustmentConfirmation(params: {
  snapshot: CreditAdjustmentTokenSnapshot;
  secret: string;
  audience: string;
  now?: Date;
}): Promise<{ confirmation_token: string; expires_at: string }> {
  const issuedAt = Math.floor((params.now ?? new Date()).getTime() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  try {
    const confirmationToken = await new SignJWT({
      actor_email: params.snapshot.actor_email,
      admin_domain: params.snapshot.admin_domain,
      credit_account_id: params.snapshot.credit_account_id,
      organisation_id: params.snapshot.organisation_id,
      team_id: params.snapshot.team_id,
      mode: params.snapshot.mode,
      current_credits: params.snapshot.current_credits,
      resulting_credits: params.snapshot.resulting_credits,
      signed_credits: params.snapshot.signed_credits,
      reason: params.snapshot.reason,
      idempotency_key: params.snapshot.idempotency_key,
      automatic_top_up: params.snapshot.automatic_top_up,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'uoa-credit-adjustment-confirmation+jwt' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(params.audience)
      .setSubject(params.snapshot.actor_user_id)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(secretKey(params.secret));
    return {
      confirmation_token: confirmationToken,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    };
  } catch {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_SIGN_FAILED');
  }
}

export async function verifyCreditAdjustmentConfirmation(params: {
  token: string;
  secret: string;
  audience: string;
  now?: Date;
}): Promise<VerifiedCreditAdjustmentToken> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(params.token, secretKey(params.secret), {
      algorithms: [...ALLOWED_ALGORITHMS],
      issuer: TOKEN_ISSUER,
      audience: params.audience,
      currentDate: params.now,
      typ: 'uoa-credit-adjustment-confirmation+jwt',
    });
    payload = verified.payload;
  } catch {
    throw invalidToken();
  }
  const parsed = TokenSnapshotSchema.safeParse(payload);
  if (!parsed.success || typeof payload.exp !== 'number') throw invalidToken();
  const { sub, ...snapshot } = parsed.data;
  return {
    ...snapshot,
    actor_user_id: sub,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}
