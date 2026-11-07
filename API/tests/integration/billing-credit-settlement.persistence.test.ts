

import { describe } from 'vitest';

import { setupPersistenceSuite, databaseTestsEnabled } from './billing-credit-settlement.suite-fixture.js';
import { registerCases1 } from './billing-credit-settlement.cases-1.js';
import { registerCases2 } from './billing-credit-settlement.cases-2.js';
import { registerCases3 } from './billing-credit-settlement.cases-3.js';
describe.skipIf(!databaseTestsEnabled)('credit settlement persistence', () => {
setupPersistenceSuite();
registerCases1();
registerCases2();
registerCases3();
});
