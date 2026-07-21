import {
  BillingAssignmentScope,
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
} from '@prisma/client';
import { createHash } from 'node:crypto';

import { AppError } from '../utils/errors.js';
import type { BillingFundingViewer } from './billing-funding-viewer.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

export type RecurringAddonSubject = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

export type RecurringAddonScope = {
  scope: BillingRecurringAddonSubscriptionScope;
  scopeKey: string;
  teamId: string | null;
  subscribingUserId: string | null;
  customerScope: BillingAssignmentScope;
  customerScopeKey: string;
  customerTeamId: string | null;
};

export function uniqueEntitlementScope(
  policies: Array<{ entitlementScope: BillingRecurringAddonEntitlementScope }>,
): BillingRecurringAddonEntitlementScope | null {
  const scopes = new Set(policies.map((policy) => policy.entitlementScope));
  return scopes.size === 1 ? ([...scopes][0] ?? null) : null;
}

export function recurringAddonScope(
  entitlementScope: BillingRecurringAddonEntitlementScope,
  subject: RecurringAddonSubject,
): RecurringAddonScope {
  if (entitlementScope === BillingRecurringAddonEntitlementScope.ORGANISATION) {
    return {
      scope: BillingRecurringAddonSubscriptionScope.ORGANISATION,
      scopeKey: subject.organisationId,
      teamId: null,
      subscribingUserId: null,
      customerScope: BillingAssignmentScope.ORGANISATION,
      customerScopeKey: subject.organisationId,
      customerTeamId: null,
    };
  }
  const customerScopeKey = `${subject.organisationId}:${subject.teamId}`;
  if (entitlementScope === BillingRecurringAddonEntitlementScope.TEAM) {
    return {
      scope: BillingRecurringAddonSubscriptionScope.TEAM,
      scopeKey: customerScopeKey,
      teamId: subject.teamId,
      subscribingUserId: null,
      customerScope: BillingAssignmentScope.TEAM,
      customerScopeKey,
      customerTeamId: subject.teamId,
    };
  }
  return {
    scope: BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
    scopeKey: `${customerScopeKey}:${subject.userId}`,
    teamId: subject.teamId,
    subscribingUserId: subject.userId,
    customerScope: BillingAssignmentScope.TEAM,
    customerScopeKey,
    customerTeamId: subject.teamId,
  };
}

export function canManageRecurringAddonScope(
  viewer: BillingFundingViewer,
  scope: BillingRecurringAddonSubscriptionScope,
): boolean {
  return isBillingManager({
    scope:
      scope === BillingRecurringAddonSubscriptionScope.ORGANISATION
        ? BillingAssignmentScope.ORGANISATION
        : BillingAssignmentScope.TEAM,
    orgRole: viewer.organisationRole,
    teamRole: viewer.teamRole,
  });
}

export function assertCanManageRecurringAddonScope(
  viewer: BillingFundingViewer,
  scope: BillingRecurringAddonSubscriptionScope,
): void {
  if (!canManageRecurringAddonScope(viewer, scope)) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_RECURRING_ADDON_MANAGER_REQUIRED');
  }
}

export function recurringAddonSubjectFingerprint(params: {
  appKeyId: string;
  serviceId: string;
  offerId: string;
  subject: RecurringAddonSubject;
  scope: RecurringAddonScope;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        app_key_id: params.appKeyId,
        service_id: params.serviceId,
        offer_id: params.offerId,
        product: params.subject.product,
        organisation_id: params.subject.organisationId,
        requested_team_id: params.subject.teamId,
        requested_by_user_id: params.subject.userId,
        scope: params.scope.scope,
        scope_key: params.scope.scopeKey,
        team_id: params.scope.teamId,
        subscribing_user_id: params.scope.subscribingUserId,
      }),
    )
    .digest('hex');
}
