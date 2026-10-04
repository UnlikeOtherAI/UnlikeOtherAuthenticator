import { describe, expect, it, vi } from 'vitest';

import {
  fetchLedgerHistoricalBillingTeams, parseHistoricalBillingTeams,
} from '../../src/services/billing-ledger-team-discovery.service.js';

const expected = { product: 'deepwater', organisationId: 'org-1',
  billingMonth: '2026-09' };
const row = (dimension: string | null) => ({
  billingProduct: 'deepwater', callerProduct: 'deepwater',
  originProduct: 'deepwater', serviceId: 'model-1', usageUnit: 'tokens',
  calls: '1', rawProviderUsage: { unitsIn: '100', unitsCachedIn: '0', unitsOut: '50' },
  dimension, billingDisposition: 'paid', costProvenance: 'actual',
  rawProviderCurrency: 'USD', rawProviderEstimatedCost: null,
  rawProviderActualCost: '10', rawProviderSelectedCost: '10',
});
const value = {
  schemaVersion: 1, product: 'deepwater', groupBy: 'team',
  scope: { organizationId: 'org-1', teamId: null, userId: null, month: '2026-09',
    startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' },
  totals: { calls: '2', usageByService: [], costs: [] },
  billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
  breakdown: [row('historical-team-b'), row('historical-team-a')],
  snapshot: { cursor: `mus_${'a'.repeat(32)}`, id: `mus_${'a'.repeat(32)}`,
    capturedAt: '2026-10-03T00:00:00.000Z', immutable: true },
};
const response = { value, sha256: 'c'.repeat(64) };

describe('signed organisation Ledger team discovery', () => {
  it('enumerates source IDs from exact org-scoped immutable dimensions', async () => {
    const fetchRaw = vi.fn().mockResolvedValue(response);
    const discovered = await fetchLedgerHistoricalBillingTeams(expected,
      { fetchRaw });
    expect(fetchRaw).toHaveBeenCalledWith({ ...expected, teamId: null,
      groupBy: 'team' });
    expect(discovered.teamIds).toEqual(['historical-team-a', 'historical-team-b']);
    expect(discovered.snapshot.sha256).toBe('c'.repeat(64));
  });

  it('holds unknown paid attempts, missing team attribution and wrong scope', () => {
    expect(() => parseHistoricalBillingTeams({ ...response, value: { ...value,
      billingCompleteness: { state: 'unresolved', unresolvedPaidAttempts: '1' } } },
    expected)).toThrow('BILLING_CYCLE_LEDGER_COVERAGE_UNRESOLVED');
    expect(() => parseHistoricalBillingTeams({ ...response, value: { ...value,
      breakdown: [row(null)] } }, expected))
      .toThrow('BILLING_CYCLE_TEAM_ATTRIBUTION_MISSING');
    expect(() => parseHistoricalBillingTeams({ ...response, value: { ...value,
      scope: { ...value.scope, organizationId: 'another-org' } } }, expected))
      .toThrow('LEDGER_METERING_TEAM_SCOPE_MISMATCH');
  });
});
