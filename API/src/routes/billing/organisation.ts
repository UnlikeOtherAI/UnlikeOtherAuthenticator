import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { BILLING_ORGANISATION_CAPABILITIES_PATH,BILLING_ORGANISATION_OVERVIEW_PATH,
  BILLING_ORGANISATION_SCHEMA_PATH,BILLING_ORGANISATION_EXAMPLE_PATH,BILLING_ORGANISATION_OPENAPI_PATH,
  BILLING_ORGANISATION_FINANCIAL_SCHEMA_PATH,billingOrganisationProtocolV1JsonSchema,
  billingOrganisationFinancialV1JsonSchema,billingOrganisationV1OpenApiDocument,
  billingOrganisationOverviewV1ConformanceFixture,billingOrganisationCapabilitiesV1JsonSchema,
  billingOrganisationOverviewV1JsonSchema,billingOrganisationFinancialV1Schemas }
  from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { organisationBillingCapabilities,organisationBillingOverview } from '../../services/billing-organisation-overview.service.js';
import { authorizeOrganisationBilling,type OrganisationBillingContext } from '../../services/billing-organisation-authority.service.js';
import { billingRegionView,setOrganisationBillingRegion } from '../../services/billing-organisation-region.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingFinancialSubjectRequestSchema,readBillingActorHeader } from './billing-request.js';
import { readBillingPresentation } from './billing-presentation.js';

const validator=new Ajv2020({allErrors:true,strict:true});ajvFormats.default.default(validator);
const capabilities=validator.compile(billingOrganisationCapabilitiesV1JsonSchema);
const overview=validator.compile(billingOrganisationOverviewV1JsonSchema);
const region=validator.compile(billingOrganisationFinancialV1Schemas.region_response);
const overviewRequest=BillingFinancialSubjectRequestSchema.extend({
  billing_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
const regionRequest=BillingFinancialSubjectRequestSchema.extend({region:z.enum(['US','UK','EUROPE']).optional()}).strict();
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
  ] as const;
  for(const [path,value] of assets)app.get(path,async(_request,reply)=>
    reply.header('Cache-Control','public, max-age=300').type('application/json').send(value));
  app.post(BILLING_ORGANISATION_CAPABILITIES_PATH,{preHandler:[requireBillingLifecycleAppKey]},async(request,reply)=>{
    const body=BillingFinancialSubjectRequestSchema.parse(request.body);
    const value=await organisationBillingCapabilities(context(request,body,BILLING_ORGANISATION_CAPABILITIES_PATH));
    contract(value,capabilities);return reply.header('Cache-Control','private, no-store').send(value);
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
