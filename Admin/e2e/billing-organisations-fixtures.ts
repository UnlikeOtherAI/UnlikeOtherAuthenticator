import type { Page, Route } from '@playwright/test';

import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import type { BillingAssignment, BillingService, BillingTariff } from '../src/schemas/billing';

// Synthetic products for Admin → Billing → Organisations. Layered over installFixtures: these
// routes are registered later, so they answer first; everything else falls through.

const created = '2026-10-01T09:30:00.000Z';

function tariff(serviceId: string, id: string, name: string, extra: Partial<BillingTariff> = {}): BillingTariff {
  return {
    id, service_id: serviceId, key: id, version: 1, name, mode: 'standard', collection_mode: 'stripe',
    markup_bps: 3000, markup_percent: '30.00', usage_payment_mode: 'prepaid', usage_currency: 'USD',
    monthly_subscription: { amount_minor: '399', currency: 'USD', charge_basis: 'per_seat',
      seat_policy: 'automatic', seat_charge_timing: 'full_month' },
    is_default: false, retired_at: null, retire_blocked_by: [], created_by_email: 'system:seed',
    created_at: created, ...extra,
  };
}

function nextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}

function service(id: string, name: string, tariffs: BillingTariff[]): BillingService {
  return {
    id, identifier: id, name, active: true, tariffs, assignments: [], app_keys: [], adjustments: [],
    stripe_catalogs: [], stripe_subscriptions: [], created_at: created, updated_at: created,
  };
}

export async function installOrganisationBillingFixtures(page: Page) {
  const standard = tariff('nessie', 'standard', 'Standard', { is_default: true });
  const free = tariff('nessie', 'free', 'Free', {
    mode: 'free', collection_mode: 'none', markup_bps: 0, markup_percent: '0.00', usage_payment_mode: 'pay_as_you_go',
    monthly_subscription: { amount_minor: '0', currency: 'USD', charge_basis: 'flat', seat_policy: null,
      seat_charge_timing: null },
  });
  const legacy = tariff('nessie', 'legacy', 'Legacy', { retired_at: '2026-11-02T10:00:00.000Z' });
  const metered = tariff('deepwater', 'metered', 'Metered', { is_default: true, collection_mode: 'manual',
    usage_payment_mode: 'pay_as_you_go', monthly_subscription: { amount_minor: '0', currency: 'USD',
      charge_basis: 'flat', seat_policy: null, seat_charge_timing: null } });
  const meteredPlus = tariff('deepwater', 'metered-plus', 'Metered plus', { markup_bps: 1500,
    markup_percent: '15.00', collection_mode: 'manual', monthly_subscription: { amount_minor: '5000',
      currency: 'USD', charge_basis: 'flat', seat_policy: null, seat_charge_timing: null } });
  const nessie = service('nessie', 'Nessie', [standard, free, legacy]);
  const deepwater = service('deepwater', 'DeepWater', [metered, meteredPlus]);
  const services = [nessie, deepwater];
  let sequence = 0;
  const assign = (target: BillingService, assigned: BillingTariff, organisation: { id: string; name: string },
    team: { id: string; name: string } | null, effectiveFrom: string | null): BillingAssignment => {
    sequence += 1;
    const assignment: BillingAssignment = {
      id: `assignment-${sequence}`, tariff_id: assigned.id, scope: team ? 'team' : 'organisation',
      organisation, team, tariff: assigned, effective_from_month: effectiveFrom,
      created_by_email: 'operator@example.test', created_at: created, updated_at: created,
    };
    target.assignments = target.assignments.filter((entry) => !(entry.organisation.id === organisation.id
      && (entry.team?.id ?? null) === (team?.id ?? null)));
    target.assignments.push(assignment);
    return assignment;
  };
  const acme = { id: 'o1', name: 'Acme Engineering' };
  assign(nessie, free, acme, null, '2026-10');
  assign(nessie, standard, acme, { id: 't12', name: 'Backend' }, '2026-10');
  assign(nessie, free, acme, { id: 't15', name: 'QA' }, nextMonth());
  assign(deepwater, meteredPlus, { id: 'o3', name: 'Widgets Core' }, null, '2026-09');

  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let refuseNextSave = false;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/internal/admin/billing/organisations/*/mode', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const organisationId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    return json(route, { organisation_id: organisationId, mode: 'live', revision: 0, epoch: created, blockers: [] });
  });
  await page.route('**/internal/admin/billing/services**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/internal/admin/billing/services', '');
    if (request.method() === 'GET' && path === '') return json(route, services);
    const match = /^\/([^/]+)\/assignments(?:\/([^/]+))?$/.exec(path);
    const target = services.find((entry) => entry.id === match?.[1]);
    if (!match || !target) return route.fallback();
    if (request.method() === 'PUT' && !match[2]) {
      const body = request.postDataJSON() as { tariff_id: string; organisation_id: string; team_id: string | null };
      writes.push({ method: 'PUT', path, body });
      if (refuseNextSave) {
        refuseNextSave = false;
        return json(route, { error: 'Request failed', code: 'STRIPE_TARIFF_PINNED' }, 409);
      }
      const assigned = target.tariffs.find((entry) => entry.id === body.tariff_id);
      const directory = mockAdminData.organisations.find((entry) => entry.id === body.organisation_id);
      const directoryTeam = directory?.teams.find((entry) => entry.id === body.team_id);
      if (!assigned || assigned.retired_at || !directory || (body.team_id && !directoryTeam)) {
        return json(route, { error: 'Invalid assignment' }, 400);
      }
      const organisation = { id: directory.id, name: directory.name };
      const team = directoryTeam ? { id: directoryTeam.id, name: directoryTeam.name } : null;
      const saved = assign(target, assigned, organisation, team, nextMonth());
      saved.updated_at = new Date().toISOString();
      return json(route, saved);
    }
    if (request.method() === 'DELETE' && match[2]) {
      writes.push({ method: 'DELETE', path, body: null });
      target.assignments = target.assignments.filter((entry) => entry.id !== match[2]);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  return {
    writes,
    refuseNextSave: () => {
      refuseNextSave = true;
    },
  };
}
