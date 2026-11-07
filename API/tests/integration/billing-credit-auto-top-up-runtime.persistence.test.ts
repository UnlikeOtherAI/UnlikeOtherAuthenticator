

import { describe } from 'vitest';

import { setupPersistenceSuite, databaseTestsEnabled } from './billing-credit-auto-top-up-runtime.suite-fixture.js';
import { registerCases1 } from './billing-credit-auto-top-up-runtime.cases-1.js';
import { registerCases2 } from './billing-credit-auto-top-up-runtime.cases-2.js';
import { registerCases3 } from './billing-credit-auto-top-up-runtime.cases-3.js';
describe.skipIf(!databaseTestsEnabled)('credit automatic top-up PostgreSQL runtime', () => {
setupPersistenceSuite();
registerCases1();
registerCases2();
registerCases3();
});
