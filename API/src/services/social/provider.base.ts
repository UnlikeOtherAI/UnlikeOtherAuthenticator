import { z } from 'zod';

import { AppError } from '../../utils/errors.js';

export type SocialProviderKey = 'google' | 'apple' | 'facebook';

export type SocialProfile = {
  provider: SocialProviderKey;
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
};

const SocialProfileSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook']),
  email: z.string().trim().toLowerCase().email(),
  emailVerified: z.boolean(),
  name: z.string().trim().min(1).nullable(),
  avatarUrl: z.string().trim().min(1).nullable(),
});

export function validateSocialProfile(value: unknown): SocialProfile {
  return SocialProfileSchema.parse(value);
}

/**
 * Brief 22.6: only accept provider-verified emails from social providers.
 */
export function assertProviderVerifiedEmail(profile: SocialProfile): void {
  if (!profile.emailVerified) {
    // Never leak provider specifics to the user; keep message internal.
    throw new AppError('UNAUTHORIZED', 401, 'SOCIAL_EMAIL_NOT_VERIFIED');
  }
}
