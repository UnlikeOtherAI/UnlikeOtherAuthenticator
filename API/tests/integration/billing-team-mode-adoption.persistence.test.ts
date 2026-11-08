import type { PrismaClient } from '@prisma/client';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { readTeamBillingMode,setTeamBillingMode } from '../../src/services/billing-team-mode.service.js';
import { setOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { actor,financialSnapshot,ids,physicalAccount,seedAdoption,subject } from './billing-team-mode-adoption.fixture.js';

// Organisation billing supersedes the former first-TEAM-adoption exception.
// Preserve its actual historical fixture; neither setting may adopt that money.
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('retired TEAM adoption preserves original financial sources',()=>{
  let db:PrismaClient,cleanup:()=>Promise<void>;
  beforeAll(async()=>{
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID',physicalAccount);
    vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY','rk_test_synthetic');vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET','whsec_synthetic');
    const handle=await createTestDb();if(!handle)throw Error('Disposable PG required');db=handle.prisma;cleanup=handle.cleanup;
    await seedAdoption(db);
  });
  afterAll(async()=>{await cleanup?.();vi.unstubAllEnvs();});
  it('refuses either TEAM setting and direct policy inserts without changing balance, consent or pending recovery',async()=>{
    const before=await financialSnapshot(db);
    expect(before.wallets.find(row=>row.id===ids.creditAccount)).toMatchObject({scope:'TEAM',balanceMicrocredits:3000000000n,
      autoTopUpConsentRevisionId:ids.originalConsent,autoTopUpState:'ACTIVE'});
    expect(before.setups[0]?.status).toBe('OPEN');
    for(const mode of ['sandbox','live'] as const)await expect(setTeamBillingMode({...subject,actor,mode,expectedRevision:0},db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_REQUIRED');
    await expect(db.billingTeamMode.create({data:{teamId:ids.team,sandbox:true,adoptedStripeAccountId:physicalAccount}}))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
    expect(await financialSnapshot(db)).toEqual(before);
    expect(await db.billingTeamMode.count()).toBe(0);expect(await db.billingTeamModeEvent.count()).toBe(0);
    expect(await db.adminAuditLog.count({where:{action:'billing.team_mode_changed'}})).toBe(0);
  });
  it('holds explicit ORG Sandbox selection rather than pooling or adopting retained positive TEAM funds',async()=>{
    const before=await financialSnapshot(db);
    expect(await readTeamBillingMode(subject,db)).toMatchObject({mode:'live',revision:0,controlling_scope:'organisation'});
    await expect(setOrganisationBillingMode({organisationId:ids.org,actor,mode:'sandbox',expectedRevision:0},db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_BLOCKED');
    expect(await financialSnapshot(db)).toEqual(before);
    expect(await db.billingOrganisationMode.count()).toBe(0);
    expect(await db.billingCreditAccount.count({where:{scope:'ORGANISATION'}})).toBe(0);
  });
});
