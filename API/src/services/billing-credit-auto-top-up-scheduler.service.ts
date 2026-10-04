import { getEnv } from '../config/env.js';
import { runCreditAutoTopUpCycle } from './billing-credit-auto-top-up-runtime.service.js';
import type { CreditAutoTopUpCycleResult } from './billing-credit-auto-top-up-runtime.types.js';

export function startCreditAutoTopUpScheduler(params: {
  log: {
    info: (details: object, message: string) => void;
    error: (details: object, message: string) => void;
  };
  runCycle?: () => Promise<CreditAutoTopUpCycleResult>;
}): { stop: () => void } {
  const env = getEnv();
  let running = false;
  let stopped = false;
  let rerunRequested = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      const result = await (params.runCycle ?? runCreditAutoTopUpCycle)();
      const details = {
        attempted: result.attempted,
        submitted: result.submitted,
        awaitingWebhook: result.awaitingWebhook,
        recovered: result.recovered,
        terminal: result.terminal,
        skipped: result.skipped,
        failed: result.failed,
        failures: result.results.filter((item) => item.outcome === 'failed'),
        recoveryDiagnostics: result.results.flatMap((item) =>
          item.outcome === 'awaiting_webhook' && item.recoveryDiagnostic
            ? [item.recoveryDiagnostic]
            : [],
        ),
      };
      if (result.failed > 0) {
        params.log.error(details, 'Stripe credit auto-top-up cycle completed');
      } else {
        params.log.info(details, 'Stripe credit auto-top-up cycle completed');
      }
    } catch (error) {
      params.log.error({ err: error }, 'Stripe credit auto-top-up cycle failed');
    } finally {
      running = false;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        queueMicrotask(() => void run());
      }
    }
  };

  void run();
  const timer = setInterval(() => void run(), env.STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
