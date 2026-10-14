import { vi } from 'vitest';

// These utility suites must use injected stores. Fail immediately rather than
// allowing a missing fixture delegate to open a global database connection.
vi.mock('../src/db/prisma.js', () => ({
  getPrisma() { throw new Error('Server-free checks require an injected database'); },
  getAdminPrisma() { throw new Error('Server-free checks require an injected database'); },
}));
