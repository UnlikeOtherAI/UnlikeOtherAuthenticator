import { randomBytes,randomUUID } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT,importJWK } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { seedOrganisationAddonInvoices } from './organisation-addon-invoice-fixture.js';
import { seedDomainSecret } from './domain-secret.js';
import { baseClientConfigPayload } from './test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { generateBillingAppKey,digestBillingAppKey,billingAppKeyDisplayPrefix } from '../../src/utils/billing-app-key.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { sealEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { issueTokenPairForUser } from '../../src/services/token.service.js';
import { prepareStripePaymentInvoice,persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { getEnv } from '../../src/config/env.js';
import { computeJwkFingerprint,parsePublicRsaJwk } from '../../src/services/client-jwk.service.js';
import { ORG_SUBJECT_ASSERTION_AUDIENCE } from '../../src/middleware/org-role-guard.js';

/** Synthetic identities and provider objects; actual signatures, current UOA
 * authority, source assurance families, financial guards and HTTP routes. */
export async function seedOrganisationHttpFixture(db:PrismaClient,input:{publicBaseUrl:string;storage:BillingInvoicePdfStorage}) {
  const now=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(now);end.setUTCMonth(end.getUTCMonth()+1);
  const month=now.toISOString().slice(0,7);
  const seed=await seedOrganisationAddonInvoices(db,{providerSpies:false,product:'nessie',tariffHistoryFromMonth:month,period:{startsAt:now,endsAt:end,paidAt:now}});
  const tariff=await db.billingTariff.create({data:{serviceId:seed.credential.serviceId,key:'standard',version:1,name:'Standard',mode:'STANDARD',
    collectionMode:'STRIPE',usagePaymentMode:'PREPAID',currency:'EUR',markupBps:3000,monthlyAmountMinor:299n,isDefault:true}});
  // Known opening terms for this newly created synthetic service, not a
  // production history backfill or a relaxation of the tariff reader.
  await db.billingTariffTermEvent.create({data:{serviceId:seed.credential.serviceId,source:'SERVICE_DEFAULT',scopeKey:seed.credential.serviceId,
    effectiveFromMonth:month,tariffId:tariff.id,reason:'synthetic-known-opening-terms'}});
  const domain='control.example.com',issuer=`https://${domain}`,configUrl=`${issuer}/auth/config`,domainSecret=randomBytes(32).toString('base64url');
  const domainBearer=await seedDomainSecret(db,domain,domainSecret);
  await db.enterpriseProductReadiness.create({data:{clientDomain:domain,minimumAssuranceVersion:1}});
  for(const [id,role,name] of [['http-org-admin','admin','Org administrator'],['http-team-manager','member','Cross-team manager'],
    ['http-member','member','Member']] as const){
    await db.user.create({data:{id,email:`${id}@example.test`,userKey:`${id}@example.test`,name}});
    await db.orgMember.create({data:{orgId:'control-org',userId:id,role}});
  }
  await db.teamMember.createMany({data:[{teamId:'control-team',userId:'http-team-manager',teamRole:'member'},
    {teamId:'addon-other-team',userId:'http-team-manager',teamRole:'admin'},
    {teamId:'control-team',userId:'http-member',teamRole:'member'}]});
  const pair=await generateKeyPair('RS256'),kid='organisation-http-actor';
  const actorPrivateJwk={...await exportJWK(pair.privateKey),kid,alg:'RS256',use:'sig'},actorPublicJwk={...await exportJWK(pair.publicKey),kid,alg:'RS256',use:'sig'};
  await db.clientDomainJwk.create({data:{domainId:(await db.clientDomain.findUniqueOrThrow({where:{domain}})).id,kid,
    jwk:actorPublicJwk,fingerprint:computeJwkFingerprint(parsePublicRsaJwk(actorPublicJwk))}});
  const appKey=generateBillingAppKey();
  await db.billingAppKey.update({where:{id:seed.credential.id},data:{keyPrefix:billingAppKeyDisplayPrefix(appKey),secretDigest:digestBillingAppKey(appKey),
    actorIssuer:issuer,actorAudience:input.publicBaseUrl,actorKeyId:kid,actorPublicJwk}});
  const config=validateConfigFields(baseClientConfigPayload({domain,org_features:{enabled:true,teams_enabled:true}}));
  const personas:Record<string,{userId:string;teamId:string;organisationId:string;tokenVersion:number;assuranceRef:string;
    assuranceId:string;familyId:string;refreshToken:string;accessToken:string;assuranceExpiresAt:string}>= {};
  for(const [name,userId,teamId] of [['ownerA','control-owner','control-team'],['ownerB','control-owner','addon-other-team'],
    ['adminA','http-org-admin','control-team'],['adminB','http-org-admin','addon-other-team'],
    ['managerA','http-team-manager','control-team'],['managerB','http-team-manager','addon-other-team'],
    ['memberA','http-member','control-team']] as const){
    await db.domainRole.upsert({where:{domain_userId:{domain,userId}},create:{domain,userId,role:'USER'},update:{}});
    const familyId=randomUUID(),expiresAt=new Date(now.getTime()+6*60*60_000);
    const family=await issueRefreshToken({familyId,userId,domain,clientId:domainBearer,configUrl,orgId:'control-org',teamId,twoFaCompleted:false},
      {prisma:db,refreshTokenTtlDays:1});
    const proof=await db.$transaction(tx=>issueSessionAssurance({familyId,userId,clientDomain:domain,credentialEpoch:0,orgId:'control-org',teamId,
      method:'independent',observedAt:now,authenticatedAt:now,mfaSource:'none',amr:['pwd'],expiresAt,policyGeneration:0},tx));
    await db.refreshToken.update({where:{id:family.refreshTokenId},data:{assuranceId:proof.assurance.id,
      encryptedAssuranceReference:await sealEnterpriseSecret(proof.reference,`assurance:${proof.assurance.id}`)}});
    const tokens=await issueTokenPairForUser({config,configUrl,clientId:domainBearer,refreshToken:family.refreshToken,
      refreshTokenExpiresInSeconds:family.expiresInSeconds,userId,active:{orgId:'control-org',teamId}},
      {prisma:db,adminPrisma:db});
    personas[name]={userId,teamId,organisationId:'control-org',tokenVersion:0,assuranceRef:proof.reference,assuranceId:proof.assurance.id,
      familyId,refreshToken:family.refreshToken,accessToken:tokens.accessToken,assuranceExpiresAt:expiresAt.toISOString()};
  }
  const pdf=await PDFDocument.create();pdf.addPage().drawText('Synthetic UOA organisation invoice — local verification');
  const bytes=Buffer.from(await pdf.save());
  for(const source of seed.sources){
    const prepared=await prepareStripePaymentInvoice(source.invoice.id,seed.account,db,seed.stripe);
    if(!prepared)throw Error('SYNTHETIC_INVOICE_SOURCE_REQUIRED');
    const row=await db.$transaction(tx=>persistStripePaymentInvoice(tx,prepared));
    await issueStripePaymentInvoice(row.id,{prisma:db,stripe:seed.stripe,account:seed.account,storage:input.storage,download:async()=>new Response(bytes)});
  }
  const privateKey=await importJWK(actorPrivateJwk,'RS256');
  const jwksUrl=`${issuer}/.well-known/jwks.json`;
  const configJwt=await new SignJWT(baseClientConfigPayload({domain,jwks_url:jwksUrl,org_features:{enabled:true}}))
    .setProtectedHeader({alg:'RS256',kid}).setAudience(new URL(input.publicBaseUrl).host).sign(privateKey);
  const signSubject=async(name:string,claims:Record<string,unknown>={})=>{
    const p=personas[name];if(!p)throw Error('UNKNOWN_PERSONA');
    return new SignJWT({source_domain:domain,tv:p.tokenVersion,assurance_ref:p.assuranceRef,
      active:{orgId:p.organisationId,teamId:p.teamId},...claims}).setProtectedHeader({alg:'RS256',kid})
      .setIssuer(domain).setAudience(ORG_SUBJECT_ASSERTION_AUDIENCE).setSubject(p.userId)
      .setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(privateKey);
  };
  const sign=async(name:string,path:string,body:{product:string;organisation_id:string;team_id:string|null;user_id:string},
    options:{financial?:boolean;claims?:Record<string,unknown>;audience?:string}={})=>{
    const persona=personas[name];if(!persona)throw Error('UNKNOWN_PERSONA');
    return new SignJWT({product:body.product,organisation_id:body.organisation_id,team_id:body.team_id,tv:persona.tokenVersion,
      assurance_ref:persona.assuranceRef,assurance_version:1,assurance_method:'independent',
      ...(options.financial===false?{}:{financial_scope:'organisation'}),...options.claims})
      .setProtectedHeader({alg:'RS256',kid}).setIssuer(issuer).setAudience(options.audience??`${input.publicBaseUrl}${path}`)
      .setSubject(body.user_id).setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(privateKey);
  };
  return {seed,personas,appKey,actorPrivateJwk,actorPublicJwk,issuer,domain,domainSecret,domainBearer,configUrl,config,configJwt,jwksUrl,sign,signSubject,
    publicBaseUrl:input.publicBaseUrl,sharedSecret:getEnv().SHARED_SECRET};
}
