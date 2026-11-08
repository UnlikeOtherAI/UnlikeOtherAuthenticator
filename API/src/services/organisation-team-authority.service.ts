import type { Prisma } from '@prisma/client';

/** Current UOA authority, not a synthetic TeamMember. An active org manager
 * may select any ACTIVE team in that exact organisation; everyone else needs
 * their own ACTIVE membership of the selected team. */
export function activeTeamAuthorityWhere(userId:string):Prisma.TeamWhereInput {
  return {lifecycleStatus:'ACTIVE',org:{lifecycleStatus:'ACTIVE',members:{some:{
    userId,status:'ACTIVE',user:{lifecycleStatus:'ACTIVE'}}}},OR:[
    {members:{some:{userId,status:'ACTIVE'}}},
    {org:{OR:[{ownerId:userId},{members:{some:{userId,status:'ACTIVE',role:{in:['owner','admin']}}}}]}},
  ]};
}
export function isCurrentOrganisationManager(member:{status:string;role:string;org:{ownerId:string|null}},userId:string) {
  return member.status==='ACTIVE'&&(member.org.ownerId===userId||member.role==='owner'||member.role==='admin');
}
