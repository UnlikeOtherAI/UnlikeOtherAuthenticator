import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { correctionFixture } from '../helpers/stripe-correction-fixture.js';
import { ids } from './billing-org-responsibility.persistence.fixture.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { beginTeamArchive } from '../../src/services/team-archive.service.js';
import { withUnarchivedSubscriptionEffect } from '../../src/services/team-billing-effect.service.js';
import { collectStripeCorrectionInvoice } from '../../src/services/billing-stripe-correction-invoice.service.js';

describe.skipIf(!process.env.DATABASE_URL)('archive collection fencing', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let fixture: Awaited<ReturnType<typeof correctionFixture>>;
  beforeAll(async () => { db = (await createTestDb())!; fixture = await correctionFixture(db.prisma); });
  afterAll(async () => { await db?.cleanup(); });
  it('drains an admitted collection and prevents cancellation recovery from starting collection again', async () => {
    const domain = 'org-billing.example.com', token = 'c'.repeat(64);
    const client = await db.prisma.clientDomain.create({ data: { domain, label: 'Collection archive test' } });
    await db.prisma.clientDomainSecret.create({ data: { domainId: client.id,
      secretDigest: digestDomainClientHash(token), hashPrefix: token.slice(0, 16) } });
    const owner = await db.prisma.user.findUniqueOrThrow({ where: { id: ids.owner } });
    await db.prisma.team.update({ where: { id: ids.teamA }, data: { lifecycleStatus: 'DISABLED' } });
    await expect(withUnarchivedSubscriptionEffect(db.prisma, fixture.sub.id, async () => 'earned liability'))
      .resolves.toBe('earned liability');
    await db.prisma.team.update({ where: { id: ids.teamA }, data: { lifecycleStatus: 'ACTIVE' } });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const inFlight = withUnarchivedSubscriptionEffect(db.prisma, fixture.sub.id, async () => { entered(); await hold; });
    await started;
    let archived = false;
    const archive = beginTeamArchive({ id: randomUUID(), orgId: ids.org, teamId: ids.teamA, domain, domainToken: token,
      config: validateConfigFields(baseClientConfigPayload({ domain })), claims: {
        userId: owner.id, tokenVersion: owner.tokenVersion, email: owner.email!, domain, clientId: token, role: 'user',
        org: { org_id: ids.org, org_role: 'owner', teams: [ids.teamA], team_roles: {} }, active: { orgId: ids.org, teamId: ids.teamA },
      },
    }, { prisma: db.prisma }).then(value => { archived = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 50)); expect(archived).toBe(false); }
    finally { release(); }
    await inFlight;
    await archive;
    const collection = vi.fn();
    await expect(withUnarchivedSubscriptionEffect(db.prisma, fixture.sub.id, collection))
      .rejects.toThrow('ARCHIVE_BILLING_COLLECTION_HELD');
    expect(collection).not.toHaveBeenCalled();
    await expect(collectStripeCorrectionInvoice({ closeId: fixture.close.id,
      amountMicroMinor: 130_000_000n, cursor: 'bus_correction_1' }, { prisma: db.prisma, stripe: fixture.stripe }))
      .rejects.toThrow('ARCHIVE_BILLING_COLLECTION_HELD');
    expect(fixture.client.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(fixture.client.invoices.update).not.toHaveBeenCalled();
    expect(fixture.client.invoices.create).not.toHaveBeenCalled();
    expect((await db.prisma.team.findUniqueOrThrow({ where: { id: ids.teamB } })).lifecycleStatus).toBe('ACTIVE');
  });
});
