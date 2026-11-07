
import { afterAll, beforeAll } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { seedFundingRace } from './billing-credit-funding-actions.persistence.fixture.js';
export let handle: Awaited<ReturnType<typeof createTestDb>>;
export function setupPersistenceSuite() {
beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedFundingRace(handle.prisma);
  });
afterAll(async () => {
    if (handle) await handle.cleanup();
  });
}
