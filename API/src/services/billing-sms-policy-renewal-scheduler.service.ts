import { emailSmsPolicyAlert } from './billing-sms-policy-alert.service.js';
import { runSmsPolicyRenewalCycle, type SmsPolicyRenewalResult } from './billing-sms-policy-renewal.service.js';

const INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Daily, plus once at startup. Every step is idempotent across instances: FX
 * acceptance dedupes by source digest, route renewal rechecks coverage under a
 * per-route lock, and an alert opens (and emails) once per condition.
 */
export function startSmsPolicyRenewalScheduler(params: {
  log: { info: (details: object, message: string) => void;
    error: (details: object, message: string) => void };
  runCycle?: () => Promise<SmsPolicyRenewalResult>;
}): { stop: () => void } {
  let running = false;
  const cycle = params.runCycle ?? (() => runSmsPolicyRenewalCycle({
    notify: (condition) => emailSmsPolicyAlert(condition, params.log),
  }));
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cycle();
      const failed = result.fx === 'alerted' || result.routes === 'provider_unavailable' || result.routes.alerted > 0;
      params.log[failed ? 'error' : 'info'](result, 'SMS policy renewal cycle');
    } catch (error) {
      params.log.error({ err: error }, 'SMS policy renewal cycle failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
