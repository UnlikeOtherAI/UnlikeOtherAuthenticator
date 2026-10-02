import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await createApp();
  app.get('/test/ingress', async (request) => ({ ip: request.ip, protocol: request.protocol }));
  await app.ready();
});
afterAll(async () => { await app.close(); });

it('ignores spoofed forwarding headers from a public direct peer', async () => {
  const response = await app.inject({
    method: 'GET', url: '/test/ingress', remoteAddress: '203.0.113.10',
    headers: { 'x-forwarded-for': '198.51.100.20', 'x-forwarded-proto': 'https' },
  });
  expect(response.json()).toEqual({ ip: '203.0.113.10', protocol: 'http' });
});

it.each(['127.0.0.1', '169.254.169.126'])('accepts the client appended by local ingress %s', async (remoteAddress) => {
  const response = await app.inject({
    method: 'GET', url: '/test/ingress', remoteAddress,
    headers: { 'x-forwarded-for': '192.0.2.99, 198.51.100.20', 'x-forwarded-proto': 'https' },
  });
  expect(response.json()).toEqual({ ip: '198.51.100.20', protocol: 'https' });
});
