import { beforeEach,describe,expect,it,vi } from 'vitest';
import { billingOrganisationOverviewV1ConformanceFixture as fixture } from '../../src/contracts/billing-statement-v1.js';
import type { PrismaClient } from '@prisma/client';
import type { OrganisationBillingContext } from '../../src/services/billing-organisation-authority.service.js';
import { AppError } from '../../src/utils/errors.js';
const mocks=vi.hoisted(()=>({authority:vi.fn(),mode:vi.fn()}));
vi.mock('../../src/services/billing-organisation-authority.service.js',()=>({authorizeOrganisationBilling:mocks.authority}));
vi.mock('../../src/services/billing-organisation-mode.service.js',()=>({resolveOrganisationBillingMode:mocks.mode}));
import { organisationBillingCapabilities,organisationBillingOverview } from '../../src/services/billing-organisation-overview.service.js';

const context={request:{product:'deepwater',organisationId:'org_example',teamId:'team_example',userId:'user_example'},
  credential:{id:'lifecycle-key'},actorToken:'original-actor',endpoint:'/billing/v1/organisation/overview'} as OrganisationBillingContext;
function data<K extends 'credits'|'funding'|'subscription'>(key:K) {
  const section=fixture.sections[key];if(section.state!=='confirmed')throw new Error('Fixture must be confirmed');return section.data;
}
const deps={prisma:{} as PrismaClient,now:new Date('2026-11-08T00:00:00Z'),
  balance:vi.fn(async()=>data('credits')),funding:vi.fn(async()=>data('funding')),
  subscription:vi.fn(async()=>data('subscription')),
  bill:vi.fn(async()=>{throw new AppError('INTERNAL',502,'LEDGER_METERING_PORTFOLIO_RESPONSE_INVALID');})};
beforeEach(()=>{
  vi.clearAllMocks();mocks.authority.mockResolvedValue({billingManager:true});
  mocks.mode.mockResolvedValue({mode:'live',revision:0,epoch:'2026-11-07T22:00:00.000Z'});
});
describe('independent organisation overview',()=>{
  it('keeps confirmed balance and controls when metering fails, without a numeric bill',async()=>{
    const result=await organisationBillingOverview(context,{},deps);
    expect(result.sections.accrued_bill).toEqual({state:'unavailable',code:'LEDGER_METERING_PORTFOLIO_RESPONSE_INVALID',
      message:'This section is temporarily unavailable. Try again.'});
    for(const key of ['credits','funding','subscription','history'] as const)expect(result.sections[key].state).toBe('confirmed');
    expect(result.sections.credits).toMatchObject({data:data('credits')});
    expect(result.sections.accrued_bill).not.toHaveProperty('data');
    expect(result.sections.history).toMatchObject({data:{captured_sources:[{mode:'live'},{mode:'sandbox'}]}});
  });
  it('returns the inclusive hold as pending, never zero',async()=>{
    const result=await organisationBillingOverview(context,{}, {...deps,bill:async()=>{
      throw new AppError('BAD_REQUEST',409,'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');}});
    expect(result.sections.accrued_bill.state).toBe('pending_reconciliation');
    expect(result.sections.accrued_bill).not.toHaveProperty('data');
  });
  it('denies members before touching financial dependencies; capability remains lightweight',async()=>{
    mocks.authority.mockResolvedValue({billingManager:false});
    const capability=await organisationBillingCapabilities(context,{prisma:deps.prisma});
    expect(capability.capabilities).toEqual({can_view_billing:false,can_manage_billing:false});
    expect(capability).not.toHaveProperty('financial_scope');expect(mocks.mode).not.toHaveBeenCalled();
    await expect(organisationBillingOverview(context,{},deps)).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    expect(deps.balance).not.toHaveBeenCalled();expect(deps.bill).not.toHaveBeenCalled();
  });
  it('refuses publication after authority loss or a concurrent policy change',async()=>{
    mocks.authority.mockResolvedValueOnce({billingManager:true}).mockResolvedValueOnce({billingManager:false});
    await expect(organisationBillingOverview(context,{},deps)).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    mocks.authority.mockResolvedValue({billingManager:true});mocks.mode.mockResolvedValueOnce({mode:'live',revision:0,
      epoch:'2026-11-07T22:00:00.000Z'}).mockResolvedValueOnce({mode:'sandbox',revision:1,epoch:'2026-11-07T22:00:00.000Z'});
    await expect(organisationBillingOverview(context,{},deps)).rejects.toThrow('BILLING_CONTEXT_STALE');
  });
});
