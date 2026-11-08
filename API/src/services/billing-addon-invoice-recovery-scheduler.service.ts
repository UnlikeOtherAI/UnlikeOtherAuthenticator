import { AppError } from '../utils/errors.js';
import { runAddonInvoiceRecoveryCycle } from './billing-addon-invoice-recovery.service.js';

/** Provider reads and original-source evidence can recover independently of
 * the flag admitting new collection. Each tick has one bounded work item. */
export function startAddonInvoiceRecoveryScheduler(params:{log:{info(details:object,message:string):void;
  error(details:object,message:string):void};runCycle?:typeof runAddonInvoiceRecoveryCycle}) {
  let running=false;
  const run=async()=>{
    if(running)return;running=true;
    try{params.log.info(await (params.runCycle??runAddonInvoiceRecoveryCycle)(),'Add-on invoice source recovery');}
    catch(error){params.log.error({code:error instanceof AppError&&/^[A-Z][A-Z0-9_]{1,159}$/.test(error.message)?
      error.message:'BILLING_ADDON_INVOICE_RECOVERY_UNAVAILABLE'},'Add-on invoice source recovery deferred');}
    finally{running=false;}
  };
  void run();const timer=setInterval(()=>{void run();},5*60_000);timer.unref();
  return {stop:()=>clearInterval(timer)};
}
