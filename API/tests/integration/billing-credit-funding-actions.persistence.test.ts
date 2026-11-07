
import { describe } from 'vitest';

import { databaseTestsEnabled } from './billing-credit-funding-actions.persistence.fixture.js';
import { setupPersistenceSuite } from './billing-credit-funding-actions.suite-fixture.js';
import { registerCases1 } from './billing-credit-funding-actions.cases-1.js';
import { registerCases2 } from './billing-credit-funding-actions.cases-2.js';
describe.skipIf(!databaseTestsEnabled)('credit funding PostgreSQL lifecycle races', () => {
setupPersistenceSuite();
registerCases1();
registerCases2();
});
