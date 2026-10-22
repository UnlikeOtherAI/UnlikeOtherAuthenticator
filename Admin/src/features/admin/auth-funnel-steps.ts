import type { AuthFunnelCount, AuthFunnelSummary } from '../../schemas/auth-funnel';

// Docs/Auth/signup-funnel-metrics.md is the source for every step and outcome named here.
export type FunnelStepInfo = {
  step: string;
  label: string;
  description: string;
  // Outcomes that move a person on to the next step; undefined means every outcome does.
  reached?: string[];
};

export const funnelSteps: FunnelStepInfo[] = [
  { step: 'flow_started', label: 'Sign-in window opened', description: 'A product opened the UOA window. Every load counts; UOA re-rendering it mid-flow does not.' },
  { step: 'register_submitted', label: 'Create-account form submitted', description: 'Someone submitted the create-account form. Malformed addresses are counted separately.', reached: ['valid_email'] },
  { step: 'email_start_submitted', label: 'Email-first form submitted', description: 'The email-first sign-in form, for products with email codes enabled.', reached: ['valid_email'] },
  { step: 'login_submitted', label: 'Password sign-in submitted', description: 'Email and password submitted on the sign-in form.', reached: ['succeeded'] },
  { step: 'social_started', label: 'Social sign-in started', description: 'Sent to Google, Apple or another provider, by provider.' },
  { step: 'registration_email', label: 'Registration email', description: 'What UOA did with a submitted address. Sent means the email provider accepted it, not that it arrived or was read.', reached: ['verification_sent', 'login_link_sent'] },
  { step: 'email_link_opened', label: 'Email link opened', description: 'The link from that email was opened. Expired, used and unknown links land on the sign-in screen.', reached: ['valid_set_password', 'valid_verify_email', 'valid_login_link'] },
  { step: 'set_password', label: 'Password set', description: 'Set-password form submitted from the email link. Succeeded means the account was created.', reached: ['succeeded'] },
  { step: 'sign_in_completed', label: 'Returned to product', description: 'Sign-in finished and UOA sent the person back to the product with an authorization code, by method.' },
  { step: 'code_exchange', label: 'Code redeemed by product', description: "The product's backend exchanged the code for tokens. Rejections show UOA's internal reason.", reached: ['succeeded'] },
];

const outcomeLabels: Record<string, string> = {
  already_used: 'Already used',
  blocked: 'Not sent: registration not allowed',
  email_code: 'Email code',
  email_password: 'Email and password',
  error: 'Error',
  existing_user_inline: 'Existing account: told to sign in',
  expired: 'Expired',
  failed: 'Failed',
  invalid: 'Invalid or unknown',
  invalid_email: 'Malformed address',
  invalid_pkce: 'Damaged link',
  invite: 'Team invitation',
  invite_unavailable: 'Team invitation: unusable',
  login_link: 'Sign-in link',
  login_link_failed: 'Sign-in link: send failed',
  login_link_sent: 'Sign-in link sent (existing account)',
  missing_pkce: 'Damaged link (no PKCE)',
  password_rejected: 'Password rejected',
  shown: 'Shown',
  succeeded: 'Succeeded',
  valid_email: 'Valid address',
  valid_login_link: 'Valid sign-in link',
  valid_set_password: 'Valid set-password link',
  valid_verify_email: 'Valid verification link',
  verification_failed: 'Verification: send failed',
  verification_sent: 'Verification sent',
  verify_email: 'Email link',
  verify_email_set_password: 'Email link and new password',
};

export function outcomeLabel(outcome: string): string {
  const known = outcomeLabels[outcome];
  if (known) return known;
  // Code-exchange rejections carry UOA's internal reason, e.g. rejected_pkce_verifier_invalid.
  if (outcome.startsWith('rejected_')) return `Rejected: ${outcome.slice('rejected_'.length).replaceAll('_', ' ')}`;
  return outcome.replaceAll('_', ' ');
}

export function isReachedOutcome(info: FunnelStepInfo, outcome: string): boolean {
  return !info.reached || info.reached.includes(outcome);
}

export type FunnelRow = FunnelStepInfo & { total: number; reachedCount: number; outcomes: AuthFunnelCount[] };

export function buildFunnelRows(totals: AuthFunnelCount[]): FunnelRow[] {
  return funnelSteps.map((info) => {
    const outcomes = totals.filter((row) => row.step === info.step);
    return {
      ...info,
      outcomes,
      total: outcomes.reduce((sum, row) => sum + row.count, 0),
      reachedCount: outcomes.filter((row) => isReachedOutcome(info, row.outcome)).reduce((sum, row) => sum + row.count, 0),
    };
  });
}

export function buildDailyRows(days: AuthFunnelSummary['days']): Array<{ day: string; reached: number[] }> {
  const byDay = new Map<string, AuthFunnelCount[]>();
  for (const row of days) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, rows]) => ({ day, reached: buildFunnelRows(rows).map((row) => row.reachedCount) }));
}
