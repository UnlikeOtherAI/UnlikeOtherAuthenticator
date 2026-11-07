

import { describe } from 'vitest';

import { setupPersistenceSuite, enabled } from './billing-credit-manual-invoice-cap.suite-fixture.js';
import { registerCases1 } from './billing-credit-manual-invoice-cap.cases-1.js';
describe.skipIf(!enabled)('manual invoice paid receipt wallet cap', () => {
setupPersistenceSuite();
registerCases1();
});
