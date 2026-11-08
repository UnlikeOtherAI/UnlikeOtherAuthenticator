import type { PrismaClient } from '@prisma/client';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { buildSessionChoices,shouldPresentTeamChooser } from '../../src/services/session-choices.service.js';
import { buildSidebarTeams } from '../../src/services/team-directory.service.js';
import { assertActiveTeamMembership } from '../../src/services/team-scope.service.js';
import { resolveBillingFundingViewer } from '../../src/services/billing-funding-viewer.service.js';
import { ensureUserHasRequiredTeam } from '../../src/services/user-team-requirement.service.js';
import { listTeams } from '../../src/services/team.service.teams.js';
import { getEnv } from '../../src/config/env.js';

describe.skipIf(!process.env.DATABASE_URL)('organisation team admission on PostgreSQL',()=>{
  let db:PrismaClient,cleanup:()=>Promise<void>;
  const domain='authority.example.test';
  const config=validateConfigFields({...baseClientConfigPayload({domain}),
    login_flow:{team_selection:'auto'},org_features:{enabled:true,allow_user_create_org:false,
      allow_user_create_team:true,user_needs_team:true}});
  const policy={scope:'all_active_memberships' as const,serviceId:'nessie',product:'nessie'};
  beforeAll(async()=>{
    const handle=await createRlsTestDb();if(!handle)throw Error('Disposable PG required');db=handle.prisma;cleanup=handle.cleanup;
    await db.user.createMany({data:['owner','admin','member','empty-owner'].map(id=>({id,email:`${id}@example.test`,userKey:id}))});
    await db.organisation.createMany({data:[{id:'authority-org',domain,name:'Authority',slug:'authority',ownerId:'owner'},
      {id:'empty-org',domain,name:'Empty',slug:'empty',ownerId:'empty-owner'}]});
    await db.orgMember.createMany({data:[{orgId:'authority-org',userId:'owner',role:'owner'},
      {orgId:'authority-org',userId:'admin',role:'admin'},{orgId:'authority-org',userId:'member',role:'member'},
      {orgId:'empty-org',userId:'empty-owner',role:'owner'}]});
    await db.team.createMany({data:['public','hidden','archived'].map(id=>({id,orgId:'authority-org',name:id,slug:id,
      joinPolicy:id==='hidden'?'HIDDEN':'INVITE_ONLY',lifecycleStatus:id==='archived'?'ARCHIVED':'ACTIVE'}))});
    await db.teamMember.create({data:{teamId:'public',userId:'member',teamRole:'member'}});
  });
  afterAll(async()=>{await cleanup?.();});
  const choices=(userId:string)=>buildSessionChoices({userId,config},{prisma:db,crossProductPrisma:db,policy});
  it('lists every active same-org team for org managers without membership writes',async()=>{
    for(const userId of ['owner','admin']){
      expect((await choices(userId)).teams.map(t=>t.teamId).sort()).toEqual(['hidden','public']);
      expect((await buildSidebarTeams({userId,domain},{prisma:db,crossProductPrisma:db,policy})).map(t=>t.teamId).sort())
        .toEqual(['hidden','public']);
      const directory=await listTeams({orgId:'authority-org',domain,actorUserId:userId},{prisma:db,env:getEnv()});
      expect(directory.data.map(t=>t.id).sort()).toEqual(['hidden','public']);
      await expect(assertActiveTeamMembership({orgId:'authority-org',teamId:'hidden',userId},{prisma:db})).resolves.toBeUndefined();
      expect((await resolveBillingFundingViewer({organisationId:'authority-org',teamId:'hidden',userId},{prisma:db})).billingManager).toBe(true);
      expect(await db.teamMember.count({where:{userId}})).toBe(0);
    }
  });
  it('keeps ordinary members selected-team bound and revokes effective authority immediately',async()=>{
    expect((await choices('member')).teams.map(t=>t.teamId)).toEqual(['public']);
    await expect(assertActiveTeamMembership({orgId:'authority-org',teamId:'hidden',userId:'member'},{prisma:db})).rejects.toThrow();
    await db.orgMember.update({where:{orgId_userId:{orgId:'authority-org',userId:'admin'}},data:{role:'member'}});
    expect((await choices('admin')).teams).toEqual([]);
    await expect(resolveBillingFundingViewer({organisationId:'authority-org',teamId:'hidden',userId:'admin'},{prisma:db})).rejects.toThrow();
    await db.orgMember.update({where:{orgId_userId:{orgId:'authority-org',userId:'admin'}},data:{role:'admin'}});
    await db.user.update({where:{id:'admin'},data:{accountExpiresAt:new Date('2000-01-01T00:00:00Z')}});
    expect((await choices('admin')).teams).toEqual([]);
    await expect(resolveBillingFundingViewer({organisationId:'authority-org',teamId:'hidden',userId:'admin'},{prisma:db})).rejects.toThrow();
    await expect(db.$executeRaw`SELECT billing_assert_credit_scope_manager('authority-org',NULL,'admin')`).rejects.toThrow('BILLING_MANAGER_REQUIRED');
  });
  it('offers explicit Create team recovery for an empty org and never auto-creates on login',async()=>{
    const before=await db.organisation.count();
    await expect(ensureUserHasRequiredTeam({userId:'empty-owner',config},{prisma:db,env:getEnv()})).resolves.toBeNull();
    const recovery=await choices('empty-owner');expect(recovery.teams).toEqual([]);
    expect(recovery.creatable_orgs).toEqual([{orgId:'empty-org',orgName:'Empty'}]);
    expect(recovery.can_create_org).toBe(false);expect(shouldPresentTeamChooser(recovery)).toBe(true);
    expect(await db.team.count({where:{orgId:'empty-org'}})).toBe(0);expect(await db.organisation.count()).toBe(before);
  });
});
