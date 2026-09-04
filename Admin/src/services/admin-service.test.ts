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

  it('deletes an organisation through the encoded admin path', async () => {
    api.delete.mockResolvedValue({ deleted: true });

    await expect(adminService.deleteOrganisation('org/1')).resolves.toEqual({ deleted: true });

    expect(api.delete).toHaveBeenCalledWith('/internal/admin/organisations/org%2F1');
  });

  it('keeps automatic membership controls behind UOA admin routes and encodes scope', async () => {
    api.get.mockResolvedValue({ rules: [] });
    api.post.mockResolvedValue({ rules: [] });

    await adminService.getAutomaticMembership('org/1', 'team', 'team 1');
    await adminService.controlAutomaticMembership('org/1', 'organisation', 'verify', { rule_id: 'rule-1' });

    expect(api.get).toHaveBeenCalledWith('/internal/admin/organisations/org%2F1/teams/team%201/automatic-membership');
    expect(api.post).toHaveBeenCalledWith('/internal/admin/organisations/org%2F1/automatic-membership', {
      action: 'verify', payload: { rule_id: 'rule-1' },
    });
  });

  it('fetches the admin user avatar as image bytes from the encoded user path', async () => {
    const bytes = new Blob(['<svg />'], { type: 'image/svg+xml' });
    api.getBlob.mockResolvedValue(bytes);

    await expect(adminService.getUserAvatar('user/1')).resolves.toBe(bytes);

    expect(api.getBlob).toHaveBeenCalledWith('/internal/admin/users/user%2F1/avatar', undefined, 'image/*');
  });

  it('uploads a user avatar as a single multipart part named file', async () => {
    api.putForm.mockResolvedValue({ ok: true });
    const file = new File(['png'], 'face.png', { type: 'image/png' });

    await adminService.uploadUserAvatar('user/1', file);

    const [path, form] = api.putForm.mock.calls[0] as [string, FormData];
    expect(path).toBe('/internal/admin/users/user%2F1/avatar');
    expect([...form.keys()]).toEqual(['file']);
    expect(form.get('file')).toBe(file);
  });

  it('deletes a user avatar through the encoded user path', async () => {
    api.delete.mockResolvedValue({ ok: true });

    await adminService.deleteUserAvatar('user/1');

    expect(api.delete).toHaveBeenCalledWith('/internal/admin/users/user%2F1/avatar');
  });

  it('fetches the admin team avatar as image bytes from the encoded team path', async () => {
    const bytes = new Blob(['png'], { type: 'image/png' });
    api.getBlob.mockResolvedValue(bytes);

    await expect(adminService.getTeamAvatar('team/1')).resolves.toBe(bytes);

    expect(api.getBlob).toHaveBeenCalledWith('/internal/admin/teams/team%2F1/avatar', undefined, 'image/*');
  });

  it('uploads a team avatar as a single multipart part named file', async () => {
    api.putForm.mockResolvedValue({ ok: true });
    const file = new File(['png'], 'logo.png', { type: 'image/png' });

    await adminService.uploadTeamAvatar('team/1', file);

    const [path, form] = api.putForm.mock.calls[0] as [string, FormData];
    expect(path).toBe('/internal/admin/teams/team%2F1/avatar');
    expect([...form.keys()]).toEqual(['file']);
    expect(form.get('file')).toBe(file);
  });

  it('deletes a team avatar through the encoded team path', async () => {
    api.delete.mockResolvedValue({ ok: true });

    await adminService.deleteTeamAvatar('team/1');

    expect(api.delete).toHaveBeenCalledWith('/internal/admin/teams/team%2F1/avatar');
  });
});
