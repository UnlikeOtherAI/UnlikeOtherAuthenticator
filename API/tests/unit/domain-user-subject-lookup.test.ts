import { describe, expect, it } from 'vitest';
import { getEnv } from '../../src/config/env.js';
import { listUsersForDomain } from '../../src/services/domain-users.service.js';

describe('domain user exact subject lookup', () => {
  it('requires both the source domain and the exact subject in the database query', async () => {
    let query: unknown;
    const users = await listUsersForDomain({ domain: 'api.example', userId: 'subject_1' }, {
      env: { ...getEnv(), DATABASE_URL: 'postgres://test.invalid/db' },
      prisma: { domainRole: { findMany: async (input: unknown) => { query = input; return []; } } },
    });
    expect(query).toMatchObject({ where: { domain: 'api.example', userId: 'subject_1' } });
    expect(users).toEqual([]);
  });
});
