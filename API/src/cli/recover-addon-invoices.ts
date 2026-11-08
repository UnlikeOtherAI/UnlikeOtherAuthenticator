import 'dotenv/config';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runAddonInvoiceRecoveryCycle } from '../services/billing-addon-invoice-recovery.service.js';
import { stripeRuntimeForAccount } from '../services/billing-stripe-client.service.js';

/** Reads Stripe only. --apply appends original verified DB invoice/cash sources
 * and cursor progress; it never charges, refunds or changes provider objects. */
export async function runAddonInvoiceRecoveryCommand(args:string[],deps:{prisma?:PrismaClient;now?:()=>Date}={}){
  const values=new Map<string,string>();
  for(let index=0;index<args.length;index++){
    const key=args[index]!;
    if(!['--mode','--account','--organisation','--max-cycles','--dry-run','--apply'].includes(key)||values.has(key))throw Error('INVALID_ARGUMENTS');
    if(key==='--dry-run'||key==='--apply')values.set(key,'true');
    else{const value=args[++index];if(!value||value.startsWith('--'))throw Error('INVALID_ARGUMENTS');values.set(key,value);}
  }
  const mode=values.get('--mode'),stripeAccountId=values.get('--account'),organisationId=values.get('--organisation');
  if(!['live','sandbox'].includes(mode??'')||!stripeAccountId||!organisationId||
    Number(values.has('--dry-run'))+Number(values.has('--apply'))!==1)throw Error('EXACT_MODE_ACCOUNT_ORGANISATION_AND_OPERATION_REQUIRED');
  const maximum=Number(values.get('--max-cycles')??'1');
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>25)throw Error('INVALID_MAX_CYCLES');
  const env=getEnv(),livemode=mode==='live';
  if((livemode?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID)!==stripeAccountId)throw Error('NAMED_STRIPE_ACCOUNT_REQUIRED');
  const db=deps.prisma??getAdminPrisma();
  try{
    const account=await db.billingStripeAccount.findUniqueOrThrow({where:{stripeAccountId_livemode:{stripeAccountId,livemode}}});
    await db.organisation.findUniqueOrThrow({where:{id:organisationId},select:{id:true}});
    const runtime=stripeRuntimeForAccount(account),verified=await runtime.client.accounts.retrieveCurrent();
    if(verified.id!==stripeAccountId||runtime.livemode!==livemode)throw Error('CAPTURED_STRIPE_ACCOUNT_MISMATCH');
    const rows=await db.$queryRaw<Array<{pending:bigint;complete:bigint;held:bigint;missing:bigint}>>(Prisma.sql`SELECT
      count(*) FILTER(WHERE NOT r.complete) AS pending,count(*) FILTER(WHERE r.complete) AS complete,
      count(*) FILTER(WHERE r.hold_reason IS NOT NULL AND NOT r.complete) AS held,
      count(*) FILTER(WHERE r.subscription_id IS NULL) AS missing FROM billing_recurring_addon_subscriptions s
      LEFT JOIN billing_addon_invoice_recoveries r ON r.subscription_id=s.id AND r.account_id=s.account_id AND r.org_id=s.org_id AND r.livemode=s.livemode
      WHERE s.org_id=${organisationId} AND s.account_id=${account.id} AND s.livemode=${livemode}`);
    if((rows[0]?.missing??0n)>0n)throw Error('CAPTURED_RECOVERY_SOURCE_MISSING');
    const result={mode,stripe_account_id:stripeAccountId,organisation_id:organisationId,dry_run:values.has('--dry-run'),
      inventory:rows[0],inventory_as_of:'before_operation',checked:0,invoices:0,completed:0,held:0};
    if(values.has('--apply'))for(let cycle=0;cycle<maximum;cycle++){
      const page=await runAddonInvoiceRecoveryCycle({prisma:db,now:deps.now,scope:{organisationId,accountId:account.id,livemode}});
      for(const key of ['checked','invoices','completed','held'] as const)result[key]+=page[key];
      if(!page.checked||page.held)break;
    }
    return result;
  }finally{if(!deps.prisma)await db.$disconnect();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  void runAddonInvoiceRecoveryCommand(process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value)+'\n');
    if(result.held)process.exitCode=2;
  }).catch(()=>{process.stderr.write('ADDON_INVOICE_RECOVERY_REFUSED\n');process.exitCode=1;});
}
