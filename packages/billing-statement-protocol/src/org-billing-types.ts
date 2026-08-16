/**
 * Organisation-wide billing responsibility (protocol 1.3.0, additive).
 *
 * When an organisation has taken billing over from its teams, UOA answers a
 * team's statement or credits view with a `controlled_by` block. Products
 * render `message` verbatim and, when `can_manage` is true, offer the single
 * action UOA names in `manage_action_id`. No product composes that sentence,
 * and no product decides who may manage: `can_manage` is UOA's verdict about
 * the exact caller, not a role claim the browser or session carries.
 *
 * The block is optional. A statement or credits view without it means the
 * organisation has not taken billing over, which is every deployment today.
 */
export const BILLING_ORG_BILLING_MANAGE_ACTION_ID = 'org-billing-open' as const;

export type BillingControlledByV1 = {
  scope: 'organisation';
  organisation_id: string;
  /** Display-ready organisation name. */
  organisation_name: string;
  /** Display-ready sentence. Render verbatim; never rewrite or translate. */
  message: string;
  /** True only when UOA has verified the caller is an organisation billing manager. */
  can_manage: boolean;
  /**
   * The one action a manager may take, or null. Null whenever `can_manage` is
   * false — an ordinary member is told who owns billing, not offered a control
   * that would 403.
   */
  manage_action_id: typeof BILLING_ORG_BILLING_MANAGE_ACTION_ID | null;
};
