import { describe, expect, it } from 'vitest';

import type { BillingAssignment, BillingService, BillingTariff } from '../../schemas/billing';
import {
  billingActiveProducts,
  billingAssignableTariffs,
  billingAssignmentStartNote,
  billingOrganisationAssignmentCount,
  billingOrganisationListRows,
  billingOrganisationTariffRows,
  billingTariffChange,
} from './billing-organisation-tariffs';

const now = new Date('2026-11-16T12:00:00.000Z');

function tariff(id: string, name: string, extra: Partial<BillingTariff> = {}): BillingTariff {
  return {
    id, service_id: 'nessie', key: id, version: 1, name, mode: 'standard', collection_mode: 'stripe',
    markup_bps: 3000, markup_percent: '30', usage_payment_mode: 'prepaid', usage_currency: 'USD',
    monthly_subscription: { amount_minor: '399', currency: 'USD', charge_basis: 'per_seat',
      seat_policy: 'automatic', seat_charge_timing: 'full_month' },
    is_default: false, retired_at: null, retire_blocked_by: [], created_by_email: null,
    created_at: '2026-10-01T00:00:00.000Z', ...extra,
  };
}

function assignment(
  id: string,
  assigned: BillingTariff,
  organisation: { id: string; name: string },
  team: { id: string; name: string } | null = null,
  effectiveFrom: string | null = '2026-10',
): BillingAssignment {
  return {
    id, tariff_id: assigned.id, scope: team ? 'team' : 'organisation', organisation, team,
    tariff: assigned, effective_from_month: effectiveFrom, created_by_email: 'ops@example.test',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
  };
}

function service(id: string, name: string, tariffs: BillingTariff[], assignments: BillingAssignment[] = [],
  active = true): BillingService {
  return {
    id, identifier: id, name, active, tariffs, assignments, app_keys: [], adjustments: [],
    stripe_catalogs: [], stripe_subscriptions: [], created_at: '', updated_at: '',
  };
}

const acme = { id: 'o1', name: 'Acme', slug: 'acme' };
const beta = { id: 'o2', name: 'Beta Labs', slug: 'beta-labs' };
const organisations = [beta, acme];
const teams = [
  { id: 't2', orgId: 'o1', name: 'Zeta', members: 1 },
  { id: 't1', orgId: 'o1', name: 'Hugo', members: 4 },
  { id: 't3', orgId: 'o2', name: 'General', members: 2 },
];
const standard = tariff('standard', 'Standard', { is_default: true });
const free = tariff('free', 'Free', { mode: 'free', markup_bps: 0, collection_mode: 'none' });
const retired = tariff('legacy', 'Legacy', { retired_at: '2026-11-01T00:00:00.000Z' });
const nessie = service('nessie', 'Nessie', [standard, free, retired], [
  assignment('a1', free, acme),
  assignment('a2', standard, acme, { id: 't1', name: 'Hugo' }, '2026-12'),
]);
const deepwater = service('deepwater', 'DeepWater', [tariff('dw', 'Metered', { is_default: true })], [
  assignment('a3', free, acme, { id: 't2', name: 'Zeta' }),
]);
const archived = service('archived', 'Archived', [standard], [assignment('a4', free, beta)], false);
const services = [nessie, deepwater, archived];

describe('billingOrganisationListRows', () => {
  const rows = (overrides: Partial<Parameters<typeof billingOrganisationListRows>[0]> = {}) =>
    billingOrganisationListRows({ organisations, teams, services, productId: null, query: '', customOnly: false,
      ...overrides });

  it('describes every active product per organisation, sorted by name', () => {
    expect(rows()).toEqual([
      { id: 'o1', name: 'Acme', slug: 'acme', teamCount: 2, tariffLines: ['Nessie: Free'],
        tariffFallback: 'Product defaults', teamLines: ['2 teams'] },
      // The inactive product's assignment does not count.
      { id: 'o2', name: 'Beta Labs', slug: 'beta-labs', teamCount: 1, tariffLines: [],
        tariffFallback: 'Product defaults', teamLines: [] },
    ]);
  });

  it('describes one product: the tariff, its default and each team', () => {
    expect(rows({ productId: 'nessie' })).toEqual([
      expect.objectContaining({ id: 'o1', tariffLines: ['Free'], teamLines: ['Hugo: Standard'] }),
      expect.objectContaining({ id: 'o2', tariffLines: [], tariffFallback: 'Product default — Standard',
        teamLines: [] }),
    ]);
  });

  it('searches name and slug, and keeps custom tariffs in the selected product', () => {
    expect(rows({ query: 'LABS' }).map((row) => row.id)).toEqual(['o2']);
    expect(rows({ query: 'beta-' }).map((row) => row.id)).toEqual(['o2']);
    expect(rows({ customOnly: true }).map((row) => row.id)).toEqual(['o1']);
    expect(rows({ customOnly: true, productId: 'deepwater' }).map((row) => row.id)).toEqual(['o1']);
    expect(rows({ customOnly: true, productId: 'archived' }).map((row) => row.id)).toEqual(['o1']);
  });
});

