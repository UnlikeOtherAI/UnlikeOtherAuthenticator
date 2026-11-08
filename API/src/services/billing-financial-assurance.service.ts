import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';

/** Financial scope never rewrites custody. Resolve the original UOA record,
 * then let the existing assurance verifier check its entire live family/chain. */
export async function financialAssuranceCustodyTeam(params: {
  reference:string;userId:string;organisationId:string;clientDomain:string;credentialEpoch:number;
},db:PrismaClient|Prisma.TransactionClient):Promise<string|null> {
  const source=await db.sessionAssurance.findUnique({where:{referenceHash:hashAssuranceReference(params.reference)},
    select:{userId:true,orgId:true,teamId:true,clientDomain:true,credentialEpoch:true}});
  if(!source||source.userId!==params.userId||source.orgId!==params.organisationId||
    source.clientDomain!==params.clientDomain||source.credentialEpoch!==params.credentialEpoch) {
    throw new AppError('UNAUTHORIZED',401,'INVALID_SESSION_ASSURANCE');
  }
  return source.teamId;
}
