import { BillingAssignmentScope } from '@prisma/client';

const BILLING_MANAGER_ROLES = new Set(['owner', 'admin']);

export function isBillingManager(params: {
  scope: BillingAssignmentScope;
  orgRole: string;
  teamRole?: string | null;
}): boolean {
  if (BILLING_MANAGER_ROLES.has(params.orgRole)) return true;
  return (
    params.scope === BillingAssignmentScope.TEAM &&
    Boolean(params.teamRole && BILLING_MANAGER_ROLES.has(params.teamRole))
  );
}
