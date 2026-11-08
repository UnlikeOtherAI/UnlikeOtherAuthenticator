import type { Prisma, PrismaClient } from '@prisma/client';

export function activeAuthorityUserWhere(now=new Date()):Pick<Prisma.UserWhereInput,'lifecycleStatus'|'OR'> {
  return {lifecycleStatus:'ACTIVE',OR:[{accountExpiresAt:null},{accountExpiresAt:{gt:now}}]};
}

/** Current UOA authority, not a synthetic TeamMember. An active org manager
 * may select any ACTIVE team in that exact organisation; everyone else needs
 * their own ACTIVE membership of the selected team. */
export function activeTeamAuthorityWhere(userId:string):Prisma.TeamWhereInput {
  return {lifecycleStatus:'ACTIVE',org:{lifecycleStatus:'ACTIVE',members:{some:{
    userId,status:'ACTIVE',user:activeAuthorityUserWhere()}}},OR:[
    {members:{some:{userId,status:'ACTIVE'}}},
    {org:{OR:[{ownerId:userId},{members:{some:{userId,status:'ACTIVE',role:{in:['owner','admin']}}}}]}},
  ]};
}

/** Selectable teams granted by current org authority. This never creates or
 * reports a TeamMember; the effective role comes from the owning organisation. */
export async function organisationManagedTeams(prisma:Pick<PrismaClient,'team'>,
  input:{userId:string;domain?:string;organisationId?:string}) {
  const teams=await prisma.team.findMany({where:{lifecycleStatus:'ACTIVE',
    ...(input.organisationId?{orgId:input.organisationId}:{}),org:{lifecycleStatus:'ACTIVE',
      ...(input.domain?{domain:input.domain}:{}),members:{some:{userId:input.userId,status:'ACTIVE',
        user:activeAuthorityUserWhere()}},OR:[{ownerId:input.userId},
        {members:{some:{userId:input.userId,status:'ACTIVE',role:{in:['owner','admin']}}}}]}},
    select:{id:true,orgId:true,name:true,slug:true,iconUrl:true,updatedAt:true,org:{select:{
      name:true,slug:true,ownerId:true,members:{where:{userId:input.userId,status:'ACTIVE'},select:{role:true}}}}},
    orderBy:{id:'asc'}});
  return teams.map(team=>({teamId:team.id,teamRole:team.org.ownerId===input.userId?'owner':team.org.members[0].role,team}));
}
export function isCurrentOrganisationManager(member:{status:string;role:string;org:{ownerId:string|null}},userId:string) {
  return member.status==='ACTIVE'&&(member.org.ownerId===userId||member.role==='owner'||member.role==='admin');
}
