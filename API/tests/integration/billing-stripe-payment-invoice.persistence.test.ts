import { registerModeHistoryCase } from './billing-stripe-payment-invoice.cases-mode.js';


import { describe, vi } from 'vitest';
vi.mock('../../src/services/billing-actor.service.js', () => ({ verifyBillingActor: vi.fn().mockResolvedValue({}) }));

import { setupPersistenceSuite } from './billing-stripe-payment-invoice.suite-fixture.js';
import { registerCases1 } from './billing-stripe-payment-invoice.cases-1.js';
import { registerCases2 } from './billing-stripe-payment-invoice.cases-2.js';
describe.skipIf(!process.env.DATABASE_URL)('regular Stripe payment legal source', () => {
setupPersistenceSuite();
registerCases1();
registerCases2();
registerModeHistoryCase();
});
