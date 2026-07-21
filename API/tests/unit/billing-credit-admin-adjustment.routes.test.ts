import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const services = vi.hoisted(() => ({
  createAdminCreditAdjustment: vi.fn(),
  previewAdminCreditAdjustment: vi.fn(),
  listAdminCreditAccounts: vi.fn(),
}));

vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (
    request: {
      headers: { authorization?: string };
      adminAccessTokenClaims?: { userId: string; email: string };
    },
    reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    request.adminAccessTokenClaims = { userId: 'admin_1', email: 'admin@example.com' };
  },
}));

vi.mock('../../src/services/billing-credit-admin-adjustment.service.js', () => services);
vi.mock('../../src/services/billing-credit-admin-account.service.js', () => services);

const amount = {
  credits: '10',
  display: '10 credits',
  usd_equivalent: { amount: '0.01', currency: 'USD', display: 'US$0.01' },
};
const adjustment = {
  id: 'bca_1',
  signed_credits: amount,
  reason: 'Restore test balance',
  idempotency_key: 'restore.test-1',
  created_by: {
    user_id: 'admin_1',
    email: 'admin@example.com',
    admin_domain: 'admin.example.com',
  },
  created_at: '2026-07-21T12:00:00.000Z',
};
const account = {
  id: 'credit_1',
  organisation: { id: 'org_1', name: 'Acme' },
  team: { id: 'team_1', name: 'Research' },
  mode: 'test',
  remaining_credits: amount,
  updated_at: '2026-07-21T12:00:00.000Z',
  recent_adjustments: [adjustment],
};
const confirmationToken = 'confirmation-token-at-least-thirty-two-characters';
const preview = {
  account,
  current_credits: amount,
  signed_credits: amount,
  resulting_credits: {
    credits: '20',
    display: '20 credits',
    usd_equivalent: { amount: '0.02', currency: 'USD', display: 'US$0.02' },
  },
  reason: adjustment.reason,
  idempotency_key: adjustment.idempotency_key,
  automatic_top_up: {
    generation: 0,
    state: 'disabled',
    threshold_credits: null,
    refill_credits: null,
    consequence: {
      code: 'not_active',
      message: 'Automatic top-up is not active.',
    },
  },
  expires_at: '2026-07-21T12:02:00.000Z',
  confirmation_token: confirmationToken,
};

describe('superuser credit adjustment routes', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    services.listAdminCreditAccounts.mockResolvedValue({
      accounts: [account],
      next_cursor: 'next-page',
      has_more: true,
    });
    services.previewAdminCreditAdjustment.mockResolvedValue(preview);
    services.createAdminCreditAdjustment.mockResolvedValue({
      account,
      adjustment,
      replayed: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSharedSecret;
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('requires a platform superuser before exposing team balances', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/billing/credit-accounts',
      });
      expect(response.statusCode).toBe(401);
      expect(services.listAdminCreditAccounts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('lists display-only account balances with exact filters and no-store', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/billing/credit-accounts?organisation_id=org_1&team_id=team_1&search=Research&cursor=cursor-1&limit=25',
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({
        accounts: [account],
        next_cursor: 'next-page',
        has_more: true,
      });
      expect(services.listAdminCreditAccounts).toHaveBeenCalledWith({
        organisationId: 'org_1',
        teamId: 'team_1',
        search: 'Research',
        cursor: 'cursor-1',
        limit: 25,
      });
      expect(response.body).not.toContain('microcredits');
      expect(response.body).not.toContain('stripe');
    } finally {
      await app.close();
    }
  });

  it('creates a display-safe server confirmation preview with the authenticated actor', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/credit-accounts/credit_1/adjustment-preview',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          organisation_id: 'org_1',
          team_id: 'team_1',
          signed_credits: '10',
          reason: 'Restore test balance',
          idempotency_key: 'restore.test-1',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('microcredits');
      expect(response.body).not.toContain('stripe');
      expect(services.previewAdminCreditAdjustment).toHaveBeenCalledWith({
        creditAccountId: 'credit_1',
        organisationId: 'org_1',
        teamId: 'team_1',
        signedCredits: '10',
        reason: 'Restore test balance',
        idempotencyKey: 'restore.test-1',
        actor: { userId: 'admin_1', email: 'admin@example.com' },
      });
    } finally {
      await app.close();
    }
  });

  it('posts only the server-authored confirmation token', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/credit-accounts/credit_1/adjustments',
        headers: { authorization: 'Bearer admin-token' },
        payload: { confirmation_token: confirmationToken },
      });
      expect(response.statusCode).toBe(201);
      expect(services.createAdminCreditAdjustment).toHaveBeenCalledWith({
        creditAccountId: 'credit_1',
        confirmationToken,
        actor: { userId: 'admin_1', email: 'admin@example.com' },
      });
    } finally {
      await app.close();
    }
  });

  it('returns 200 for an idempotent replay', async () => {
    services.createAdminCreditAdjustment.mockResolvedValue({
      account,
      adjustment,
      replayed: true,
    });
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/credit-accounts/credit_1/adjustments',
        headers: { authorization: 'Bearer admin-token' },
        payload: { confirmation_token: confirmationToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().replayed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown mutation fields before the service', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/credit-accounts/credit_1/adjustments',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          confirmation_token: confirmationToken,
          signed_credits: '10',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(services.createAdminCreditAdjustment).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
