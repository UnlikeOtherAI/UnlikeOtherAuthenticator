import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { compareBillingCycleUtf8 } from '../../src/services/billing-cycle-binary-order.service.js';
import { billingCycleSnapshotDigest } from '../../src/services/billing-cycle-read.service.js';
import { cycleUsageContentFingerprint } from '../../src/services/billing-cycle-usage-projection.service.js';

describe('unreleased cycle financial evidence ordering', () => {
  it('orders UTF-8 bytes rather than host locale for snapshot keys and team identities', () => {
    const names = ['ä', 'z', 'A'];
    expect(names.sort(compareBillingCycleUtf8)).toEqual(['A', 'z', 'ä']);
    const publicSnapshot = { ä: 'third', z: 'second', A: 'first' };
    const expected = createHash('sha256').update(
      '{"privateEvidence":{},"publicSnapshot":{"A":"first","z":"second","ä":"third"}}',
    ).digest('hex');
    expect(billingCycleSnapshotDigest(publicSnapshot, {})).toBe(expected);
    const rows = ['ä', 'z', 'A'].map((team_id) => ({
      team_id, content_sha256: `digest-${team_id}`, snapshot_id: 'snapshot',
      cursor: 'cursor', sha256: 'sha256', captured_at: '2026-10-01T00:00:00.000Z',
      line_count: 0, raw_lines: [],
    }));
    const usageExpected = createHash('sha256').update(JSON.stringify([
      { team_id: 'A', content_sha256: 'digest-A' },
      { team_id: 'z', content_sha256: 'digest-z' },
      { team_id: 'ä', content_sha256: 'digest-ä' },
    ])).digest('hex');
    expect(cycleUsageContentFingerprint(rows)).toBe(usageExpected);
  });
});