describe('the organisation view', () => {
  it('lists active products by name and counts assignments per product', () => {
    expect(billingActiveProducts(services).map((entry) => entry.name)).toEqual(['DeepWater', 'Nessie']);
    expect(billingOrganisationAssignmentCount(nessie, 'o1')).toBe(2);
    expect(billingOrganisationAssignmentCount(nessie, 'o2')).toBe(0);
  });

  it('never offers a retired tariff', () => {
    expect(billingAssignableTariffs(nessie).map((entry) => entry.id)).toEqual(['free', 'standard']);
  });

  it('labels the fallback through the organisation, else the product default', () => {
    const { organisationRow, teamRows } = billingOrganisationTariffRows(nessie, acme, teams);
    expect(organisationRow.options.map((option) => option.label)).toEqual([
      'Product default — Standard', 'Free', 'Standard',
    ]);
    expect(organisationRow.savedValue).toBe('free');
    expect(teamRows.map((row) => [row.name, row.savedValue, row.options[0]?.label])).toEqual([
      ['Hugo', 'standard', 'Same as organisation — Free'],
      ['Zeta', '', 'Same as organisation — Free'],
    ]);
    const bare = billingOrganisationTariffRows(nessie, beta, teams);
    expect(bare.teamRows[0]?.options[0]?.label).toBe('Same as organisation — Standard');
    expect(bare.organisationRow.savedValue).toBe('');
  });

  it('notes a saved assignment that starts in a later month', () => {
    const { organisationRow, teamRows } = billingOrganisationTariffRows(nessie, acme, teams);
    expect(billingAssignmentStartNote(teamRows[0]?.assignment ?? null, now)).toBe('Starts 1 December 2026');
    expect(billingAssignmentStartNote(organisationRow.assignment, now)).toBeNull();
    expect(billingAssignmentStartNote(null, now)).toBeNull();
  });
});

describe('billingTariffChange', () => {
  const { organisationRow, teamRows } = billingOrganisationTariffRows(nessie, acme, teams);
  const hugo = teamRows[0];
  const zeta = teamRows[1];
  if (!hugo || !zeta) throw new Error('Missing team rows');

  it('asks before moving a team or the organisation', () => {
    expect(billingTariffChange(nessie, zeta, 'standard', now)).toEqual({
      kind: 'save', tariffId: 'standard', title: 'Move Zeta to Standard?',
      body: 'Zeta uses Standard for Nessie from 1 December 2026 (UTC). This month keeps its current terms.',
    });
    expect(billingTariffChange(nessie, organisationRow, 'standard', now)?.body).toBe(
      'Acme uses Standard for Nessie from 1 December 2026 (UTC). This month keeps its current terms. '
        + 'Teams with their own tariff are not affected.',
    );
  });

  it('removes an own tariff when the first option is chosen', () => {
    expect(billingTariffChange(nessie, hugo, '', now)).toEqual({
      kind: 'remove', assignmentId: 'a2', title: "Remove Hugo's own tariff?",
      body: 'From 1 December 2026 (UTC) Hugo uses Free.',
    });
    expect(billingTariffChange(nessie, organisationRow, '', now)?.body)
      .toBe('From 1 December 2026 (UTC) Acme uses Standard.');
  });

  it('does nothing when the selection is what is saved', () => {
    expect(billingTariffChange(nessie, hugo, 'standard', now)).toBeNull();
    expect(billingTariffChange(nessie, zeta, '', now)).toBeNull();
  });
});

describe('two active tariffs with one name', () => {
  const standardV2 = tariff('standard-2', 'Standard', { key: 'standard', version: 2 });
  const twins = service('nessie', 'Nessie', [standard, standardV2, free], [
    assignment('a1', standardV2, acme),
  ]);

  it('tells them apart by key and version wherever the organisation picks or sees one', () => {
    const { organisationRow, teamRows } = billingOrganisationTariffRows(twins, acme, teams);
    expect(organisationRow.options.map((option) => option.label)).toEqual([
      'Product default — Standard · standard v1', 'Free', 'Standard · standard v2', 'Standard · standard v1',
    ]);
    expect(teamRows[0]?.options[0]?.label).toBe('Same as organisation — Standard · standard v2');
    expect(billingOrganisationListRows({ organisations, teams, services: [twins], productId: 'nessie',
      query: '', customOnly: false })[0]?.tariffLines).toEqual(['Standard · standard v2']);
    expect(billingTariffChange(twins, organisationRow, 'standard', now)?.title)
      .toBe('Move Acme to Standard · standard v1?');
  });
});
