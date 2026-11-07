

import { describe } from 'vitest';

import { setupPersistenceSuite, enabled } from './billing-prepaid-reservation.suite-fixture.js';
import { registerCases1 } from './billing-prepaid-reservation.cases-1.js';
import { registerCases2 } from './billing-prepaid-reservation.cases-2.js';
import { registerCases3 } from './billing-prepaid-reservation.cases-3.js';
describe.skipIf(!enabled)('prepaid dispatch liability in PostgreSQL', () => {
setupPersistenceSuite();
registerCases1();
registerCases2();
registerCases3();
});
