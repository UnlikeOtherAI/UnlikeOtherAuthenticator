import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { BILLING_ORGANISATION_CAPABILITIES_PATH,BILLING_ORGANISATION_OVERVIEW_PATH,
  BILLING_ORGANISATION_SCHEMA_PATH,BILLING_ORGANISATION_EXAMPLE_PATH,BILLING_ORGANISATION_OPENAPI_PATH,
  BILLING_ORGANISATION_FINANCIAL_SCHEMA_PATH,billingOrganisationProtocolV1JsonSchema,
  billingOrganisationFinancialV1JsonSchema,billingOrganisationV1OpenApiDocument,
  billingOrganisationOverviewV1ConformanceFixture,billingOrganisationCapabilitiesV1JsonSchema,
  billingOrganisationOverviewV1JsonSchema,billingOrganisationFinancialV1Schemas,
  BILLING_AUTHORITY_PROTOCOL_HEADER,BILLING_AUTHORITY_PROTOCOL_VERSION,
  BILLING_AUTHORITY_SCHEMA_PATH,BILLING_AUTHORITY_EXAMPLE_PATH,BILLING_AUTHORITY_OPENAPI_PATH,
  BILLING_TEAM_OVERVIEW_PATH,billingAuthorityV1JsonSchema,billingAuthorityV1OpenApiDocument,
  billingCapabilitiesV2ConformanceFixtures,billingTeamOverviewV1ConformanceFixture,
  billingCapabilitiesV2JsonSchema,billingTeamOverviewV1JsonSchema }
  from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { organisationBillingCapabilities,organisationBillingOverview } from '../../services/billing-organisation-overview.service.js';
import { billingCapabilities } from '../../services/billing-capabilities.service.js';
import { billingTeamOverview } from '../../services/billing-team-overview.service.js';
import { authorizeOrganisationBilling,type OrganisationBillingContext } from '../../services/billing-organisation-authority.service.js';
import { billingRegionView,setOrganisationBillingRegion } from '../../services/billing-organisation-region.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema,BillingFinancialSubjectRequestSchema,readBillingActorHeader } from './billing-request.js';
import { readBillingPresentation } from './billing-presentation.js';

const validator=new Ajv2020({allErrors:true,strict:true});ajvFormats.default.default(validator);
const capabilities=validator.compile(billingOrganisationCapabilitiesV1JsonSchema);
const authority=validator.compile(billingCapabilitiesV2JsonSchema);
const teamOverview=validator.compile(billingTeamOverviewV1JsonSchema);
const overview=validator.compile(billingOrganisationOverviewV1JsonSchema);
const region=validator.compile(billingOrganisationFinancialV1Schemas.region_response);
const overviewRequest=BillingFinancialSubjectRequestSchema.extend({
  billing_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
const regionRequest=BillingFinancialSubjectRequestSchema.extend({region:z.enum(['US','UK','EUROPE']).optional()}).strict();
const teamOverviewRequest=BillingSubjectRequestSchema.extend({billing_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
function context(request:FastifyRequest,body:z.infer<typeof BillingFinancialSubjectRequestSchema>,
  endpoint:OrganisationBillingContext['endpoint']):OrganisationBillingContext {
  if(!request.billingAppKey)throw new AppError('UNAUTHORIZED',401);
  return {credential:request.billingAppKey,actorToken:readBillingActorHeader(request.headers['x-uoa-actor']),endpoint,
    request:{product:body.product,organisationId:body.organisation_id,teamId:body.team_id,userId:body.user_id}};
}
function contract(value:unknown,validate:(data:unknown)=>boolean){
  if(!validate(value))throw new AppError('INTERNAL',503,'BILLING_ORGANISATION_CONTRACT_INVALID');
}
export function registerOrganisationBillingRoutes(app:FastifyInstance):void {
  const assets=[
    [BILLING_ORGANISATION_SCHEMA_PATH,billingOrganisationProtocolV1JsonSchema],
    [BILLING_ORGANISATION_FINANCIAL_SCHEMA_PATH,billingOrganisationFinancialV1JsonSchema],
    [BILLING_ORGANISATION_EXAMPLE_PATH,billingOrganisationOverviewV1ConformanceFixture],
    [BILLING_ORGANISATION_OPENAPI_PATH,billingOrganisationV1OpenApiDocument],
    [BILLING_AUTHORITY_SCHEMA_PATH,billingAuthorityV1JsonSchema],
    [BILLING_AUTHORITY_OPENAPI_PATH,billingAuthorityV1OpenApiDocument],
    [BILLING_AUTHORITY_EXAMPLE_PATH,{capabilities:billingCapabilitiesV2ConformanceFixtures,
      team_overview:billingTeamOverviewV1ConformanceFixture}],
  ] as const;
  for(const [path,value] of assets)app.get(path,async(_request,reply)=>
    reply.header('Cache-Control','public, max-age=300').type('application/json').send(value));
  app.post(BILLING_ORGANISATION_CAPABILITIES_PATH,{preHandler:[requireBillingLifecycleAppKey]},async(request,reply)=>{
    const body=BillingFinancialSubjectRequestSchema.parse(request.body);
    const header=request.headers[BILLING_AUTHORITY_PROTOCOL_HEADER.toLowerCase()];
    if(header!==undefined&&header!==BILLING_AUTHORITY_PROTOCOL_VERSION)throw new AppError('BAD_REQUEST',400,'BILLING_AUTHORITY_PROTOCOL_UNSUPPORTED');
    const actor=context(request,body,BILLING_ORGANISATION_CAPABILITIES_PATH);
    const value=header?await billingCapabilities(actor):await organisationBillingCapabilities(actor);
    contract(value,header?authority:capabilities);return reply.header('Cache-Control','private, no-store').send(value);
  });
  app.post(BILLING_TEAM_OVERVIEW_PATH,{preHandler:[requireBillingLifecycleAppKey]},async(request,reply)=>{
    const body=teamOverviewRequest.parse(request.body),presentation=readBillingPresentation(request.headers);
    const value=await billingTeamOverview(context(request,body,BILLING_TEAM_OVERVIEW_PATH),
      {month:body.billing_month,locale:presentation.enabled?presentation.locale:undefined});
    contract(value,teamOverview);return reply.header('Cache-Control','private, no-store').send(value);
  });
  app.post(BILLING_ORGANISATION_OVERVIEW_PATH,{preHandler:[requireBillingLifecycleAppKey]},async(request,reply)=>{
    const body=overviewRequest.parse(request.body);const presentation=readBillingPresentation(request.headers);
    const value=await organisationBillingOverview(context(request,body,BILLING_ORGANISATION_OVERVIEW_PATH),
      {month:body.billing_month,locale:presentation.enabled?presentation.locale:undefined});
    contract(value,overview);return reply.header('Cache-Control','private, no-store').send(value);
  });
  app.post('/billing/v1/organisation/region',{preHandler:[requireBillingLifecycleAppKey]},async(request,reply)=>{
    const body=regionRequest.parse(request.body);const actor=context(request,body,'/billing/v1/organisation/region');
    const viewer=await authorizeOrganisationBilling(actor);
    if(!viewer.billingManager)throw new AppError('FORBIDDEN',403,'BILLING_MANAGER_REQUIRED');
    const value=body.region?await setOrganisationBillingRegion({...actor,region:body.region}):
      await billingRegionView(body.organisation_id,true);
    contract(value,region);return reply.header('Cache-Control','private, no-store').send(value);
  });
}
