import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminService } from './admin-service';

const api = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  getBlob: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  put: vi.fn(),
  putForm: vi.fn(),
}));

vi.mock('./api-client', () => ({
  createApiClient: () => api,
}));

describe('adminService', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });

  it('sends team name and description updates through the admin team patch endpoint', async () => {
    api.patch.mockResolvedValue({ org: null, team: null });

    await adminService.updateTeam('org/1', 'team 1', {
      name: 'DeepWater research',
      description: 'Billing owner team',
      allowedEmailDomains: ['example.com'],
    });

    expect(api.patch).toHaveBeenCalledWith('/internal/admin/organisations/org%2F1/teams/team%201', {
      name: 'DeepWater research',
      description: 'Billing owner team',
      allowed_email_domains: ['example.com'],
    });
  });
});
