import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { deliverDirectoryWebhooks, parseDirectoryWebhookTargets, signDirectoryWebhook } from '../../src/services/directory-webhook.service.js';
import type { PrismaClient } from '@prisma/client';

const secret = 'test-only-directory-secret-long-enough';
const target = { domain: 'app.example.com', url: 'https://api.example.com/hooks/uoa', secret };
describe('directory webhooks', () => {
  it('requires explicit HTTPS targets, dedicated secrets and one destination per domain', () => {
    expect(parseDirectoryWebhookTargets(undefined)).toEqual([]);
    expect(() => parseDirectoryWebhookTargets(JSON.stringify([{ ...target, url: 'http://example.com' }]))).toThrow();
    expect(() => parseDirectoryWebhookTargets(JSON.stringify([target, target]))).toThrow();
    expect(() => parseDirectoryWebhookTargets(JSON.stringify([{ ...target, secret: 'short' }]))).toThrow();
  });
  it('binds timestamp and every payload byte', () => {
    expect(signDirectoryWebhook('{"subject":"a"}', '1000', secret))
      .toBe(createHmac('sha256', secret).update('1000.{"subject":"a"}').digest('hex'));
    expect(signDirectoryWebhook('{"subject":"b"}', '1000', secret))
      .not.toBe(signDirectoryWebhook('{"subject":"a"}', '1000', secret));
  });
  it('delivers reference-only events and acknowledges only successful HTTP responses', async () => {
    const row = { id: 'id', domain: target.domain, org_id: 'org', team_id: 'team', subject: 'subject', created_at: new Date(0) };
    const execute = vi.fn().mockResolvedValue(1);
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([row]), $executeRaw: execute } as unknown as PrismaClient;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await deliverDirectoryWebhooks({ targets: [target], prisma, fetch: transport })).toBe(1);
    const init = transport.mock.calls[0]?.[1];
    expect(JSON.parse(init?.body as string)).toEqual({ id: 'id', type: 'person.changed', version: 1,
      occurredAt: new Date(0).toISOString(), domain: target.domain, organizationId: 'org', teamId: 'team', subject: 'subject' });
    expect(init?.redirect).toBe('error');
    expect(execute.mock.calls[0]?.[0].join('')).toContain('delivered_at=now()');
    execute.mockClear();
    transport.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await deliverDirectoryWebhooks({ targets: [target], prisma, fetch: transport })).toBe(0);
    expect(execute.mock.calls[0]?.[0].join('')).toContain('next_attempt_at=now()');
  });
});
