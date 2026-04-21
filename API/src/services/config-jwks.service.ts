import { z } from 'zod';

import { requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const privateJwkMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

const PublicConfigJwkSchema = z.record(z.unknown()).superRefine((key, ctx) => {
  for (const member of privateJwkMembers) {
    if (member in key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `private JWK member ${member} is not allowed`,
        path: [member],
      });
    }
  }

  if (key.kty !== 'RSA') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'config JWK must be an RSA public key',
      path: ['kty'],
    });
  }

  for (const member of ['kid', 'n', 'e'] as const) {
    if (typeof key[member] !== 'string' || !key[member].trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${member} is required`,
        path: [member],
      });
    }
  }
});

const PublicConfigJwksSchema = z
  .object({
    keys: z.array(PublicConfigJwkSchema).min(1),
  })
  .passthrough();

export type PublicConfigJwks = z.infer<typeof PublicConfigJwksSchema>;

export function readPublicConfigJwks(): PublicConfigJwks {
  const { CONFIG_JWKS_JSON } = requireEnv('CONFIG_JWKS_JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(CONFIG_JWKS_JSON);
  } catch {
    throw new AppError('INTERNAL', 500, 'CONFIG_JWKS_JSON_INVALID');
  }

  const result = PublicConfigJwksSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError('INTERNAL', 500, 'CONFIG_JWKS_JSON_INVALID');
  }

  return result.data;
}
