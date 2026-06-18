/**
 * Client-side mirror of the API password policy (API/src/services/password.service.ts).
 *
 * Decision 2026-06-18 (HUGO-147): length is the only enforced rule. Character classes are
 * encouraged but never required. Keeping this in sync with the API lets the UI tell the user
 * in real time whether their password is acceptable — so a valid password is never rejected
 * server-side with a confusing message.
 */

import type { TranslationKey } from '../i18n/translations/en.js';

export const MIN_PASSWORD_LENGTH = 8;

export type PasswordRequirement = {
  /** Stable key for React lists. */
  key: string;
  /** i18n key describing the requirement. */
  label: TranslationKey;
  /** Whether the current password satisfies this requirement. */
  met: boolean;
};

export function checkPasswordPolicy(password: string): {
  valid: boolean;
  requirements: PasswordRequirement[];
} {
  const requirements: PasswordRequirement[] = [
    {
      key: 'minLength',
      label: 'form.password.requirement.minLength',
      met: password.length >= MIN_PASSWORD_LENGTH,
    },
  ];

  return { valid: requirements.every((r) => r.met), requirements };
}
